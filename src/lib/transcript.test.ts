import { describe, expect, it } from 'vitest';
import type { Segment } from '../types';
import { sessionText, transcriptText } from './transcript';

let nextId = 0;
const segment = (source: string, translation = source): Segment => ({
  id: String(nextId++), source, translation, language: 'en', targetLanguage: 'zh', status: 'done', time: '10:00:00',
});

describe('continuous transcript', () => {
  it('joins English words and sentences without inserting paragraph breaks', () => {
    expect(transcriptText([segment('Hello'), segment('world.'), segment('How are you?')], 'source'))
      .toBe('Hello world. How are you?');
  });
  it('joins Chinese and Japanese without spaces at processing boundaries', () => {
    expect(transcriptText([segment('你好，'), segment('今天'), segment('天气很好。')], 'source')).toBe('你好，今天天气很好。');
    expect(transcriptText([segment('こんにち'), segment('は。')], 'source')).toBe('こんにちは。');
  });
  it('preserves repeated speech and original formatting inside an utterance', () => {
    expect(transcriptText([segment('Hello.'), segment(''), segment('Hello.')], 'source')).toBe('Hello. Hello.');
    expect(transcriptText([segment('First line\nSecond line'), segment('Next.')], 'source')).toBe('First line\nSecond line Next.');
  });
  it('attaches punctuation, keeps Korean spacing, and groups whole-session copies by section', () => {
    expect(transcriptText([segment('Hello'), segment(', world!')], 'source')).toBe('Hello, world!');
    expect(transcriptText([segment('안녕'), segment('하세요')], 'source')).toBe('안녕 하세요');
    expect(sessionText([segment('Hello.', '你好。'), segment('Goodbye.', '再见。')]))
      .toBe('原文\nHello. Goodbye.\n\n译文\n你好。再见。');
  });
});
