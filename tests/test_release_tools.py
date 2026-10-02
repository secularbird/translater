"""Release guards and signing configuration, using only synthetic key material."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts/ci' / f'{name}.py')
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


artifacts = module('artifacts')
apple = module('build_apple')
android = module('android_signing')


class ReleaseTools(unittest.TestCase):
    def setUp(self):
        parent = ROOT / 'test-results/ci-unit'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=parent)
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_tag_must_match_all_application_manifests(self):
        (self.root / 'src-tauri').mkdir()
        (self.root / 'package.json').write_text('{"version":"1.2.3"}')
        (self.root / 'src-tauri/tauri.conf.json').write_text('{"version":"1.2.3"}')
        (self.root / 'src-tauri/Cargo.toml').write_text('[package]\nversion="1.2.3"\n')
        with patch.object(artifacts, 'ROOT', self.root):
            self.assertEqual(artifacts.version('v1.2.3'), '1.2.3')
            for tag in ['main', 'v1.2.4', 'v1.2.3;command']:
                with self.assertRaises(ValueError): artifacts.version(tag)
            (self.root / 'src-tauri/Cargo.toml').write_text('[package]\nversion="1.2.4"\n')
            with self.assertRaises(ValueError): artifacts.version('v1.2.3')

    def test_partial_apple_signing_cannot_silently_become_unsigned(self):
        with patch.dict(os.environ, {}, clear=True): self.assertFalse(apple.complete_group(apple.IOS))
        with patch.dict(os.environ, {'IOS_CERTIFICATE': 'synthetic'}, clear=True):
            with self.assertRaises(RuntimeError): apple.complete_group(apple.IOS)

    def test_android_secrets_are_references_not_gradle_literals(self):
        gradle = self.root / 'src-tauri/gen/android/app/build.gradle.kts'
        gradle.parent.mkdir(parents=True)
        gradle.write_text('android {\n    buildTypes {\n        getByName("release") {\n        }\n    }\n}\n')
        env = {'ANDROID_KEYSTORE_BASE64': base64.b64encode(b'synthetic-keystore').decode(),
               'ANDROID_KEYSTORE_PASSWORD': 'synthetic-password', 'ANDROID_KEY_ALIAS': 'synthetic-alias',
               'ANDROID_KEY_PASSWORD': 'synthetic-key-password', 'RUNNER_TEMP': str(self.root / 'runner'),
               'GITHUB_ENV': str(self.root / 'github-env')}
        with patch.object(android, 'ROOT', self.root), patch.dict(os.environ, env, clear=True): android.configure_ci()
        text = gradle.read_text()
        self.assertNotIn('synthetic-password', text)
        self.assertIn('System.getenv("ANDROID_KEYSTORE_PASSWORD")', text)
        self.assertIn('signingConfig = signingConfigs.getByName("sonoraRelease")', text)
        self.assertEqual((self.root / 'runner/sonora-signing/release.jks').read_bytes(), b'synthetic-keystore')

    def test_existing_key_material_is_never_overwritten(self):
        folder = self.root / '.release-keys/android'
        folder.mkdir(parents=True)
        (folder / 'sonora-release.jks').write_bytes(b'existing')
        with patch.object(android, 'ROOT', self.root):
            with self.assertRaises(RuntimeError): android.create_key(None)
        self.assertEqual((folder / 'sonora-release.jks').read_bytes(), b'existing')

    def test_unsigned_android_apk_is_not_collected_as_a_release(self):
        folder = self.root / 'src-tauri/gen/android/app/build/outputs/apk/release'
        folder.mkdir(parents=True)
        (folder / 'app-release-unsigned.apk').write_bytes(b'unsigned')
        with patch.object(artifacts, 'ROOT', self.root), patch.object(artifacts, 'OUT', self.root / 'artifacts'):
            with self.assertRaises(RuntimeError): artifacts.collect('android', '', '1.2.3', 'signed')


if __name__ == '__main__': unittest.main()
