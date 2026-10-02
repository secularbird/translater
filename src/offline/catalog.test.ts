import { describe, expect, it } from 'vitest';
import { encodeWav } from '../lib/audio';
import { MODEL_ASSETS, sourceCode, translationLanguages, wavSamples } from './catalog';

describe('offline model contracts', () => {
  it('pins remote model versions and checksums for every ONNX weight', () => {
    for (const asset of MODEL_ASSETS) {
      expect(asset.revision).toMatch(/^[a-f0-9]{40}$/);
      if (asset.file.endsWith('.onnx')) expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it('maps SenseVoice tags and ASR language names to model language codes', () => {
    expect(sourceCode('<|en|>')).toBe('en');
    expect(sourceCode('English')).toBe('en');
    expect(sourceCode('<|zh|>')).toBe('zh');
    expect(translationLanguages('cantonese', 'en')).toEqual({ src_lang: 'zh', tgt_lang: 'en' });
  });
  it('rejects unsupported/unknown source languages instead of inventing one', () => {
    expect(() => translationLanguages('auto', 'zh')).toThrow('选择原文语言');
    expect(() => translationLanguages('unknown', 'zh')).toThrow();
    expect(() => translationLanguages('en', 'yue')).toThrow('目标语言');
  });
  it('passes 16 kHz WAV samples to the recognizer without byte order errors', () => {
    const samples = wavSamples(encodeWav(new Float32Array([-1, 0, 0.5, 1])));
    expect(samples[0]).toBe(-1);
    expect(samples[2]).toBeCloseTo(0.5, 3);
    expect(samples[3]).toBeCloseTo(1, 3);
    expect(() => wavSamples(encodeWav(new Float32Array(20), 44100))).toThrow('16 kHz');
  });
});
