import { StreamingResampler } from './audio';
import type { VadSegment } from './vad-endpoint';

export interface VadSession {
  push(samples: Float32Array, rate: number): number;
  stop(flush?: boolean): Promise<void>;
}
export function createVadSession(silenceSeconds: number, onSegment: (segment: VadSegment) => void,
  onError: (message: string) => void, signal: AbortSignal, onSpeech?: (active: boolean) => void): Promise<VadSession> {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./vad.worker.ts', import.meta.url), { type: 'module' });
  const resampler = new StreamingResampler();
  let queuedSamples = 0, ready = false, closed = false;
  let finish: (() => void) | undefined;
  let failFinish: ((error: Error) => void) | undefined;
  let stopPromise: Promise<void> | undefined;
  return new Promise((resolve, reject) => {
    const dispose = () => { closed = true; clearTimeout(timer); signal.removeEventListener('abort', abort); worker.terminate(); };
    const fail = (message: string) => {
      if (closed) return;
      const error = new Error(message);
      dispose();
      if (!ready) reject(error); else { failFinish?.(error); onError(message); }
    };
    const abort = () => { dispose(); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => fail('VAD 初始化超时，请重试。'), 30000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = event => fail(event.message || '语音活动检测异常，请重新开始录音。');
    worker.onmessage = event => {
      if (closed) return;
      const data = event.data;
      if (data.type === 'ready') {
        ready = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        resolve({
          push: (samples, rate) => {
            if (!samples.length) return 0;
            const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
            if (closed || stopPromise) return 0;
            const pcm = resampler.push(samples, rate);
            queuedSamples += pcm.length;
            if (queuedSamples > 16000 * 5) { fail('VAD 处理跟不上录音，已暂停，请重新开始。'); return rms; }
            worker.postMessage({ action: 'audio', samples: pcm }, [pcm.buffer]);
            return rms;
          },
          stop: (flush = true) => {
            if (stopPromise) return stopPromise;
            if (closed || !flush) { dispose(); return Promise.resolve(); }
            stopPromise = new Promise<void>((yes, no) => {
              let timeout: ReturnType<typeof setTimeout>;
              const check = () => {
                if (document.hidden) { timeout = setTimeout(check, 10000); return; }
                dispose(); no(new Error('VAD 收尾超时'));
              };
              timeout = setTimeout(check, 10000);
              finish = () => { clearTimeout(timeout); dispose(); yes(); };
              failFinish = error => { clearTimeout(timeout); no(error); };
              worker.postMessage({ action: 'finish' });
            });
            return stopPromise;
          },
        });
      } else if (data.type === 'segment') onSegment(data.segment);
      else if (data.type === 'processed') {
        queuedSamples = Math.max(0, queuedSamples - data.samples);
        onSpeech?.(data.speech === true);
      }
      else if (data.type === 'finished') finish?.();
      else if (data.type === 'error') fail(data.message);
    };
    if (signal.aborted) { abort(); return; }
    worker.postMessage({ action: 'init', silenceSeconds, origin: new URL('/', location.href).href.replace(/\/$/, '') });
  });
}
