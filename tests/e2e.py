"""Isolated browser scenarios against an actual local HTTP/SSE fixture server."""
import json
import os
import struct
import unittest
from playwright.sync_api import sync_playwright, expect
from model_fixture import ModelFixture
from reporting import ROOT, OUTPUT, run_suite


class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True, args=[
            "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            f"--use-file-for-fake-audio-capture={ROOT / 'tests/fixtures/speech-en.wav'}",
        ])
        cls.fixture = ModelFixture()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.close()
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.fixture.reset()
        self.context = self.browser.new_context(viewport={"width": 1440, "height": 1000},
                                               permissions=["microphone", "clipboard-read", "clipboard-write"])
        # Seed only once; reload must exercise the app's own persistence behavior.
        initial = json.dumps(self.fixture.settings(), ensure_ascii=False)
        self.context.add_init_script(f"if (!localStorage.getItem('sonora.settings.v1')) localStorage.setItem('sonora.settings.v1', JSON.stringify({initial}));")
        self.context.tracing.start(screenshots=True, snapshots=True, sources=True)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(os.environ.get("SONORA_BASE_URL", "http://localhost:1420"))
        self.page.wait_for_load_state("networkidle")
        expect(self.page.get_by_text("点击麦克风，开始说话", exact=True)).to_be_visible()

    def tearDown(self):
        name = self._testMethodName
        try:
            self.page.screenshot(path=str(OUTPUT / f"{name}.png"), full_page=True)
            self.context.tracing.stop(path=str(OUTPUT / f"{name}.trace.zip"))
        finally:
            self.context.close()
            self.fixture.gate.set()
        self.assertEqual(self.errors, [], "Unexpected browser JavaScript errors")

    def submit(self, text="It's lovely to finally meet you in person."):
        self.page.get_by_role("button", name="文字输入", exact=True).click()
        self.page.get_by_label("输入一句话，测试翻译模型").fill(text)
        self.page.get_by_role("button", name="翻译", exact=True).click()

    def test_01_settings_validation_and_secret_persistence(self):
        self.page.get_by_role("button", name="模型设置", exact=True).click()
        dialog = self.page.get_by_role("dialog")
        dialog.get_by_role("button", name="测试服务连接").click()
        expect(dialog.get_by_text("两个服务均可访问。", exact=False)).to_be_visible()
        address = dialog.get_by_label("服务基础地址", exact=True)
        address.fill("file:///bad-model")
        dialog.get_by_role("button", name="保存设置").click()
        expect(dialog).to_be_visible()
        expect(dialog.locator(".failure")).to_contain_text("HTTP(S)")
        address.fill(self.fixture.base_url + "/asr")
        dialog.get_by_placeholder("仅保留在本次运行内存中").first.fill("fixture-secret-never-persist")
        dialog.get_by_role("button", name="保存设置").click()
        self.assertNotIn("fixture-secret", self.page.evaluate("localStorage.getItem('sonora.settings.v1')"))
        self.page.reload()
        self.page.get_by_role("button", name="模型设置", exact=True).click()
        expect(self.page.get_by_placeholder("仅保留在本次运行内存中").first).to_have_value("")

    def test_02_incremental_sse_copy_and_history_survive_reload(self):
        self.fixture.mode = "delayed"
        self.submit()
        expect(self.page.locator(".translated .transcript-text")).to_have_text("很高兴")
        expect(self.page.locator(".typing-cursor")).to_be_visible()
        expect(self.page.get_by_role("button", name="保存会话")).to_be_disabled()
        self.fixture.gate.set()
        expect(self.page.locator(".translated .transcript-text")).to_have_text("很高兴终于能与你面对面交流。")
        expect(self.page.get_by_role("button", name="保存会话")).to_be_enabled()
        self.page.get_by_role("button", name="复制译文", exact=True).click()
        self.assertEqual(self.page.evaluate("navigator.clipboard.readText()"), "很高兴终于能与你面对面交流。")
        self.page.get_by_role("button", name="保存会话").click()
        self.page.reload()
        self.page.get_by_role("button", name="历史记录", exact=True).click()
        expect(self.page.locator(".history-detail .translated .transcript-text")).to_have_text("很高兴终于能与你面对面交流。")
        self.page.get_by_role("button", name="删除此会话").click()
        self.page.reload()
        self.page.get_by_role("button", name="历史记录", exact=True).click()
        expect(self.page.get_by_text("还没有保存的对话。", exact=False)).to_be_visible()

    def test_03_provider_failure_then_retry(self):
        self.fixture.mode = "unauthorized"
        self.submit("Hello")
        expect(self.page.get_by_role("alert")).to_contain_text("401")
        self.fixture.mode = "normal"
        self.page.get_by_role("button", name="重试", exact=True).click()
        expect(self.page.locator(".translated .transcript-text")).to_have_text("很高兴终于能与你面对面交流。")
        expect(self.page.get_by_role("alert")).not_to_be_visible()

    def test_04_truncated_stream_preserves_partial_translation(self):
        self.fixture.mode = "truncated"
        self.submit("Hello")
        expect(self.page.get_by_role("alert")).to_contain_text("连接中断")
        expect(self.page.locator(".translated .transcript-text")).to_have_text("很高兴")
        expect(self.page.get_by_role("button", name="重试", exact=True)).to_be_enabled()

    def test_05_cancel_stops_stream_and_unlocks_controls(self):
        self.fixture.mode = "delayed"
        self.submit("Hello")
        expect(self.page.locator(".typing-cursor")).to_be_visible()
        self.page.get_by_role("button", name="取消处理").click()
        expect(self.page.get_by_role("button", name="开始翻译", exact=True)).to_be_enabled()
        self.fixture.gate.set()
        expect(self.page.locator(".transcript-error")).to_contain_text("已取消")
        expect(self.page.locator(".translated .transcript-text")).to_have_text("很高兴")
        self.page.get_by_role("button", name="清空会话").click()
        expect(self.page.locator(".transcript-text")).to_have_count(0)
        expect(self.page.locator(".transcript-pane")).to_have_count(2)

    def test_06_audio_capture_wav_asr_and_translation(self):
        self.page.get_by_role("button", name="开始翻译", exact=True).click()
        expect(self.page.get_by_role("button", name="结束录音", exact=True)).to_be_visible()
        expect(self.page.locator("#source-language")).to_be_disabled()
        expect(self.page.get_by_role("button", name="模型设置", exact=True)).to_be_disabled()
        expect(self.page.locator(".translated .transcript-text")).to_contain_text("很高兴终于能与你面对面交流。", timeout=15000)
        self.page.get_by_role("button", name="结束录音", exact=True).click()
        expect(self.page.get_by_role("button", name="开始翻译", exact=True)).to_be_enabled(timeout=15000)
        expect(self.page.locator(".transcript-footer")).to_contain_text("已识别：英语")
        uploads = [r for r in self.fixture.requests if r["path"].endswith("/inference")]
        self.assertGreater(len(uploads), 0)
        self.assertIn(b"RIFF", uploads[0]["body"])
        self.assertIn(b"audio/wav", uploads[0]["body"])
        offset = uploads[0]['body'].index(b'RIFF')
        duration = struct.unpack_from('<I', uploads[0]['body'], offset + 40)[0] / 32000
        self.assertGreater(duration, 4, 'Speech must not be chopped at the previous fixed time limit')
        chats = [r["json"] for r in self.fixture.requests if "json" in r]
        self.assertTrue(chats[0]["stream"])
        self.assertIn("English".lower(), chats[0]["messages"][0]["content"].lower())

    def test_07_asr_failure_automatically_stops_microphone(self):
        self.fixture.mode = "asr-failure"
        self.page.get_by_role("button", name="开始翻译", exact=True).click()
        expect(self.page.get_by_role("alert")).to_contain_text("503", timeout=15000)
        expect(self.page.get_by_role("button", name="开始翻译", exact=True)).to_be_enabled()
        expect(self.page.get_by_role("button", name="结束录音", exact=True)).not_to_be_visible()
        self.assertFalse(any("json" in r for r in self.fixture.requests))

    def test_08_language_swap_and_small_screen_controls(self):
        self.page.locator("#source-language").select_option("en")
        self.page.get_by_role("button", name="交换源语言和目标语言").click()
        expect(self.page.locator("#source-language")).to_have_value("zh")
        expect(self.page.locator("#target-language")).to_have_value("en")
        metrics = []
        for width, height in [(320, 568), (360, 640), (390, 844), (768, 1024), (1024, 768), (1440, 900), (1920, 1080), (844, 390)]:
            self.page.set_viewport_size({"width": width, "height": height})
            self.page.wait_for_function('Math.abs(document.querySelector(".app-shell").getBoundingClientRect().height - innerHeight) < 2')
            self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"), f"Overflow at {width}px")
            button = self.page.get_by_role("button", name="开始翻译", exact=True)
            self.assertTrue(button.evaluate("el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x+r.width/2, r.y+r.height/2)); }"))
            metric = self.page.evaluate('''() => {
              const panes = [...document.querySelectorAll('.pane-scroll')].map(e => e.getBoundingClientRect());
              const panel = document.querySelector('.transcript-panel').getBoundingClientRect();
              return {width:innerWidth,height:innerHeight,panelWidth:panel.width,readingAreaRatio:panes.reduce((sum,r)=>sum+r.width*r.height,0)/(innerWidth*innerHeight),minPaneHeight:Math.min(...panes.map(r=>r.height))};
            }''')
            self.assertGreater(metric['panelWidth'] / width, 0.9)
            self.assertGreater(metric['readingAreaRatio'], 0.30)
            self.assertGreater(metric['minPaneHeight'], 48)
            metrics.append(metric)
            self.page.screenshot(path=str(OUTPUT / f"responsive-{width}.png"), full_page=True)
        (OUTPUT / 'responsive-metrics.json').write_text(json.dumps(metrics, indent=2))
        self.page.set_viewport_size({"width": 390, "height": 844})
        self.page.get_by_role("button", name="模型设置", exact=True).click()
        expect(self.page.get_by_role("dialog")).to_be_visible()
        self.assertTrue(self.page.evaluate("document.querySelector('dialog').scrollWidth <= document.querySelector('dialog').clientWidth"))
        self.page.keyboard.press("Escape")
        expect(self.page.get_by_role("dialog")).not_to_be_visible()

    def test_09_remote_profile_uses_selected_model_and_authorization(self):
        self.page.get_by_role("button", name="模型设置", exact=True).click()
        dialog = self.page.get_by_role("dialog")
        dialog.get_by_role("button", name="远程 API", exact=True).click()
        dialog.get_by_label("模型名称", exact=True).nth(1).fill("fixture-small-remote-model")
        dialog.get_by_placeholder("仅保留在本次运行内存中").nth(1).fill("fixture-remote-key")
        dialog.get_by_role("button", name="保存设置").click()
        self.submit("Hello")
        expect(self.page.locator(".translated .transcript-text")).to_have_text("很高兴终于能与你面对面交流。")
        request = next(r for r in self.fixture.requests if "json" in r)
        self.assertEqual(request["json"]["model"], "fixture-small-remote-model")
        self.assertEqual(request["authorization"], "Bearer fixture-remote-key")

    def test_10_append_in_existing_sections_and_restore_continuous_history(self):
        original_pane = self.page.locator('.transcript-pane.original').element_handle()
        translated_pane = self.page.locator('.transcript-pane.translated').element_handle()
        source = self.page.locator('.original .transcript-text')
        translation = self.page.locator('.translated .transcript-text')
        sentence = '很高兴终于能与你面对面交流。'
        self.submit('The first sentence.')
        expect(translation).to_have_text(sentence)
        expect(self.page.get_by_role('button', name='保存会话')).to_be_enabled()
        self.fixture.mode = 'delayed'
        self.submit('The second sentence.')
        expect(source).to_have_text('The first sentence. The second sentence.')
        expect(translation).to_have_text(sentence + '很高兴')
        self.assertTrue(original_pane.evaluate("el => el === document.querySelector('.transcript-pane.original')"))
        self.assertTrue(translated_pane.evaluate("el => el === document.querySelector('.transcript-pane.translated')"))
        expect(self.page.locator('.transcript-pane')).to_have_count(2)
        expect(source).to_have_count(1)
        expect(translation).to_have_count(1)
        expect(self.page.locator('.continuous-transcript time, .continuous-transcript article')).to_have_count(0)
        self.fixture.gate.set()
        expect(translation).to_have_text(sentence * 2)
        self.page.get_by_role('button', name='复制译文', exact=True).click()
        self.assertEqual(self.page.evaluate('navigator.clipboard.readText()'), sentence * 2)
        self.page.set_viewport_size({'width': 390, 'height': 844})
        self.page.screenshot(path=str(OUTPUT / 'continuous-mobile.png'), full_page=True)
        self.page.set_viewport_size({'width': 1440, 'height': 1000})
        self.page.screenshot(path=str(OUTPUT / 'continuous-desktop.png'), full_page=True)
        self.page.get_by_role('button', name='保存会话').click()
        self.page.reload()
        self.page.get_by_role('button', name='历史记录', exact=True).click()
        expect(self.page.locator('.history-detail .original .transcript-text')).to_have_text('The first sentence. The second sentence.')
        expect(self.page.locator('.history-detail .translated .transcript-text')).to_have_text(sentence * 2)
        self.page.get_by_role('button', name='复制全部', exact=True).click()
        self.assertEqual(self.page.evaluate('navigator.clipboard.readText()'), '原文\nThe first sentence. The second sentence.\n\n译文\n' + sentence * 2)

    def test_11_recording_restart_appends_to_the_same_transcript(self):
        self.page.get_by_role('button', name='开始翻译', exact=True).click()
        source = self.page.locator('.original .transcript-text')
        expect(source).to_contain_text('lovely', timeout=15000)
        self.page.get_by_role('button', name='结束录音', exact=True).click()
        expect(self.page.get_by_role('button', name='开始翻译', exact=True)).to_be_enabled(timeout=15000)
        previous = source.inner_text()
        self.page.get_by_role('button', name='开始翻译', exact=True).click()
        expect(source).not_to_have_text(previous, timeout=15000)
        self.page.get_by_role('button', name='结束录音', exact=True).click()
        expect(self.page.get_by_role('button', name='开始翻译', exact=True)).to_be_enabled(timeout=15000)
        self.assertTrue(source.inner_text().startswith(previous))
        expect(self.page.locator('.transcript-pane')).to_have_count(2)
        expect(self.page.locator('.original .transcript-text')).to_have_count(1)
        expect(self.page.locator('.translated .transcript-text')).to_have_count(1)

    def test_12_vad_final_recognition_is_translated_as_complete_sentences(self):
        self.fixture.asr_text = 'Dr. Smith paid 3.14 dollars, then left. Thank you!'
        self.page.get_by_role('button', name='开始翻译', exact=True).click()
        expect(self.page.locator('.original .transcript-text')).to_have_text(self.fixture.asr_text, timeout=15000)
        self.page.get_by_role('button', name='结束录音', exact=True).click()
        expect(self.page.get_by_role('button', name='开始翻译', exact=True)).to_be_enabled(timeout=15000)
        requests = [request['json']['messages'][-1]['content'] for request in self.fixture.requests if 'json' in request]
        self.assertEqual(requests, ['Dr. Smith paid 3.14 dollars, then left.', 'Thank you!'])

    def test_13_long_text_and_composer_fit_compact_windows(self):
        self.submit('A long continuous transcript ' * 90)
        expect(self.page.get_by_role('button', name='保存会话', exact=True)).to_be_enabled()
        for width, height in [(320, 568), (390, 440), (844, 390), (1440, 900)]:
            self.page.set_viewport_size({'width': width, 'height': height})
            self.page.wait_for_function('Math.abs(document.querySelector(".app-shell").getBoundingClientRect().height - innerHeight) < 2')
            self.page.get_by_role('button', name='文字输入', exact=True).click()
            self.page.get_by_label('输入一句话，测试翻译模型').fill('A second input')
            submit = self.page.get_by_role('button', name='翻译', exact=True)
            self.assertTrue(submit.evaluate('el => { const r=el.getBoundingClientRect(); return r.bottom<=innerHeight && el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); }'))
            self.page.screenshot(path=str(OUTPUT / f'composer-{width}-{height}.png'))
            self.page.get_by_role('button', name='关闭文字输入', exact=True).click()
            pane = self.page.locator('.original .pane-scroll')
            self.assertTrue(pane.evaluate('el => el.scrollHeight > el.clientHeight'))
        expect(self.page.locator('.original .transcript-text')).to_contain_text('A long continuous transcript')

    def test_14_auto_source_applies_to_each_typed_input(self):
        self.page.locator('#source-language').select_option('auto')
        self.submit('Bonjour, comment allez-vous ?')
        expect(self.page.get_by_role('button', name='保存会话', exact=True)).to_be_enabled()
        expect(self.page.locator('.transcript-footer')).to_contain_text('已识别：法语')
        expect(self.page.locator('#source-language')).to_have_value('auto')
        self.submit('今天天气很好。')
        expect(self.page.get_by_role('button', name='保存会话', exact=True)).to_be_enabled()
        expect(self.page.locator('.transcript-footer')).to_contain_text('已识别：简体中文')
        expect(self.page.locator('#source-language')).to_have_value('auto')

    def test_15_undetectable_text_can_be_retried_with_a_manual_source(self):
        self.page.locator('#source-language').select_option('auto')
        self.submit('12345')
        expect(self.page.locator('.transcript-error')).to_contain_text('语言信息')
        self.assertFalse(any('json' in request for request in self.fixture.requests))
        self.page.locator('#source-language').select_option('en')
        self.page.get_by_role('button', name='重试', exact=True).click()
        expect(self.page.get_by_role('button', name='保存会话', exact=True)).to_be_enabled()
        expect(self.page.locator('.transcript-error')).not_to_be_visible()
        expect(self.page.locator('.transcript-footer')).to_contain_text('已识别：英语')


if __name__ == "__main__":
    run_suite(BrowserTests, "browser")
