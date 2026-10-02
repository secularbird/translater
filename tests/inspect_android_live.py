"""Live UI/audio diagnostics; observes PCM statistics without substituting input.

Capture is controlled only with explicit --start/--stop/--stop-and-save flags.
"""
import argparse
import json
import subprocess
import time
from playwright.sync_api import sync_playwright
from playwright.sync_api import expect
from android_smoke import locate_adb
from reporting import OUTPUT

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
parser.add_argument('--seconds', type=int, default=12)
parser.add_argument('--stop-and-save', action='store_true')
parser.add_argument('--stop', action='store_true')
parser.add_argument('--start', action='store_true')
args = parser.parse_args()
adb_path = locate_adb()
def adb(*command, binary=False):
    return subprocess.check_output([adb_path, '-s', args.serial, *command], text=not binary, timeout=30)
OUTPUT.mkdir(parents=True, exist_ok=True)
pid = adb('shell', 'pidof', 'com.sonora.translate').strip()
port = adb('forward', 'tcp:0', f'localabstract:webview_devtools_remote_{pid}').strip()
report = {}
try:
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(f'ws://127.0.0.1:{port}/devtools/browser')
        page = browser.contexts[0].pages[0]
        if args.start:
            button = page.get_by_role('button', name='开始翻译', exact=True)
            if button.count(): button.click()
            expect(page.get_by_role('button', name='结束录音', exact=True)).to_be_visible(timeout=180000)
        report['initial'] = page.evaluate('''async () => ({
          innerWidth, innerHeight, scrollY, dpr:devicePixelRatio,
          viewport:{height:visualViewport.height,top:visualViewport.offsetTop,scale:visualViewport.scale},
          rootStyle:document.documentElement.getAttribute('style'), rootData:{...document.documentElement.dataset},
          visibility:document.visibilityState,
          sourceLength:document.querySelector('.original .transcript-text')?.textContent.length||0,
          translationLength:document.querySelector('.translated .transcript-text')?.textContent.length||0,
          recordingStatus:document.querySelector('.recording-status')?.textContent,
          errors:[...document.querySelectorAll('.transcript-error p,.error-banner p')].map(e=>e.textContent),
          permission:await window.__TAURI_INTERNALS__.invoke('plugin:microphone|check_permissions'),
          nativeInsets:await window.__TAURI_INTERNALS__.invoke('plugin:microphone|insets').catch(()=>null),
          native:await window.__TAURI_INTERNALS__.invoke('plugin:microphone|status'),
          boxes:[...document.querySelectorAll('.app-shell,.app-header,.language-bar,.transcript-panel,.pane-scroll,.recording-controls,.recording-actions,.recording-status')].map(e=>({name:e.className,rect:e.getBoundingClientRect().toJSON(),padding:getComputedStyle(e).padding}))
        })''')
        (OUTPUT / 'live-phone-before.png').write_bytes(adb('exec-out', 'screencap', '-p', binary=True))
        page.evaluate('''() => {
          const original = Worker.prototype.postMessage;
          const workers = new Map();
          const stats = {frames:0,samples:0,maxRms:0,maxPeak:0,nonzero:0,processed:0,speechFrames:0,segments:[],asr:0,translation:0,errors:[]};
          Worker.prototype.postMessage = function(message, transfer) {
            if(message?.action === 'audio' && message.samples) {
              if(!workers.has(this)) {
                const listener = ({data}) => {
                  if(data.type==='processed') { stats.processed+=data.samples; if(data.speech)stats.speechFrames++; }
                  if(data.type==='segment') stats.segments.push({id:data.segment.id,final:data.segment.final,bytes:data.segment.audio?.length||0});
                  if(data.type==='error') stats.errors.push(data.message);
                };
                this.addEventListener('message',listener); workers.set(this,listener);
              }
              let sum=0,peak=0;
              for(const sample of message.samples){sum+=sample*sample;peak=Math.max(peak,Math.abs(sample));if(sample!==0)stats.nonzero++;}
              stats.frames++;stats.samples+=message.samples.length;
              stats.maxRms=Math.max(stats.maxRms,Math.sqrt(sum/message.samples.length));stats.maxPeak=Math.max(stats.maxPeak,peak);
            }
            if(message?.action==='asr' && !message.prepare)stats.asr++;
            if(message?.action==='translation' && !message.prepare)stats.translation++;
            return original.call(this,message,transfer);
          };
          window.finishAudioInspection=()=>{
            Worker.prototype.postMessage=original;
            for(const [worker,listener] of workers)worker.removeEventListener('message',listener);
            delete window.finishAudioInspection;return stats;
          };
        }''')
        print('Observing actual audio frames for', args.seconds, 'seconds', flush=True)
        page.wait_for_timeout(args.seconds * 1000)
        report['audio'] = page.evaluate('finishAudioInspection()')
        report['final'] = page.evaluate('''async () => ({
          sourceLength:document.querySelector('.original .transcript-text')?.textContent.length||0,
          translationLength:document.querySelector('.translated .transcript-text')?.textContent.length||0,
          matchedTestSentence:(document.querySelector('.original .transcript-text')?.textContent||'').replace(/[\\s，。！？,.!?]/g,'').includes('今天天气很好我们测试一下语音识别'),
          recordingStatus:document.querySelector('.recording-status')?.textContent,
          errors:[...document.querySelectorAll('.transcript-error p,.error-banner p')].map(e=>e.textContent),
          meter:document.querySelector('.input-meter')?.dataset.level,native:await window.__TAURI_INTERNALS__.invoke('plugin:microphone|status')})''')
        if args.stop or args.stop_and_save:
            button = page.get_by_role('button', name='结束录音', exact=True)
            if button.count(): button.click()
            expect(page.get_by_role('button', name='开始翻译', exact=True)).to_be_enabled(timeout=180000)
            save = page.get_by_role('button', name='保存会话', exact=True)
            if args.stop_and_save and save.is_enabled():
                save.click(); report['savedSession'] = True
            report['afterStop'] = page.evaluate('''async () => ({native:await window.__TAURI_INTERNALS__.invoke('plugin:microphone|status'),recordingStatus:document.querySelector('.recording-status')?.textContent})''')
        (OUTPUT / 'live-phone-after.png').write_bytes(adb('exec-out', 'screencap', '-p', binary=True))
        browser.close()
finally:
    adb('forward', '--remove', f'tcp:{port}')
    (OUTPUT / 'live-phone.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))
