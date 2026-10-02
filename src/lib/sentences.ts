/** Remove only an ASR-added ending at an artificial transport boundary. */
export function continuationText(text: string): string {
  return text.trim().replace(/[.!?。！？]+([”’"』」）)\]]*)$/u, '$1');
}

/** Segment finalized utterances, never arbitrary character/time slices.
 * A VAD end or explicit Stop finalizes a short utterance even without punctuation.
 */
export function completeSentences(text: string): string[] {
  const value = text.trim();
  const output: string[] = [];
  let start = 0, quoteDepth = 0;
  const close = /[”’"』」）)\]}]/u;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '"') quoteDepth = quoteDepth ? quoteDepth - 1 : quoteDepth + 1;
    if (/[“「『]/u.test(char)) quoteDepth++;
    if (/[”」』]/u.test(char)) quoteDepth = Math.max(0, quoteDepth - 1);
    if (!/[.!?。！？]/u.test(char)) continue;
    if (char === '.') {
      if (value[i - 1] === '.' || value[i + 1] === '.') continue;
      if (/\d/u.test(value[i - 1] || '') && /\d/u.test(value[i + 1] || '')) continue;
      if (/[A-Za-z0-9]/u.test(value[i + 1] || '')) continue;
      const prefix = value.slice(start, i + 1);
      if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.$/iu.test(prefix)) continue;
      if (/(?:\b[A-Za-z]\.){2,}$/u.test(prefix) || /(?:^|\s)[A-Z]\.$/u.test(prefix)) continue;
    }
    let end = i + 1;
    while (/[.!?。！？]/u.test(value[end] || '')) end++;
    if (quoteDepth > 0 && !close.test(value[end] || '')) continue;
    while (close.test(value[end] || '')) {
      if (/[”」』"]/u.test(value[end])) quoteDepth = Math.max(0, quoteDepth - 1);
      end++;
    }
    const sentence = value.slice(start, end).trim();
    if (sentence) output.push(sentence);
    start = end; i = end - 1;
  }
  const tail = value.slice(start).trim();
  if (tail) output.push(tail);
  return output;
}
