"""Installed WebView layout: real IME, physical tap, rotation, usable reading area."""
import argparse
import json
import subprocess
import time
from playwright.sync_api import sync_playwright, expect
from android_smoke import locate_adb
from reporting import OUTPUT

METRICS = '''() => {
  const viewport = visualViewport;
  const panes = [...document.querySelectorAll('.pane-scroll')].map(e => e.getBoundingClientRect().toJSON());
  const panel = document.querySelector('.transcript-panel').getBoundingClientRect().toJSON();
  return {width:innerWidth,height:innerHeight,visibleHeight:viewport.height,viewportTop:viewport.offsetTop,dpr:devicePixelRatio,panel,panes,
    readingAreaRatio:panes.reduce((sum,r)=>sum+r.width*r.height,0)/(innerWidth*viewport.height)};
}'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serial', default='emulator-5554')
    parser.add_argument('--baseline', action='store_true')
    args = parser.parse_args()
    def adb(*command):
        return subprocess.check_output([locate_adb(), '-s', args.serial, *command], text=True, timeout=30).strip()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    def screenshot(filename):
        # CDP captureScreenshot can resize an Android WebView while the IME is
        # open, changing visualViewport and the very layout being measured.
        (OUTPUT / filename).write_bytes(subprocess.check_output([locate_adb(), '-s', args.serial, 'exec-out', 'screencap', '-p']))
    rotation = adb('shell', 'settings', 'get', 'system', 'user_rotation')
    automatic = adb('shell', 'settings', 'get', 'system', 'accelerometer_rotation')
    if not args.baseline:
        adb('shell', 'am', 'force-stop', 'com.sonora.translate')
    adb('shell', 'am', 'start', '-W', '-n', 'com.sonora.translate/.MainActivity')
    pid = adb('shell', 'pidof', 'com.sonora.translate')
    port = adb('forward', 'tcp:0', f'localabstract:webview_devtools_remote_{pid}')
    report = {'passed': False}
    name = 'layout-android-before' if args.baseline else 'layout-android'
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
            expect(page.get_by_role('button', name='模型设置', exact=True)).to_be_visible()
            page.wait_for_timeout(700)
            report['portrait'] = page.evaluate(METRICS)
            screenshot(f'{name}-portrait.png')
            if not args.baseline:
                page.locator('#source-language').select_option('en')
                page.locator('#target-language').select_option('zh')
                page.get_by_role('button', name='文字输入', exact=True).click()
                page.get_by_label('输入一句话，测试翻译模型').fill('Thank you.')
                page.wait_for_function('(height) => visualViewport.height < height - 120', arg=report['portrait']['height'], timeout=10000)
                page.wait_for_function('() => document.documentElement.dataset.keyboardOpen === "true"')
                page.wait_for_timeout(1200)
                report['keyboard'] = page.evaluate(METRICS)
                send = page.get_by_role('button', name='翻译', exact=True)
                point = send.evaluate('''el => {
                  const r=el.getBoundingClientRect(), v=visualViewport;
                  return {x:(r.x+r.width/2-v.offsetLeft)*devicePixelRatio,y:(r.y+r.height/2-v.offsetTop)*devicePixelRatio,
                    visible:r.top>=v.offsetTop && r.bottom<=v.offsetTop+v.height};
                }''')
                report['sendButton'] = point
                assert point['visible'], point
                screenshot('layout-android-keyboard.png')
                # A real physical tap avoids CDP's IME/visual-viewport hit-test mismatch.
                adb('shell', 'input', 'tap', str(round(point['x'])), str(round(point['y'])))
                expect(page.get_by_label('输入一句话，测试翻译模型')).not_to_be_visible(timeout=10000)
                expect(page.get_by_role('button', name='保存会话', exact=True)).to_be_enabled(timeout=180000)
                expect(page.locator('.translated .transcript-text')).to_contain_text('谢谢', timeout=10000)
                report['translation'] = page.locator('.translated .transcript-text').inner_text()
                if page.evaluate('(height) => visualViewport.height < height - 120', report['portrait']['height']):
                    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
                page.wait_for_function('(height) => visualViewport.height >= height - 120', arg=report['portrait']['height'])
                adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0')
                adb('shell', 'settings', 'put', 'system', 'user_rotation', '1')
                page.wait_for_function('() => innerWidth > innerHeight', timeout=15000)
                page.wait_for_timeout(400)
                report['landscape'] = page.evaluate(METRICS)
                original, translated = report['landscape']['panes']
                assert original['x'] < translated['x'], 'Landscape panes must use side-by-side space'
                assert min(original['height'], translated['height']) > 48
                button = page.get_by_role('button', name='开始翻译', exact=True)
                assert button.evaluate('el => {const r=el.getBoundingClientRect(); return r.bottom<=innerHeight && el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}')
                screenshot('layout-android-landscape.png')
            report['passed'] = True
            browser.close()
    except Exception as error:
        report['error'] = str(error)
        (OUTPUT / 'layout-android-failure-physical.png').write_bytes(subprocess.check_output([locate_adb(), '-s', args.serial, 'exec-out', 'screencap', '-p']))
        raise
    finally:
        for key, value in [('user_rotation', rotation), ('accelerometer_rotation', automatic)]:
            if value == 'null': adb('shell', 'settings', 'delete', 'system', key)
            else: adb('shell', 'settings', 'put', 'system', key, value)
        adb('forward', '--remove', f'tcp:{port}')
        (OUTPUT / f'{name}.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
