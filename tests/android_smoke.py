"""Native Android UI/permission/lifecycle scenarios; never claim model accuracy."""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import unittest
import xml.etree.ElementTree as ET
from reporting import OUTPUT, run_suite

PACKAGE = "com.sonora.translate"
ACTIVITY = PACKAGE + "/.MainActivity"
MIC = "android.permission.RECORD_AUDIO"


def locate_adb(explicit=None):
    if explicit:
        return explicit
    candidates = [shutil.which("adb")]
    for home in [os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT"), str(Path.home() / "Library/Android/sdk"), str(Path.home() / "Android/Sdk")]:
        if home:
            candidates.append(str(Path(home) / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb")))
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    raise RuntimeError("ADB not found. Pass --adb or set ANDROID_HOME.")


class AndroidTests(unittest.TestCase):
    adb_path = "adb"
    serial = ""
    reset_permissions = False

    @classmethod
    def adb(cls, *command, binary=False, check=True):
        result = subprocess.run([cls.adb_path, "-s", cls.serial, *command], capture_output=True,
                                text=not binary, timeout=30, check=check)
        return result.stdout

    def nodes(self):
        for attempt in range(3):
            try:
                output = self.adb("shell", "-tt", "uiautomator", "dump", "/dev/tty")
                break
            except subprocess.CalledProcessError as error:
                # Android may reclaim the short-lived UiAutomator process
                # during an activity transition. Retry observation, not actions.
                if error.returncode != 137 or attempt == 2:
                    raise
                time.sleep(0.75)
        start, end = output.find("<?xml"), output.find("</hierarchy>")
        if start == -1 or end == -1:
            raise RuntimeError("Android UI hierarchy is unavailable")
        self.last_xml = output[start:end + len("</hierarchy>")]
        return list(ET.fromstring(self.last_xml).iter("node"))

    @staticmethod
    def find(items, text):
        return next((n for n in items if n.get("text") == text or n.get("content-desc") == text), None)

    def wait(self, predicate, timeout=18):
        deadline, items = time.monotonic() + timeout, []
        while time.monotonic() < deadline:
            items = self.nodes()
            result = predicate(items)
            if result is not None and result is not False:
                return result
            time.sleep(0.25)
        self.fail(f"Android UI condition timed out: {[n.get('text') or n.get('content-desc') for n in items if n.get('text') or n.get('content-desc')]}")

    def tap(self, node):
        self.assertIsNotNone(node, "Expected UI control not found")
        bounds = [int(x) for x in re.findall(r"\d+", node.get("bounds", ""))]
        self.assertEqual(len(bounds), 4)
        self.assertGreater(bounds[2], bounds[0], "Control is outside the screen")
        self.assertEqual(node.get("enabled"), "true", "Control is disabled")
        self.adb("shell", "input", "tap", str((bounds[0] + bounds[2]) // 2), str((bounds[1] + bounds[3]) // 2))

    def launch(self):
        self.adb("shell", "am", "start", "-W", "-n", ACTIVITY)
        self.wait(lambda items: self.find(items, "开始翻译"))

    def setUp(self):
        self.last_xml = ""
        self.adb("shell", "am", "force-stop", PACKAGE)
        self.launch()

    def tearDown(self):
        try:
            current = self.find(self.nodes(), "结束录音")
            if current is not None:
                self.tap(current)
            (OUTPUT / f"android-{self._testMethodName}.png").write_bytes(self.adb("exec-out", "screencap", "-p", binary=True))
            (OUTPUT / f"android-{self._testMethodName}.xml").write_text(self.last_xml, encoding="utf-8")
        finally:
            self.adb("shell", "am", "force-stop", PACKAGE)
            # Restore permission after explicit emulator permission scenarios.
            if self.reset_permissions:
                self.adb("shell", "pm", "grant", PACKAGE, MIC)

    def reset_microphone_permission(self):
        if not self.reset_permissions:
            self.skipTest("Enable --permissions to reset this app's microphone permission")
        self.adb("shell", "am", "force-stop", PACKAGE)
        self.adb("shell", "pm", "revoke", PACKAGE, MIC)
        self.adb("shell", "pm", "clear-permission-flags", PACKAGE, MIC, "user-set", "user-fixed")
        self.launch()

    def start_recording(self):
        self.tap(self.wait(lambda items: self.find(items, "开始翻译")))
        result = self.wait(lambda items: self.find(items, "结束录音") if self.find(items, "结束录音") is not None else next(
            (n for n in items if n.get("resource-id", "").endswith("permission_allow_foreground_only_button")), None), timeout=60)
        if result.get("resource-id", "").endswith("permission_allow_foreground_only_button"):
            self.tap(result)
        # Granting permission happens before model warmup. Use the same bounded
        # startup allowance as the already-authorized path, not the 18s UI wait.
        self.wait(lambda items: self.find(items, "结束录音"), timeout=60)

    def test_01_home_controls_and_navigation(self):
        items = self.nodes()
        self.assertIsNotNone(self.find(items, "声桥"))
        self.assertTrue(any(n.get("resource-id") == "source-language" for n in items))
        self.assertTrue(any(n.get("resource-id") == "target-language" for n in items))
        self.tap(self.find(items, "历史记录"))
        self.tap(self.wait(lambda current: self.find(current, "实时翻译")))
        self.wait(lambda current: self.find(current, "开始翻译"))

    def test_02_model_settings_opens_and_closes(self):
        self.tap(self.find(self.nodes(), "模型设置"))
        items = self.wait(lambda current: current if self.find(current, "关闭设置") is not None else None)
        self.assertIsNotNone(self.find(items, "本地服务"))
        self.assertIsNotNone(self.find(items, "远程 API"))
        self.tap(self.find(items, "关闭设置"))
        self.wait(lambda current: self.find(current, "开始翻译"))

    def test_03_first_permission_and_recording_stop(self):
        self.reset_microphone_permission()
        self.start_recording()
        items = self.nodes()
        self.assertEqual(self.find(items, "模型设置").get("enabled"), "false")
        self.tap(self.find(items, "结束录音"))
        self.wait(lambda current: self.find(current, "开始翻译"))
        self.assertFalse(any("not allowed" in n.get("text", "") for n in self.nodes()))

    def test_04_backgrounding_releases_microphone(self):
        self.start_recording()
        self.adb("shell", "input", "keyevent", "KEYCODE_HOME")
        # Wait for the launcher to actually replace the activity. Dumping once
        # can still return the old WebView during Android's Home animation.
        self.wait(lambda current: True if current and all(n.get('package') != PACKAGE for n in current) else None)
        self.launch()
        self.assertIsNone(self.find(self.nodes(), "结束录音"))
        self.assertEqual(self.find(self.nodes(), "开始翻译").get("enabled"), "true")

    def test_05_denied_permission_has_recoverable_error(self):
        self.reset_microphone_permission()
        self.tap(self.find(self.nodes(), "开始翻译"))
        deny = self.wait(lambda items: next((n for n in items if n.get("resource-id", "").endswith("permission_deny_button")), None), timeout=60)
        self.tap(deny)
        items = self.wait(lambda current: current if any("麦克风权限未开启" in n.get("text", "") for n in current) else None)
        self.assertIsNone(self.find(items, "结束录音"))
        self.assertEqual(self.find(items, "开始翻译").get("enabled"), "true")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--adb")
    parser.add_argument("--serial", required=True)
    parser.add_argument("--permissions", action="store_true", help="Reset/grant/deny the Sonora microphone permission for isolated tests")
    args = parser.parse_args()
    AndroidTests.adb_path = locate_adb(args.adb)
    AndroidTests.serial = args.serial
    AndroidTests.reset_permissions = args.permissions
    try:
        run_suite(AndroidTests, "android")
    finally:
        AndroidTests.adb("shell", "am", "start", "-W", "-n", ACTIVITY, check=False)
