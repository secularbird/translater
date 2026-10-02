// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranslator } from './useTranslator';
import { DEFAULT_SETTINGS } from '../lib/settings';
import { requestCapturePermission, startCapture } from '../lib/capture';
import { transcribe, translate } from '../lib/api';
import { encodeWav } from '../lib/audio';
import { createVadSession } from '../lib/vad';
import * as textLanguage from '../lib/text-language';
import { TranslationLimitError } from '../offline/errors';
import { offlineTranscribe, offlineTranslate, prepareOfflineSpeechModels, requireOfflineSpeechModels } from '../offline/client';

vi.mock('../lib/capture', () => ({ requestCapturePermission: vi.fn(), startCapture: vi.fn() }));
vi.mock('../lib/vad', () => ({ createVadSession: vi.fn() }));
vi.mock('../offline/client', () => ({ offlineTranscribe: vi.fn(), offlineTranslate: vi.fn(), prepareOfflineSpeechModels: vi.fn(), releaseOfflineModels: vi.fn(), requireOfflineSpeechModels: vi.fn() }));
vi.mock('../lib/api', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/api')>(),
  transcribe: vi.fn(), translate: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let frame: Parameters<typeof startCapture>[1];
let emitVad: (final: boolean) => void;
const stopMicrophone = vi.fn(async () => {});
const settings = () => ({ ...structuredClone(DEFAULT_SETTINGS), provider: 'local' as const });
const voice = (seconds = 2, finalize = true) => {
  frame(new Float32Array(16000 * seconds).fill(0.1), 16000);
  if (finalize) emitVad(true);
};
const visibility = (hidden: boolean) => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.mocked(requestCapturePermission).mockResolvedValue(undefined);
  vi.mocked(createVadSession).mockImplementation(async (_silence, onSegment) => {
    let parts: Float32Array[] = [], id = 0, open = false, closed = false;
    emitVad = final => {
      if (closed) return;
      const length = parts.reduce((sum, part) => sum + part.length, 0);
      if (!length && !open) return;
      const samples = new Float32Array(length);
      let offset = 0;
      for (const part of parts) { samples.set(part, offset); offset += part.length; }
      parts = [];
      onSegment({ id, audio: length ? encodeWav(samples) : undefined, final });
      if (final) { id++; open = false; } else open = true;
    };
    return {
      push: samples => { parts.push(samples); return 0.1; },
      stop: async (flush = true) => { if (flush) emitVad(true); closed = true; },
    };
  });
  vi.mocked(startCapture).mockImplementation(async (_device, onFrame) => {
    frame = onFrame;
    return { stop: stopMicrophone };
  });
  vi.mocked(transcribe).mockResolvedValue({ text: 'Hello', language: 'en' });
  vi.mocked(translate).mockImplementation(async (text, _target, _source, _endpoint, token) => { token(`译文：${text}`); });
  vi.mocked(requireOfflineSpeechModels).mockResolvedValue(undefined);
  vi.mocked(prepareOfflineSpeechModels).mockResolvedValue(undefined);
  vi.mocked(offlineTranscribe).mockResolvedValue({ text: 'Hello', language: 'en' });
  vi.mocked(offlineTranslate).mockImplementation(async (_text, _target, _language, token) => { token('你好'); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('translation queue and lifecycle', () => {
  it('keeps recording and processes the next utterance after a translation output limit', async () => {
    vi.mocked(offlineTranslate).mockImplementationOnce(async (_text, _target, _language, token) => {
      token('部分内容'); throw new TranslationLimitError();
    });
    const { result } = renderHook(() => useTranslator({ ...settings(), provider: 'offline' }));
    await act(async () => { await result.current.start(); voice(); });
    await waitFor(() => expect(result.current.segments[0]?.status).toBe('error'));
    expect(result.current.recording).toBe(true);
    expect(stopMicrophone).not.toHaveBeenCalled();
    expect(result.current.segments[0].translation).toBe('部分内容');
    await act(async () => voice());
    await waitFor(() => expect(result.current.segments[1]?.status).toBe('done'));
    expect(result.current.recording).toBe(true);
  });
  it('uses Chinese context for a tiny interjection with unstable ASR language ID', async () => {
    vi.mocked(offlineTranscribe).mockResolvedValueOnce({ text: '今天天气很好。', language: 'zh' })
      .mockResolvedValueOnce({ text: '嗯。', language: 'ja' });
    const { result } = renderHook(() => useTranslator({ ...settings(), provider: 'offline', sourceLanguage: 'auto' }));
    await act(async () => { await result.current.start(); voice(); });
    await waitFor(() => expect(result.current.segments[0]?.status).toBe('done'));
    await act(async () => voice());
    await waitFor(() => expect(result.current.segments[1]?.status).toBe('done'));
    expect(result.current.segments.map(s => s.language)).toEqual(['zh', 'zh']);
    expect(vi.mocked(offlineTranslate).mock.calls[1][2]).toBe('zh');
  });
  it('detects each offline text input while the source setting stays automatic', async () => {
    const config = { ...settings(), provider: 'offline' as const, sourceLanguage: 'auto' };
    const { result } = renderHook(() => useTranslator(config));
    await act(async () => result.current.submitText('今天天气很好。'));
    await waitFor(() => expect(result.current.segments[0]?.status).toBe('done'));
    await act(async () => result.current.submitText('Hello, how are you?'));
    await waitFor(() => expect(result.current.segments[1]?.status).toBe('done'));
    expect(result.current.segments.map(s => s.language)).toEqual(['zh', 'en']);
    expect(vi.mocked(offlineTranslate).mock.calls.map(call => call[2])).toEqual(['zh', 'en']);
    expect(config.sourceLanguage).toBe('auto');
    expect(offlineTranscribe).not.toHaveBeenCalled();
    expect(startCapture).not.toHaveBeenCalled();
  });
  it('allows manually resolving an undetectable text before retrying', async () => {
    const initial = { ...settings(), provider: 'offline' as const, sourceLanguage: 'auto' };
    const { result, rerender } = renderHook(useTranslator, { initialProps: initial });
    await act(async () => result.current.submitText('12345'));
    await waitFor(() => expect(result.current.segments[0]?.status).toBe('error'));
    const failed = result.current.segments[0];
    expect(offlineTranslate).not.toHaveBeenCalled();
    rerender({ ...initial, sourceLanguage: 'en' });
    await act(async () => result.current.retry(failed));
    await waitFor(() => expect(result.current.segments[0]?.status).toBe('done'));
    expect(vi.mocked(offlineTranslate).mock.calls[0].slice(0, 3)).toEqual(['12345', 'zh', 'en']);
  });
  it('does not translate a language result arriving after cancellation', async () => {
    const detected = deferred<string>();
    vi.spyOn(textLanguage, 'resolveTextLanguage').mockReturnValueOnce(detected.promise);
    const { result } = renderHook(() => useTranslator({ ...settings(), sourceLanguage: 'auto' }));
    act(() => result.current.submitText('Hello, how are you?'));
    act(() => result.current.cancel());
    await act(async () => { detected.resolve('en'); await detected.promise; });
    expect(translate).not.toHaveBeenCalled();
    expect(result.current.segments[0].status).toBe('error');
  });
  it('marks an unfinished utterance failed when VAD flushing rejects', async () => {
    const create = vi.mocked(createVadSession).getMockImplementation()!;
    vi.mocked(createVadSession).mockImplementationOnce(async (...args) => ({
      ...await create(...args), stop: async () => { throw new Error('VAD 收尾超时'); },
    }));
    const { result } = renderHook(() => useTranslator(settings()));
    await act(async () => { await result.current.start(); voice(2, false); emitVad(false); });
    await waitFor(() => expect(result.current.segments[0]?.status).toBe('waiting'));
    await act(async () => { await result.current.stop(); });
    expect(result.current.recording).toBe(false);
    expect(result.current.segments[0]).toMatchObject({ status: 'error', finalized: false });
    act(() => result.current.retry(result.current.segments[0]));
    expect(translate).not.toHaveBeenCalled();
  });
  it('routes offline audio and translation exclusively to device engines', async () => {
    const { result } = renderHook(() => useTranslator({ ...settings(), provider: 'offline' }));
    await act(async () => { await result.current.start(); voice(); });
    await waitFor(() => expect(result.current.segments[0]?.status).toBe('done'));
    expect(result.current.segments[0].translation).toBe('你好');
    expect(offlineTranscribe).toHaveBeenCalledTimes(1);
    expect(offlineTranslate).toHaveBeenCalledTimes(1);
    expect(transcribe).not.toHaveBeenCalled();
    expect(translate).not.toHaveBeenCalled();
  });
  it('requires installed models before opening the microphone in offline mode', async () => {
    vi.mocked(requireOfflineSpeechModels).mockRejectedValue(new Error('请先下载模型'));
    const { result } = renderHook(() => useTranslator({ ...settings(), provider: 'offline' }));
    await act(async () => { await result.current.start(); });
    expect(startCapture).not.toHaveBeenCalled();
    expect(result.current.error).toContain('下载模型');
    expect(result.current.starting).toBe(false);
  });
  it('finishes warmup before opening the microphone', async () => {
    const prepared = deferred<void>();
    vi.mocked(prepareOfflineSpeechModels).mockReturnValue(prepared.promise);
    const { result } = renderHook(() => useTranslator({ ...settings(), provider: 'offline' }));
    let pending!: Promise<void>;
    act(() => { pending = result.current.start(); });
    await waitFor(() => expect(prepareOfflineSpeechModels).toHaveBeenCalledTimes(1));
    expect(startCapture).not.toHaveBeenCalled();
    expect(result.current.starting).toBe(true);
    await act(async () => { prepared.resolve(); await pending; });
    expect(startCapture).toHaveBeenCalledTimes(1);
    expect(result.current.recording).toBe(true);
  });
  it('cancels warmup without opening the microphone or showing a failure', async () => {
    vi.mocked(prepareOfflineSpeechModels).mockImplementation((_language, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    }));
    const { result } = renderHook(() => useTranslator({ ...settings(), provider: 'offline' }));
    let pending!: Promise<void>;
    act(() => { pending = result.current.start(); });
    await waitFor(() => expect(prepareOfflineSpeechModels).toHaveBeenCalledTimes(1));
    await act(async () => { result.current.cancel(); await pending; });
    expect(startCapture).not.toHaveBeenCalled();
    expect(result.current.starting).toBe(false);
    expect(result.current.error).toBe('');
  });
  it('does not open the microphone if warmup completes while the app is hidden', async () => {
    const prepared = deferred<void>();
    vi.mocked(prepareOfflineSpeechModels).mockReturnValue(prepared.promise);
    const { result } = renderHook(() => useTranslator({ ...settings(), provider: 'offline' }));
    let pending!: Promise<void>;
    act(() => { pending = result.current.start(); });
    await waitFor(() => expect(prepareOfflineSpeechModels).toHaveBeenCalledTimes(1));
    act(() => visibility(true));
    await act(async () => { prepared.resolve(); await pending; });
    expect(startCapture).not.toHaveBeenCalled();
    expect(result.current.starting).toBe(false);
  });
  it('obtains native permission before allocating models and does not warm up after denial', async () => {
    vi.mocked(requestCapturePermission).mockRejectedValueOnce(new Error('麦克风权限未开启'));
    const { result } = renderHook(() => useTranslator({ ...settings(), provider: 'offline' }));
    await act(async () => { await result.current.start(); });
    expect(prepareOfflineSpeechModels).not.toHaveBeenCalled();
    expect(startCapture).not.toHaveBeenCalled();
    expect(result.current.error).toContain('权限');
  });
  it('processes jobs in order and keeps each job’s configuration snapshot', async () => {
    const first = deferred<void>();
    vi.mocked(translate).mockImplementationOnce(async (_text, _target, _source, _endpoint, token) => {
      token('第一'); await first.promise; token('句');
    });
    const initial = settings();
    const { result, rerender } = renderHook(useTranslator, { initialProps: initial });
    act(() => { result.current.submitText('one'); result.current.submitText('two'); });
    await waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
    expect(translate).toHaveBeenCalledTimes(1);
    expect(result.current.segments.map(s => s.status)).toEqual(['translating', 'queued']);
    rerender({ ...initial, targetLanguage: 'ja' });
    await act(async () => { first.resolve(); await first.promise; });
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.segments.map(s => s.translation)).toEqual(['第一句', '译文：two']);
    expect(vi.mocked(translate).mock.calls[1][1]).toBe('zh');
  });

  it('submits the final short utterance exactly once when recording stops', async () => {
    const { result } = renderHook(() => useTranslator(settings()));
    await act(async () => { await result.current.start(); });
    act(() => voice(0.4, false));
    expect(transcribe).not.toHaveBeenCalled();
    await act(async () => { await result.current.stop(); await result.current.stop(); });
    await waitFor(() => expect(result.current.segments[0]?.status).toBe('done'));
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(stopMicrophone).toHaveBeenCalledTimes(1);
  });

  it('ignores empty ASR results instead of translating silence', async () => {
    vi.mocked(transcribe).mockResolvedValue({ text: '  ', language: 'unknown' });
    const { result } = renderHook(() => useTranslator(settings()));
    await act(async () => { await result.current.start(); voice(); });
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.segments).toHaveLength(0);
    expect(translate).not.toHaveBeenCalled();
  });
  it('waits for the actual VAD ending and translates complete sentences across safety windows', async () => {
    vi.mocked(transcribe)
      .mockResolvedValueOnce({ text: 'We should finish.', language: 'en' })
      .mockResolvedValueOnce({ text: 'the complete sentence. Then move on!', language: 'en' });
    const { result } = renderHook(() => useTranslator(settings()));
    await act(async () => { await result.current.start(); voice(2, false); emitVad(false); });
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(translate).not.toHaveBeenCalled();
    expect(result.current.segments[0].source).toBe('We should finish');
    expect(result.current.segments[0].status).toBe('waiting');
    await act(async () => voice());
    await waitFor(() => expect(result.current.segments[0].status).toBe('done'));
    expect(result.current.segments).toHaveLength(1);
    expect(result.current.segments[0].source).toBe('We should finish the complete sentence. Then move on!');
    expect(vi.mocked(translate).mock.calls.map(call => call[0])).toEqual(['We should finish the complete sentence.', 'Then move on!']);
  });
  it('finalizes buffered recognition on explicit stop without recognizing the same audio twice', async () => {
    const { result } = renderHook(() => useTranslator(settings()));
    await act(async () => { await result.current.start(); voice(2, false); emitVad(false); });
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(translate).not.toHaveBeenCalled();
    await act(async () => result.current.stop());
    await waitFor(() => expect(result.current.segments[0].status).toBe('done'));
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledTimes(1);
  });
  it('translates whole sentence units instead of commas or decimal fragments', async () => {
    const { result } = renderHook(() => useTranslator(settings()));
    await act(async () => result.current.submitText('Dr. Smith paid 3.14 dollars, then left. Thank you!'));
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(vi.mocked(translate).mock.calls.map(call => call[0])).toEqual(['Dr. Smith paid 3.14 dollars, then left.', 'Thank you!']);
    expect(result.current.segments).toHaveLength(1);
  });

  it('cancels active work, drops queued work and ignores late tokens', async () => {
    const active = deferred<void>();
    let token!: (text: string) => void;
    let signal!: AbortSignal;
    vi.mocked(translate).mockImplementationOnce(async (_text, _target, _source, _endpoint, onToken, abort) => {
      token = onToken; signal = abort; onToken('部分'); await active.promise; onToken('迟到');
    });
    const { result } = renderHook(() => useTranslator(settings()));
    act(() => { result.current.submitText('one'); result.current.submitText('two'); });
    await waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
    act(() => result.current.cancel());
    expect(signal.aborted).toBe(true);
    act(() => token('不能追加'));
    await act(async () => { active.resolve(); await active.promise; });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(result.current.segments.map(s => s.status)).toEqual(['error', 'error']);
    expect(result.current.segments[0].translation).toBe('部分');
    expect(result.current.busy).toBe(false);
  });

  it('retries with the originally detected source and original target language', async () => {
    vi.mocked(translate).mockRejectedValueOnce(new Error('temporary provider failure'));
    const initial = settings();
    const { result, rerender } = renderHook(useTranslator, { initialProps: initial });
    await act(async () => { await result.current.start(); voice(); });
    await waitFor(() => expect(result.current.busy).toBe(false));
    const failed = result.current.segments[0];
    expect(failed.language).toBe('en');
    rerender({ ...initial, sourceLanguage: 'ja', targetLanguage: 'fr' });
    await act(async () => result.current.retry(failed));
    await waitFor(() => expect(result.current.segments[0].status).toBe('done'));
    expect(vi.mocked(translate).mock.calls[1].slice(0, 3)).toEqual(['Hello', 'zh', 'en']);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('stops recording and marks remaining work unprocessed after ASR failure', async () => {
    const failure = deferred<{ text: string; language: string }>();
    vi.mocked(transcribe).mockReturnValueOnce(failure.promise);
    const { result } = renderHook(() => useTranslator(settings()));
    await act(async () => { await result.current.start(); });
    act(() => { voice(); voice(); });
    await act(async () => { failure.reject(new Error('ASR unavailable')); });
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.recording).toBe(false);
    expect(result.current.segments.map(s => s.status)).toEqual(['error', 'error']);
    expect(result.current.error).toContain('ASR unavailable');
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(translate).not.toHaveBeenCalled();
  });

  it('bounds the queue at eight pending utterances and stops capture on overflow', async () => {
    vi.mocked(transcribe).mockImplementation((_wav, _profile, _language, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    }));
    const { result } = renderHook(() => useTranslator(settings()));
    await act(async () => { await result.current.start(); });
    await act(async () => { for (let i = 0; i < 10; i++) voice(); });
    await waitFor(() => expect(result.current.recording).toBe(false));
    expect(result.current.segments).toHaveLength(9);
    expect(result.current.error).toContain('处理速度跟不上');
    expect(stopMicrophone).toHaveBeenCalledTimes(1);
    await act(async () => result.current.cancel());
  });

  it('does not start two captures when the start control is pressed twice', async () => {
    const permission = deferred<{ stop: typeof stopMicrophone }>();
    vi.mocked(startCapture).mockReturnValueOnce(permission.promise);
    const { result } = renderHook(() => useTranslator(settings()));
    let pending!: Promise<void>;
    act(() => { pending = result.current.start(); void result.current.start(); });
    await waitFor(() => expect(startCapture).toHaveBeenCalledTimes(1));
    await act(async () => { permission.resolve({ stop: stopMicrophone }); await pending; });
    expect(result.current.recording).toBe(true);
  });

  it('allows first recording after a permission dialog temporarily hides the app', async () => {
    const permission = deferred<{ stop: typeof stopMicrophone }>();
    vi.mocked(startCapture).mockReturnValueOnce(permission.promise);
    const { result } = renderHook(() => useTranslator(settings()));
    let pending!: Promise<void>;
    act(() => { pending = result.current.start(); visibility(true); visibility(false); });
    await act(async () => { permission.resolve({ stop: stopMicrophone }); await pending; });
    expect(result.current.recording).toBe(true);
    expect(stopMicrophone).not.toHaveBeenCalled();
  });

  it('releases a capture that finishes opening after unmount', async () => {
    const permission = deferred<{ stop: typeof stopMicrophone }>();
    vi.mocked(startCapture).mockReturnValueOnce(permission.promise);
    const { result, unmount } = renderHook(() => useTranslator(settings()));
    let pending!: Promise<void>;
    act(() => { pending = result.current.start(); });
    await waitFor(() => expect(startCapture).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => { permission.resolve({ stop: stopMicrophone }); await pending; });
    expect(stopMicrophone).toHaveBeenCalledTimes(1);
  });

  it('stops active capture on backgrounding and ignores subsequent native frames', async () => {
    const { result } = renderHook(() => useTranslator(settings()));
    await act(async () => { await result.current.start(); });
    await act(async () => visibility(true));
    act(() => voice());
    expect(result.current.recording).toBe(false);
    expect(stopMicrophone).toHaveBeenCalledTimes(1);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('recovers from microphone denial without leaving the start control locked', async () => {
    vi.mocked(startCapture).mockRejectedValueOnce(new Error('Permission denied'));
    const { result } = renderHook(() => useTranslator(settings()));
    await act(async () => { await result.current.start(); });
    expect(result.current.starting).toBe(false);
    expect(result.current.recording).toBe(false);
    expect(result.current.error).toContain('麦克风');
    await act(async () => { await result.current.start(); });
    expect(result.current.recording).toBe(true);
    expect(result.current.error).toBe('');
  });
});
