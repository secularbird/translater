import { sourceCode } from '../offline/catalog';

// Short greetings provide too little context for character n-grams. Handle a
// small set explicitly; general sentences use the bundled statistical detector.
const SHORT_PHRASES: Record<string, string> = {
  hello: 'en', hi: 'en', hey: 'en', thanks: 'en', 'thank you': 'en', ok: 'en', okay: 'en',
  bonjour: 'fr', bonsoir: 'fr', merci: 'fr',
  hola: 'es', gracias: 'es', 'buenos días': 'es',
  hallo: 'de', danke: 'de', 'guten morgen': 'de',
  ciao: 'it', grazie: 'it', buongiorno: 'it',
  olá: 'pt', obrigado: 'pt', obrigada: 'pt', 'bom dia': 'pt',
};

/** Resolve each input independently; never overwrite the user's Auto setting. */
export async function resolveTextLanguage(text: string, language: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const selected = sourceCode(language);
  if (selected !== 'auto' && selected !== 'unknown') return selected;
  const input = text.trim().normalize('NFKC');
  if (!/\p{L}/u.test(input)) throw new Error('这段文字没有足够的语言信息，请补充一句话或手动选择原文语言。');
  const phrase = input.toLowerCase().replace(/[^\p{L}\p{M}\s]/gu, '').replace(/\s+/g, ' ').trim();
  if (Object.prototype.hasOwnProperty.call(SHORT_PHRASES, phrase)) return SHORT_PHRASES[phrase];
  // Lazy local chunk: no network service, model download, or ASR allocation.
  const { detect } = await import('tinyld');
  signal?.throwIfAborted();
  const detected = detect(input.slice(0, 6000));
  if (!detected) throw new Error('暂时无法判断这段文字的语言，请补充上下文或手动选择原文语言。');
  return detected;
}
