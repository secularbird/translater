import { sourceCode } from '../offline/catalog';

/** SenseVoice LID is unstable on tiny interjections such as the observed 嗯→ja. */
export function speechLanguage(text: string, detected: string, selected: string, previous?: string): string {
  const explicit = sourceCode(selected);
  if (!['auto', 'unknown'].includes(explicit)) return explicit;
  const letters = text.replace(/[^\p{L}\p{M}]/gu, '');
  if ((!previous || previous === 'zh' || previous === 'yue')
    && letters.length > 0 && letters.length <= 4 && /^[嗯啊哦喂呃唔哎诶欸喔哈呵]+$/.test(letters)) {
    return previous || 'zh';
  }
  return sourceCode(detected);
}
