"""Real SenseVoice/M2M100 browser WASM validation, with external requests blocked.

Requires npm run models:download and an app server (SONORA_BASE_URL or :1420).
Weights are imported through the same file-input/cache path exposed to users.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import time
from playwright.sync_api import sync_playwright, expect
from reporting import ROOT, OUTPUT


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--asr-only', action='store_true')
    args = parser.parse_args()
    base = os.environ.get('SONORA_BASE_URL', 'http://localhost:1420')
    manifest = json.loads((ROOT / 'src/offline/assets.json').read_text())
    assets = [asset for asset in manifest if not args.asr_only or asset['engine'] == 'asr']
    paths = [ROOT / '.model-cache/offline-assets' / asset['id'] for asset in assets]
    for asset, path in zip(assets, paths):
        assert path.is_file() and path.stat().st_size == asset['size'], f'Missing pinned weight: {path}. Run npm run models:download.'
    OUTPUT.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f"--use-file-for-fake-audio-capture={ROOT / 'tests/fixtures/speech-en.wav'}"])
        context = browser.new_context(viewport={'width': 1100, 'height': 900}, permissions=['microphone'])
        page = context.new_page()
        context.tracing.start(screenshots=True, snapshots=True, sources=True)
        page.on('console', lambda message: print(f'Browser {message.type}: {message.text}', flush=True) if message.type in ['error', 'warning'] else None)
        page.on('pageerror', lambda error: print(f'Page error: {error}', flush=True))
        external = []
        def block_external(route):
            if route.request.url.startswith(base + '/'):
                route.continue_()
            else:
                external.append(route.request.url)
                route.abort()
        context.route('https://**', block_external)
        context.route('http://**', block_external)
        try:
            page.goto(base)
            page.get_by_role('button', name='模型设置', exact=True).click()
            page.get_by_role('button', name='设备离线', exact=True).click()
            page.get_by_label('导入离线模型文件').set_input_files([str(path) for path in paths])
            expect(page.locator('.offline-model-row').first).to_contain_text('已下载', timeout=180000)
            if not args.asr_only:
                expect(page.locator('.offline-model-row').nth(1)).to_contain_text('已下载', timeout=180000)
            expect(page.get_by_role('button', name='保存设置')).to_be_enabled(timeout=180000)
            page.get_by_role('button', name='保存设置').click()
            # Reload proves models are on disk, rather than retained File objects.
            page.reload()
            for language in ['en', 'zh']:
                wav = base64.b64encode((ROOT / f'.model-cache/samples/{language}.wav').read_bytes()).decode()
                start = time.monotonic()
                result = page.evaluate("""async ({wav}) => {
                  const {offlineTranscribe} = await import('/src/offline/client.ts');
                  const bytes = Uint8Array.from(atob(wav), c => c.charCodeAt(0));
                  return await offlineTranscribe(bytes, 'auto', new AbortController().signal, true);
                }""", {'wav': wav})
                assert result['language'] == language, result
                assert len(result['text']) > 5, result
                if language == 'en':
                    assert 'tribal' in result['text'].lower(), result
                else:
                    assert '时间' in result['text'], result
                results.append({'task': f'asr-{language}', 'result': result, 'seconds': round(time.monotonic()-start, 3)})
                print(results[-1], flush=True)
            if not args.asr_only:
                page.locator('#source-language').select_option('auto')
                page.locator('#target-language').select_option('zh')
                page.get_by_role('button', name='文字输入', exact=True).click()
                page.get_by_label('输入一句话，测试翻译模型').fill('Hello, how are you?')
                start = time.monotonic()
                page.get_by_role('button', name='翻译', exact=True).click()
                expect(page.get_by_role('button', name='保存会话')).to_be_enabled(timeout=180000)
                expect(page.locator('.transcript-error')).not_to_be_visible()
                translated = page.locator('.translated .transcript-text').inner_text()
                assert any('\u4e00' <= char <= '\u9fff' for char in translated), translated
                expect(page.locator('.transcript-footer')).to_contain_text('已识别：英语')
                expect(page.locator('#source-language')).to_have_value('auto')
                results.append({'task': 'translation-auto-en-zh', 'result': translated, 'seconds': round(time.monotonic()-start, 3)})
                print(results[-1], flush=True)
                # Terminate both workers and translate again from persistent cache.
                page.reload()
                page.locator('#source-language').select_option('auto')
                page.locator('#target-language').select_option('en')
                page.get_by_role('button', name='文字输入', exact=True).click()
                page.get_by_label('输入一句话，测试翻译模型').fill('今天天气很好。')
                start = time.monotonic()
                page.get_by_role('button', name='翻译', exact=True).click()
                expect(page.get_by_role('button', name='保存会话')).to_be_enabled(timeout=180000)
                expect(page.locator('.transcript-error')).not_to_be_visible()
                translated = page.locator('.translated .transcript-text').inner_text()
                assert 'weather' in translated.lower(), translated
                expect(page.locator('.transcript-footer')).to_contain_text('已识别：简体中文')
                expect(page.locator('#source-language')).to_have_value('auto')
                results.append({'task': 'translation-auto-zh-en-reload', 'result': translated, 'seconds': round(time.monotonic()-start, 3)})
                print(results[-1], flush=True)
                # Real microphone fixture -> Silero VAD -> SenseVoice -> M2M100.
                page.get_by_role('button', name='清空会话', exact=True).click()
                page.locator('#source-language').select_option('auto')
                page.locator('#target-language').select_option('zh')
                start = time.monotonic()
                page.get_by_role('button', name='开始翻译', exact=True).click()
                expect(page.locator('.original .transcript-text')).to_contain_text('tribal', timeout=60000)
                page.get_by_role('button', name='结束录音', exact=True).click()
                expect(page.get_by_role('button', name='开始翻译', exact=True)).to_be_enabled(timeout=180000)
                expect(page.locator('.transcript-error')).not_to_be_visible()
                translated = page.locator('.translated .transcript-text').inner_text()
                assert any('\u4e00' <= char <= '\u9fff' for char in translated), translated
                results.append({'task': 'vad-asr-translation', 'source': page.locator('.original .transcript-text').inner_text(), 'result': translated, 'seconds': round(time.monotonic()-start, 3)})
                print(results[-1], flush=True)
            assert external == [], f'Unexpected network dependency: {external}'
            page.screenshot(path=str(OUTPUT / 'offline-real.png'), full_page=True)
            (OUTPUT / 'offline-real.json').write_text(json.dumps({'passed': True, 'external_requests': external, 'results': results}, ensure_ascii=False, indent=2))
            print('PASS: real pinned models, WASM CPU, persistent cache, zero external requests.', flush=True)
        except Exception:
            page.screenshot(path=str(OUTPUT / 'offline-real-failure.png'), full_page=True)
            (OUTPUT / 'offline-real.json').write_text(json.dumps({'passed': False, 'external_requests': external, 'results': results}, ensure_ascii=False, indent=2))
            raise
        finally:
            context.tracing.stop(path=str(OUTPUT / 'offline-real.trace.zip'))
            browser.close()


if __name__ == '__main__':
    main()
