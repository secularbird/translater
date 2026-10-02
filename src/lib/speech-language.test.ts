import { describe, expect, it } from 'vitest';
import { speechLanguage } from './speech-language';

describe('short spoken language context', () => {
  it('does not route the observed Chinese interjection to Japanese translation', () => {
    expect(speechLanguage('嗯。', 'ja', 'auto', 'zh')).toBe('zh');
    expect(speechLanguage('喂喂。', 'en', 'auto')).toBe('zh');
  });
  it('preserves real language changes and non-filler Japanese text', () => {
    expect(speechLanguage('東京。', 'ja', 'auto', 'zh')).toBe('ja');
    expect(speechLanguage('Hello.', 'en', 'auto', 'zh')).toBe('en');
  });
  it('honors a manual source and an existing Japanese context', () => {
    expect(speechLanguage('嗯。', 'zh', 'ja', 'zh')).toBe('ja');
    expect(speechLanguage('嗯。', 'ja', 'auto', 'ja')).toBe('ja');
  });
});
