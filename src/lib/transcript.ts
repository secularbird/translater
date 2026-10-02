import type { Segment } from '../types';

export type TranscriptField = 'source' | 'translation';
export interface TranscriptPart { id: string; text: string }

const unspacedScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const closingPunctuation = /^[,.;:!?%\)\]\}，。！？；：、…」』）》】،؛؟]/u;
const openingPunctuation = /[\(\[\{（《【「『“]$/u;

export function appendTranscriptText(previous: string, next: string): string {
  const left = previous.trimEnd(), right = next.trim();
  if (!left) return right;
  if (!right) return left;
  const last = [...left].at(-1) || '', first = [...right][0];
  const separator = !unspacedScript.test(last) && !unspacedScript.test(first)
    && !closingPunctuation.test(right) && !openingPunctuation.test(left) ? ' ' : '';
  return left + separator + right;
}

/** Join utterances for display, without treating chunk boundaries as paragraphs.
 * Keep intentional repetition and in-utterance newlines; only supply a separator
 * where otherwise two space-delimited words/sentences would run together.
 */
export function transcriptParts(segments: Segment[], field: TranscriptField): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  let previous = '';
  for (const segment of segments) {
    const text = segment[field].trim();
    if (!text) continue;
    const last = [...previous].at(-1) || '';
    const first = [...text][0];
    const separator = previous && !unspacedScript.test(last) && !unspacedScript.test(first)
      && !closingPunctuation.test(text) && !openingPunctuation.test(previous) ? ' ' : '';
    parts.push({ id: segment.id, text: separator + text });
    previous = text;
  }
  return parts;
}

export function transcriptText(segments: Segment[], field: TranscriptField): string {
  return transcriptParts(segments, field).map(part => part.text).join('');
}

export function sessionText(segments: Segment[]): string {
  return `原文\n${transcriptText(segments, 'source')}\n\n译文\n${transcriptText(segments, 'translation')}`;
}
