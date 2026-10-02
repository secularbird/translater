import { describe, expect, it } from 'vitest';
import { completeSentences, continuationText } from './sentences';

describe('finalized speech to complete sentences', () => {
  it('splits Chinese and English only at sentence endings', () => {
    expect(completeSentences('今天下雨，我们带伞。你准备好了吗？出发！')).toEqual(['今天下雨，我们带伞。', '你准备好了吗？', '出发！']);
    expect(completeSentences('This is a long sentence, with a short pause. Next one!')).toEqual(['This is a long sentence, with a short pause.', 'Next one!']);
  });
  it('does not split decimal numbers, initials, abbreviations, or domains', () => {
    expect(completeSentences('Dr. Smith paid 3.14 dollars at example.com. A. Jones agreed.'))
      .toEqual(['Dr. Smith paid 3.14 dollars at example.com.', 'A. Jones agreed.']);
  });
  it('keeps quoted sentences together and accepts an unpunctuated final utterance', () => {
    expect(completeSentences('她说：“你好。欢迎！”我们出发。')).toEqual(['她说：“你好。欢迎！”', '我们出发。']);
    expect(completeSentences('He said "Hello. Welcome!" Then left.')).toEqual(['He said "Hello. Welcome!"', 'Then left.']);
    expect(completeSentences('谢谢')).toEqual(['谢谢']);
  });
  it('does not mistake ASR punctuation on a safety cut for an actual ending', () => {
    expect(continuationText('我今天想。')).toBe('我今天想');
    expect(continuationText('One complete sentence. And an unfinished one.')).toBe('One complete sentence. And an unfinished one');
    expect(completeSentences('')).toEqual([]);
  });
});
