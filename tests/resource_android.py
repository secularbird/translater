"""Profile the installed resident-mode APK with actual models and paced WAV input.

Restarts this app; model cache is retained. CPU 100% means one logical core.
Memory sampling is periodic: reported maxima are sampled, not guaranteed peaks.
"""
import argparse
import base64
import json
import os
import re
import statistics
import subprocess
import threading
import time
import wave
from playwright.sync_api import sync_playwright, expect
from android_smoke import locate_adb
from reporting import ROOT, OUTPUT


def memory_rows(text):
    rows = []
    for line in text.splitlines():
        match = re.match(r'^\s*([A-Za-z.][\w .()-]*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+\d+){0,3}\s*$', line)
        if match and match[1].strip() != 'TOTAL':
            rows.append([int(match[i]) for i in range(2, 7)])
    if not rows:
        raise ValueError('No memory categories in dumpsys output: ' + text[:300])
    # Android 17's summary TOTAL PSS includes swap. Sum category PSS instead.
    return {'pssKiB': sum(row[0] for row in rows), 'swapPssKiB': sum(row[3] for row in rows), 'rssKiB': sum(row[4] for row in rows)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serial', default='emulator-5554')
    parser.add_argument('--cycles', type=int, default=3)
    parser.add_argument('--low-memory', action='store_true')
    args = parser.parse_args()
    adb_path = locate_adb()
    def adb(*command):
        return subprocess.check_output([adb_path, '-s', args.serial, *command], text=True, timeout=30).strip()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    report = {'passed': False, 'mode': 'low-memory' if args.low_memory else 'resident', 'method': 'Production UI with real-time PCM substituted at VAD Worker input; actual Silero/SenseVoice/M2M100', 'memory': [], 'cpu': [], 'phases': [], 'errors': []}
    phase = ['setup']
    stop = threading.Event()
    def mark(name):
        phase[0] = name
        report['phases'].append({'name': name, 'timestamp': time.time()})
        print('Phase:', name, flush=True)
    report['hostLoadAverage'] = os.getloadavg()
    report['deviceMemory'] = adb('shell', 'cat', '/proc/meminfo')
    report['deviceCores'] = int(adb('shell', 'getconf', '_NPROCESSORS_ONLN'))
    report['androidVersion'] = adb('shell', 'getprop', 'ro.build.version.release')
    adb('shell', 'am', 'force-stop', 'com.sonora.translate')
    adb('shell', 'pm', 'grant', 'com.sonora.translate', 'android.permission.RECORD_AUDIO')
    adb('shell', 'am', 'start', '-W', '-n', 'com.sonora.translate/.MainActivity')
    pid = adb('shell', 'pidof', 'com.sonora.translate')
    port = adb('forward', 'tcp:0', f'localabstract:webview_devtools_remote_{pid}')
    sampler = cpu_thread = None
    top = None
    saved = None
    try:
        with sync_playwright() as p:
            for attempt in range(20):
                try:
                    browser = p.chromium.connect_over_cdp(f'ws://127.0.0.1:{port}/devtools/browser', timeout=5000)
                    break
                except Exception:
                    if attempt == 19: raise
                    time.sleep(0.5)
            page = browser.contexts[0].pages[0]
            expect(page.get_by_role('button', name='模型设置', exact=True)).to_be_visible(timeout=30000)
            saved = page.evaluate("localStorage.getItem('sonora.settings.v1')")
            page.get_by_role('button', name='模型设置', exact=True).click()
            page.get_by_role('button', name='设备离线', exact=True).click()
            expect(page.locator('.offline-model-row').nth(0)).to_contain_text('已下载', timeout=30000)
            expect(page.locator('.offline-model-row').nth(1)).to_contain_text('已下载')
            page.get_by_label('低内存模式', exact=False).set_checked(args.low_memory)
            page.get_by_role('button', name='保存设置', exact=True).click()
            page.locator('#source-language').select_option('auto')
            page.locator('#target-language').select_option('zh')
            rows = adb('shell', 'ps', '-A', '-o', 'PID,NAME').splitlines()
            pids = [row.split()[0] for row in rows if 'com.sonora.translate' in row]
            assert len(pids) == 2, rows
            report['pids'] = pids

            def sample_memory():
                while not stop.is_set():
                    started, label = time.time(), phase[0]
                    try:
                        processes = {pid: memory_rows(adb('shell', 'dumpsys', 'meminfo', pid)) for pid in pids}
                        totals = {key: sum(value[key] for value in processes.values()) for key in ['pssKiB', 'rssKiB', 'swapPssKiB']}
                        totals['footprintKiB'] = totals['pssKiB'] + totals['swapPssKiB']
                        report['memory'].append({'timestamp': started, 'phase': label, 'endPhase': phase[0], 'sampleSeconds': time.time()-started, **totals, 'processes': processes})
                    except Exception as error:
                        report['errors'].append(str(error))
                    stop.wait(0.4)

            top = subprocess.Popen([adb_path, '-s', args.serial, 'shell', 'top', '-b', '-d', '1', '-p', ','.join(pids), '-o', 'PID,%CPU,RES,NAME'], stdout=subprocess.PIPE, text=True)
            def sample_cpu():
                block, seen = [], 0
                header_time = previous_header = time.time()
                header_phase = phase[0]
                for line in top.stdout:
                    if stop.is_set(): break
                    if line.startswith('Tasks:'):
                        if block and seen > 1:
                            report['cpu'].append({'timestamp': header_time, 'intervalStart': previous_header, 'phase': header_phase, 'percentOneCore': sum(block)})
                        seen += 1; block = []
                        previous_header, header_time = header_time, time.time()
                        header_phase = phase[0]
                    match = re.match(r'\s*(\d+)\s+([\d.]+)\s+', line)
                    if match and match[1] in pids: block.append(float(match[2]))
            sampler = threading.Thread(target=sample_memory, daemon=True)
            cpu_thread = threading.Thread(target=sample_cpu, daemon=True)
            sampler.start(); cpu_thread.start()
            page.on('console', lambda message: mark(message.text.split('=', 1)[1]) if message.text.startswith('RESOURCE_PHASE=') else None)
            with wave.open(str(ROOT / 'tests/fixtures/speech-en.wav'), 'rb') as wav:
                assert (wav.getframerate(), wav.getsampwidth(), wav.getnchannels()) == (16000, 2, 1)
                pcm = base64.b64encode(wav.readframes(wav.getnframes())).decode()
            report['input'] = page.evaluate((ROOT / 'tests/resource_workload.js').read_text(), {'pcm': pcm})
            mark('cold-idle'); page.wait_for_timeout(8000)
            mark('starting')
            started = time.monotonic()
            page.get_by_role('button', name='开始翻译', exact=True).click()
            expect(page.get_by_role('button', name='结束录音', exact=True)).to_be_visible(timeout=180000)
            report['coldStartSeconds'] = time.monotonic() - started
            page.wait_for_timeout(8000)
            assert page.evaluate('resourceTest.audioSamples') > 16000, 'Native capture delivered no audio frames'
            for cycle in range(1, args.cycles + 1):
                started = time.monotonic()
                page.evaluate('resourceTest.play()')
                page.wait_for_function('(cycle) => resourceTest.errors.length || resourceTest.results.some(r => r.cycle === cycle && r.action === "translation")', arg=cycle, timeout=180000)
                errors = page.evaluate('resourceTest.errors')
                assert not errors, errors
                report.setdefault('cycleSeconds', []).append(time.monotonic() - started)
                page.wait_for_timeout(3000)
            expect(page.locator('.original .transcript-text')).to_contain_text('tribal')
            report['source'] = page.locator('.original .transcript-text').inner_text()
            report['translation'] = page.locator('.translated .transcript-text').inner_text()
            assert any('\u4e00' <= char <= '\u9fff' for char in report['translation'])
            report['workerResults'] = page.evaluate('resourceTest.results')
            report['workerEvents'] = page.evaluate('resourceTest.events')
            page.get_by_role('button', name='结束录音', exact=True).click()
            expect(page.get_by_role('button', name='开始翻译', exact=True)).to_be_enabled(timeout=30000)
            mark('resident-idle'); page.wait_for_timeout(15000)
            started = time.monotonic()
            page.get_by_role('button', name='开始翻译', exact=True).click()
            expect(page.get_by_role('button', name='结束录音', exact=True)).to_be_visible(timeout=60000)
            report['warmStartSeconds'] = time.monotonic()-started
            mark('warm-vad-listening'); page.wait_for_timeout(8000)
            page.get_by_role('button', name='结束录音', exact=True).click()
            expect(page.get_by_role('button', name='开始翻译', exact=True)).to_be_enabled(timeout=30000)
            page.get_by_role('button', name='模型设置', exact=True).click()
            counts = page.locator('.cache-summary').filter(has_text='加载次数')
            expected_counts = f'识别 {args.cycles + 1} / 翻译 {args.cycles}' if args.low_memory else '识别 1 / 翻译 1'
            expect(counts).to_contain_text(expected_counts)
            report['loadCounts'] = counts.inner_text()
            page.get_by_role('button', name='释放模型内存', exact=True).click()
            page.get_by_role('button', name='关闭设置', exact=True).click()
            mark('released'); page.wait_for_timeout(15000)
            # Isolate the VAD runtime after releasing both large model workers.
            page.evaluate('''async () => {
              const worker = new Worker(resourceTest.vadUrl, {type:'module'});
              await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => { worker.terminate(); reject(new Error('VAD-only timeout')); }, 30000);
                worker.addEventListener('message', ({data}) => {
                  if (data.type === 'ready') { clearTimeout(timeout); resolve(); }
                  if (data.type === 'error') { clearTimeout(timeout); worker.terminate(); reject(new Error(data.message)); }
                });
                worker.postMessage({action:'init', origin:location.origin, silenceSeconds:0.8});
              });
              console.log('RESOURCE_PHASE=vad-only');
              const timer = setInterval(() => worker.postMessage({action:'audio',samples:new Float32Array(512)}), 32);
              await new Promise(resolve => setTimeout(resolve, 8000));
              clearInterval(timer); worker.terminate();
            }''')
            mark('released-after-vad'); page.wait_for_timeout(5000)
            report['passed'] = not report['errors']
            # Remove input substitution and restore the user's saved preferences.
            page.evaluate('(saved) => { if (saved === null) localStorage.removeItem("sonora.settings.v1"); else localStorage.setItem("sonora.settings.v1", saved); }', saved)
            page.reload()
            browser.close()
    except Exception as error:
        report['errors'].append(str(error))
        # Ensure an aborted profiling run cannot leave the microphone running.
        adb('shell', 'am', 'force-stop', 'com.sonora.translate')
        raise
    finally:
        stop.set()
        if top: top.terminate()
        if sampler: sampler.join(timeout=35)
        if cpu_thread: cpu_thread.join(timeout=5)
        adb('forward', '--remove', f'tcp:{port}')
        groups = {}
        for sample in report['memory']:
            groups.setdefault(sample['phase'], []).append(sample)
        report['summary'] = {name: {'samples': len(samples), **{key: {'peakMiB': round(max(s[key] for s in samples)/1024, 1), 'medianMiB': round(statistics.median(s[key] for s in samples)/1024, 1)} for key in ['pssKiB', 'rssKiB', 'swapPssKiB', 'footprintKiB']}} for name, samples in groups.items()}
        # Exclude CPU intervals crossing phase boundaries. top percentages refer
        # to the interval ending at its header, not when the next header arrives.
        for sample in report['cpu']:
            sample['crossesPhase'] = any(sample['intervalStart'] < event['timestamp'] <= sample['timestamp'] for event in report['phases'])
        report['cpuSummary'] = {name: {'samples': len(values), 'peakPercentOneCore': max(values), 'meanPercentOneCore': round(statistics.mean(values), 1)} for name in {s['phase'] for s in report['cpu']} if (values := [s['percentOneCore'] for s in report['cpu'] if s['phase'] == name and not s['crossesPhase']])}
        (OUTPUT / f"resources-android-{report['mode']}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({key: report.get(key) for key in ['passed', 'coldStartSeconds', 'warmStartSeconds', 'cycleSeconds', 'summary', 'cpuSummary', 'errors']}, ensure_ascii=False, indent=2), flush=True)


if __name__ == '__main__':
    main()
