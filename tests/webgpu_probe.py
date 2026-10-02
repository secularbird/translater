"""Read WebGPU capabilities from the running Android app; does not change its engine."""
import argparse
import json
import subprocess
from playwright.sync_api import sync_playwright
from android_smoke import locate_adb
from reporting import OUTPUT


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serial', default='emulator-5554')
    args = parser.parse_args()
    adb = locate_adb()
    def command(*values):
        return subprocess.check_output([adb, '-s', args.serial, *values], text=True).strip()
    pid = command('shell', 'pidof', 'com.sonora.translate')
    if not pid:
        raise RuntimeError('Start Sonora on the device first.')
    port = command('forward', 'tcp:0', f'localabstract:webview_devtools_remote_{pid}')
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f'ws://127.0.0.1:{port}/devtools/browser')
            try:
                page = next(page for context in browser.contexts for page in context.pages if 'tauri.localhost' in page.url)
                result = page.evaluate('''async () => {
                  const result = {userAgent: navigator.userAgent, secureContext: isSecureContext,
                    webgpuExposed: !!navigator.gpu, adapterAvailable: false};
                  if (!navigator.gpu) return result;
                  try {
                    const adapter = await navigator.gpu.requestAdapter();
                    result.adapterAvailable = !!adapter;
                    if (adapter) {
                      result.features = [...adapter.features];
                      result.description = adapter.info?.description || '';
                      result.vendor = adapter.info?.vendor || '';
                      result.fallback = adapter.isFallbackAdapter ?? adapter.info?.isFallbackAdapter ?? null;
                      result.maxBufferSize = adapter.limits.maxBufferSize;
                      result.maxStorageBufferBindingSize = adapter.limits.maxStorageBufferBindingSize;
                    }
                  } catch (error) { result.error = String(error); }
                  return result;
                }''')
                OUTPUT.mkdir(parents=True, exist_ok=True)
                (OUTPUT / 'webgpu-capabilities.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
                print(json.dumps(result, ensure_ascii=False, indent=2))
            finally:
                browser.close()
    finally:
        command('forward', '--remove', f'tcp:{port}')


if __name__ == '__main__':
    main()
