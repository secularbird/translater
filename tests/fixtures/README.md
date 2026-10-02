# Speech fixture

`speech-en.wav` is prepared by `scripts/prepare_test_audio.py` from the pinned sherpa-onnx SenseVoice sample `test_wavs/en.wav`, with two seconds of silence appended so a genuine VAD endpoint can be observed.

The generated WAV is ignored by Git. The test runner prepares it automatically; it can also be prepared with `python3 scripts/prepare_test_audio.py`.

Source: https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tree/2365baeacb507f821a0c8120fcee3d484dba7a07/test_wavs

Browser tests use real Silero VAD and this test microphone, while ASR/translation HTTP responses remain explicit fixtures. Real-model tests are separate.
