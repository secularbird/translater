import { describe, expect, it } from 'vitest';
import { resolveTextLanguage } from './text-language';

describe('local text language detection', () => {
  it.each([
    ['Hello, how are you?', 'en'], ['今天天气很好。', 'zh'],
    ['今日はとても良い天気ですね。', 'ja'], ['안녕하세요. 오늘 날씨가 좋아요.', 'ko'],
    ['Bonjour, comment allez-vous ?', 'fr'], ['Das Wetter ist heute sehr schön.', 'de'],
    ['Hola, ¿cómo estás?', 'es'], ['O tempo está muito bom hoje.', 'pt'],
    ['Il tempo è molto bello oggi.', 'it'], ['Привет, как дела?', 'ru'],
    ['مرحبا كيف حالك اليوم؟', 'ar'], ['आज मौसम बहुत अच्छा है।', 'hi'],
  ])('detects %s as %s without a source selection', async (text, language) => {
    await expect(resolveTextLanguage(text, 'auto')).resolves.toBe(language);
  });
  it('handles short greetings that lack statistical context', async () => {
    expect(await Promise.all(['Hello!', 'Hola', 'Guten Morgen!', 'Merci', '谢谢', 'こんにちは'].map(t => resolveTextLanguage(t, 'auto'))))
      .toEqual(['en', 'es', 'de', 'fr', 'zh', 'ja']);
  });
  it('honors an explicit source rather than overriding it with a guess', async () => {
    await expect(resolveTextLanguage('Hello', 'fr')).resolves.toBe('fr');
  });
  it('does not invent a language for numbers or emoji', async () => {
    await expect(resolveTextLanguage('12345 😀', 'auto')).rejects.toThrow('语言信息');
  });
  it('honors cancellation before detection', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(resolveTextLanguage('Hello', 'auto', abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
