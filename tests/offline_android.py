"""Provision real models via a temporary static mirror and test the installed WASM APK.

Requires a debug APK (WebView debugging enabled), model files, and emulator-5554.
The mirror serves bytes only. It is shut down before the inference assertions.
"""
import argparse
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import subprocess
import threading
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from android_smoke import locate_adb
from reporting import ROOT, OUTPUT


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serial', default='emulator-5554')
    parser.add_argument('--resident', action='store_true', help='Benchmark warm models and select resident mode in settings')
    parser.add_argument('--resident-ui', action='store_true', help='Only verify app warmup/reuse and leave its models resident')
    args = parser.parse_args()
    adb_path = locate_adb()
    def adb(*command):
        return subprocess.check_output([adb_path, '-s', args.serial, *command], text=True).strip()
    assets_root = ROOT / '.model-cache/offline-assets'
    manifest = json.loads((ROOT / 'src/offline/assets.json').read_text())
    allowed = {asset['id']: asset for asset in manifest}
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass
        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Headers', 'range')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.end_headers()
        def do_GET(self):
            name = self.path.lstrip('/').split('?')[0]
            if name not in allowed:
                self.send_error(404)
                return
            path = assets_root / name
            size = path.stat().st_size
            start = int(self.headers.get('Range', 'bytes=0-').split('=')[1].split('-')[0])
            self.send_response(206 if start else 200)
            self.send_header('Content-Length', str(size - start))
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Access-Control-Expose-Headers', 'content-range, content-length')
            if start:
                self.send_header('Content-Range', f'bytes {start}-{size-1}/{size}')
            self.end_headers()
            requests.append(name)
            try:
                with path.open('rb') as file:
                    file.seek(start)
                    while data := file.read(256 * 1024):
                        self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_port
    adb('reverse', f'tcp:{port}', f'tcp:{port}')
    adb('shell', 'am', 'force-stop', 'com.sonora.translate')
    adb('shell', 'am', 'start', '-W', '-n', 'com.sonora.translate/.MainActivity')
    pid = adb('shell', 'pidof', 'com.sonora.translate')
    devtools = int(adb('forward', 'tcp:0', f'localabstract:webview_devtools_remote_{pid}'))
    OUTPUT.mkdir(parents=True, exist_ok=True)
    results = []
    try:
        with sync_playwright() as p:
            browser = None
            for _ in range(20):
                try:
                    browser = p.chromium.connect_over_cdp(f'ws://127.0.0.1:{devtools}/devtools/browser')
                    break
                except Exception as error:
                    print(f'DevTools connection: {error}', flush=True)
                    time.sleep(0.5)
            assert browser is not None, 'Unable to connect to Android WebView DevTools'
            page = browser.contexts[0].pages[0]
            page.on('console', lambda message: print(f'Android {message.type}: {message.text}', flush=True) if message.type in ['error', 'warning'] else None)
            page.get_by_role('button', name='模型设置', exact=True).click()
            page.get_by_role('button', name='设备离线', exact=True).click()
            rows = page.locator('.offline-model-row')
            if '未下载' in rows.nth(0).inner_text() or '未下载' in rows.nth(1).inner_text():
                page.get_by_text('下载与文件说明', exact=True).click()
                page.get_by_label('静态模型镜像地址（可选）').fill(f'http://127.0.0.1:{port}')
                page.get_by_role('button', name='下载离线模型', exact=True).or_(page.get_by_role('button', name='继续下载模型', exact=True)).click()
                expect(rows.nth(1)).to_contain_text('已下载', timeout=300000)
                expect(rows.nth(0)).to_contain_text('已下载', timeout=300000)
            # The persisted mirror must not point to a temporary test server.
            if not page.locator('.offline-details').get_attribute('open'):
                page.locator('.offline-details').evaluate('element => element.open = true')
            page.get_by_label('静态模型镜像地址（可选）').fill('')
            if args.resident or args.resident_ui:
                page.get_by_label('低内存模式', exact=False).uncheck()
            page.get_by_role('button', name='保存设置', exact=True).click()
            server.shutdown(); server.server_close()
            adb('reverse', '--remove', f'tcp:{port}')
            # Verify the production ASR worker (same code as microphone jobs).
            worker_file = next((ROOT / 'dist/assets').glob('inference.worker-*.js')).name
            vad_file = next((ROOT / 'dist/assets').glob('vad.worker-*.js')).name
            wav = base64.b64encode((ROOT / '.model-cache/samples/zh.wav').read_bytes()).decode()
            if args.resident or args.resident_ui:
                result = {'passed': True}
                if not args.resident_ui:
                    benchmark = (ROOT / 'tests/residency_benchmark.js').read_text()
                    result = page.evaluate(benchmark, {'inference': '/assets/' + worker_file, 'wav': wav})
                    assert result['passed'] and result['loadCounts'] == {'asr': 1, 'translation': 1}
                # Exercise the app's own client pool, not just isolated workers.
                adb('shell', 'pm', 'grant', 'com.sonora.translate', 'android.permission.RECORD_AUDIO')
                ui_starts = []
                for _ in range(2):
                    started = time.monotonic()
                    page.get_by_role('button', name='开始翻译', exact=True).click()
                    expect(page.get_by_role('button', name='结束录音', exact=True)).to_be_visible(timeout=180000)
                    ui_starts.append(round((time.monotonic() - started) * 1000, 1))
                    page.get_by_role('button', name='结束录音', exact=True).click()
                    expect(page.get_by_role('button', name='开始翻译', exact=True)).to_be_enabled(timeout=180000)
                    expect(page.locator('.offline-indicator')).to_contain_text('双模型已常驻')
                page.get_by_role('button', name='模型设置', exact=True).click()
                counts = page.locator('.cache-summary').filter(has_text='加载次数')
                expect(counts).to_contain_text('识别 1 / 翻译 1')
                result['uiStartMilliseconds'] = ui_starts
                result['uiLoadCounts'] = counts.inner_text()
                expect(page.get_by_label('低内存模式', exact=False)).not_to_be_checked()
                page.get_by_role('button', name='关闭设置', exact=True).click()
                page.screenshot(path=str(OUTPUT / 'residency-android.png'), full_page=True)
                report = 'residency-android-ui.json' if args.resident_ui else 'residency-android.json'
                (OUTPUT / report).write_text(json.dumps(result, ensure_ascii=False, indent=2))
                print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
                browser.close()
                return
            start = time.monotonic()
            result = page.evaluate("""async ({file, vadFile, wav}) => {
              const bytes = Uint8Array.from(atob(wav), c => c.charCodeAt(0));
              const view = new DataView(bytes.buffer);
              const input = Float32Array.from({length: (bytes.length-44)/2}, (_,i) => view.getInt16(44+i*2,true)/32768);
              const detect = __SONORA_VAD_CHECK__;
              const {samples, seconds} = await detect({file: '/assets/'+vadFile, samples: input, origin: location.origin});
              const worker = new Worker('/assets/'+file, {type:'module'});
              return await new Promise((resolve,reject) => {
                const timer = setTimeout(() => {worker.terminate(); reject(new Error('ASR timeout'));},180000);
                worker.onerror = e => {clearTimeout(timer);worker.terminate();reject(new Error(e.message));};
                worker.onmessage = e => {
                  if(e.data.progress || e.data.ready) return;
                  clearTimeout(timer);worker.terminate();
                  if(e.data.error) reject(new Error(e.data.error)); else resolve({...e.data.result, vadSeconds: seconds});
                };
                worker.postMessage({id:'native-real',action:'asr',origin:location.origin,language:'auto',samples},[samples.buffer]);
              });
            }""".replace('__SONORA_VAD_CHECK__', (ROOT / 'tests/native_vad.js').read_text()), {'file': worker_file, 'vadFile': vad_file, 'wav': wav})
            assert result['language'] == 'zh' and '时间' in result['text'], result
            results.append({'task': 'android-wasm-vad-asr', 'result': result, 'seconds': round(time.monotonic()-start, 3)})
            print(results[-1], flush=True)
            page.locator('#source-language').select_option('auto')
            page.locator('#target-language').select_option('zh')
            page.get_by_role('button', name='文字输入', exact=True).click()
            page.get_by_label('输入一句话，测试翻译模型').fill('Hello, how are you?')
            start = time.monotonic()
            # Keyboard activation avoids both IME coordinate races and an
            # unconditional Android Back exiting the Activity before IME opens.
            page.get_by_role('button', name='翻译', exact=True).press('Enter')
            expect(page.get_by_role('button', name='保存会话')).to_be_enabled(timeout=180000)
            expect(page.locator('.transcript-error')).not_to_be_visible()
            translated = page.locator('.translated .transcript-text').inner_text()
            assert any('\u4e00' <= char <= '\u9fff' for char in translated), translated
            expect(page.locator('#source-language')).to_have_value('auto')
            expect(page.locator('.transcript-footer')).to_contain_text('已识别：英语')
            results.append({'task': 'android-wasm-translation', 'result': translated, 'seconds': round(time.monotonic()-start, 3)})
            print(results[-1], flush=True)
            previous = translated
            page.get_by_role('button', name='文字输入', exact=True).click()
            page.get_by_label('输入一句话，测试翻译模型').fill('Thank you.')
            page.get_by_role('button', name='翻译', exact=True).press('Enter')
            expect(page.get_by_role('button', name='保存会话')).to_be_enabled(timeout=180000)
            expect(page.locator('.transcript-error')).not_to_be_visible()
            expect(page.locator('.transcript-pane')).to_have_count(2)
            expect(page.locator('.original .transcript-text')).to_have_text('Hello, how are you? Thank you.')
            expect(page.locator('.translated .transcript-text')).to_have_count(1)
            translated = page.locator('.translated .transcript-text').inner_text()
            assert translated.startswith(previous) and len(translated) > len(previous), translated
            results.append({'task': 'android-continuous-translation', 'result': translated})
            print(results[-1], flush=True)
            page.screenshot(path=str(OUTPUT / 'offline-android.png'), full_page=True)
            (OUTPUT / 'offline-android.json').write_text(json.dumps({'passed': True, 'mirror_closed_before_inference': True, 'download_requests': requests, 'results': results}, ensure_ascii=False, indent=2))
            browser.close()
    finally:
        server.shutdown(); server.server_close()
        adb('forward', '--remove', f'tcp:{devtools}')
        subprocess.run([adb_path, '-s', args.serial, 'reverse', '--remove', f'tcp:{port}'], capture_output=True)


if __name__ == '__main__':
    main()
