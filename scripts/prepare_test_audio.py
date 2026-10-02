"""Prepare a real speech + silence fixture for browser microphone/VAD tests."""
from pathlib import Path
import urllib.request
import wave

ROOT = Path(__file__).resolve().parents[1]
destination = ROOT / 'tests/fixtures/speech-en.wav'
if not destination.exists():
    sample = ROOT / '.model-cache/samples/en.wav'
    if not sample.exists():
        sample.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve('https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/test_wavs/en.wav', sample)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(sample), 'rb') as source, wave.open(str(destination), 'wb') as output:
        assert source.getnchannels() == 1 and source.getsampwidth() == 2
        output.setparams(source.getparams())
        output.writeframes(source.readframes(source.getnframes()))
        output.writeframes(bytes(source.getframerate() * 2 * 2))
    print(f'Prepared real speech/VAD fixture: {destination}')
