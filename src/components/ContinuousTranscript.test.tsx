// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Segment } from '../types';
import ContinuousTranscript from './ContinuousTranscript';

afterEach(cleanup);
const first: Segment = { id: 'one', time: '10:00:00', source: 'Hello.', translation: '你好。', language: 'en', targetLanguage: 'zh', status: 'done' };
const second: Segment = { ...first, id: 'two', source: 'Good morning.', translation: '早上好。' };

describe('fixed transcript sections', () => {
  it('asks users to wait during warmup instead of suggesting recording has started', () => {
    const { rerender } = render(<ContinuousTranscript segments={[]} preparing onCopy={() => {}} />);
    expect(screen.getByText('准备完成后即可开始说话')).toBeTruthy();
    expect(screen.queryByText('正在聆听…')).toBeNull();
    rerender(<ContinuousTranscript segments={[]} recording onCopy={() => {}} />);
    expect(screen.getByText('正在聆听…')).toBeTruthy();
  });
  it('appends in the same two sections and copies the complete text', () => {
    const copy = vi.fn();
    const { rerender, container } = render(<ContinuousTranscript segments={[]} onCopy={copy} />);
    const original = screen.getByRole('region', { name: '原文' });
    const translated = screen.getByRole('region', { name: '译文' });
    rerender(<ContinuousTranscript segments={[first]} onCopy={copy} />);
    rerender(<ContinuousTranscript segments={[first, second]} onCopy={copy} />);
    expect(screen.getByRole('region', { name: '原文' })).toBe(original);
    expect(screen.getByRole('region', { name: '译文' })).toBe(translated);
    expect(container.querySelectorAll('.transcript-pane')).toHaveLength(2);
    expect(original.querySelector('.transcript-text')?.textContent).toBe('Hello. Good morning.');
    expect(translated.querySelector('.transcript-text')?.textContent).toBe('你好。早上好。');
    expect(container.querySelectorAll('time, article')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '复制译文' }));
    expect(copy).toHaveBeenCalledWith('你好。早上好。');
    fireEvent.click(screen.getByRole('button', { name: '复制原文' }));
    expect(copy).toHaveBeenCalledWith('Hello. Good morning.');
  });
  it('updates streaming/retried text in place without duplicating previous content', () => {
    const retry = vi.fn();
    const failed: Segment = { ...first, status: 'error', translation: '你', error: '连接中断' };
    const { rerender, container } = render(<ContinuousTranscript segments={[failed, second]} onCopy={() => {}} onRetry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledWith(failed);
    rerender(<ContinuousTranscript segments={[{ ...first, translation: '你好', status: 'translating' }, second]} onCopy={() => {}} />);
    expect(container.querySelector('.translated .transcript-text')?.textContent).toBe('你好早上好。');
    const cursor = container.querySelector('.typing-cursor');
    expect(cursor?.parentElement?.textContent).toBe('你好');
    rerender(<ContinuousTranscript segments={[first, second]} onCopy={() => {}} />);
    expect(container.querySelector('.translated .transcript-text')?.textContent).toBe('你好。早上好。');
    expect(container.querySelector('.typing-cursor')).toBeNull();
    expect(within(screen.getByRole('region', { name: '译文' })).queryByRole('status')).toBeNull();
  });
  it('scrolls each section only when following is enabled', () => {
    const { rerender } = render(<ContinuousTranscript segments={[first]} onCopy={() => {}} autoScroll={false} />);
    const original = screen.getByRole('log', { name: '识别原文' });
    const translated = screen.getByRole('log', { name: '翻译结果' });
    Object.defineProperty(original, 'scrollHeight', { value: 1000 });
    Object.defineProperty(translated, 'scrollHeight', { value: 1200 });
    original.scrollTop = 30; translated.scrollTop = 40;
    rerender(<ContinuousTranscript segments={[first, second]} onCopy={() => {}} autoScroll={false} />);
    expect(original.scrollTop).toBe(30);
    expect(translated.scrollTop).toBe(40);
    rerender(<ContinuousTranscript segments={[first, second]} onCopy={() => {}} autoScroll />);
    expect(original.scrollTop).toBe(1000);
    expect(translated.scrollTop).toBe(1200);
  });
});
