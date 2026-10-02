import { useCallback, useEffect, useRef, useState } from 'react';
import type { Segment, Settings } from '../types';
import { requestCapturePermission, startCapture, type Capture } from '../lib/capture';
import { createVadSession, type VadSession } from '../lib/vad';
import { friendlyError, transcribe, translate } from '../lib/api';
import { appendTranscriptText } from '../lib/transcript';
import { completeSentences, continuationText } from '../lib/sentences';
import { resolveTextLanguage } from '../lib/text-language';
import { inputLevel } from '../lib/input-level';
import { speechLanguage } from '../lib/speech-language';
import { TranslationLimitError } from '../offline/errors';
import { offlineTranscribe, offlineTranslate, prepareOfflineSpeechModels, releaseOfflineModels, requireOfflineSpeechModels } from '../offline/client';

interface Job { id: string; audio?: Uint8Array; text?: string; final: boolean; settings: Settings }
interface Utterance { source: string; language: string; closed: boolean; finalized: boolean }

export function useTranslator(settings: Settings) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);
  const [audioReceived, setAudioReceived] = useState(false);
  const [speechActive, setSpeechActive] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const capture = useRef<Capture>();
  const vad = useRef<VadSession>();
  const utterances = useRef(new Map<string, Utterance>());
  const lastSpeechLanguage = useRef<string>();
  const rejected = useRef(new Set<string>());
  const queue = useRef<Job[]>([]);
  const working = useRef(false);
  const controller = useRef<AbortController>();
  const startController = useRef<AbortController>();
  const generation = useRef(0);
  const mounted = useRef(true);
  const startingRef = useRef(false);
  const stoppingRef = useRef(false);
  const stopRef = useRef<() => Promise<void>>();
  const update = useCallback((id: string, patch: Partial<Segment>) => {
    if (mounted.current) setSegments(items => items.map(s => s.id === id ? { ...s, ...patch } : s));
  }, []);

  const drain = useCallback(async () => {
    if (working.current) return;
    working.current = true; setBusy(true);
    try {
      while (queue.current.length && mounted.current) {
        const job = queue.current.shift()!;
        if (rejected.current.has(job.id)) continue;
        const state = utterances.current.get(job.id);
        if (!state) continue;
        const config = job.settings, profile = config.provider === 'remote' ? config.remote : config.local;
        const started = performance.now();
        const abort = new AbortController(); controller.current = abort;
        try {
          if (job.audio) {
            update(job.id, { status: 'recognizing' });
            const result = config.provider === 'offline'
              ? await offlineTranscribe(job.audio, config.sourceLanguage, abort.signal, config.offline.lowMemory)
              : await transcribe(job.audio, profile, config.sourceLanguage, abort.signal);
            if (abort.signal.aborted || rejected.current.has(job.id)) continue;
            if (!state.source || ['auto', 'unknown'].includes(state.language)) {
              state.language = speechLanguage(result.text, result.language, config.sourceLanguage, lastSpeechLanguage.current);
            }
            if (result.text.trim() && !['auto', 'unknown'].includes(state.language)) lastSpeechLanguage.current = state.language;
            // A safety window is not an utterance ending; ASR may invent a full
            // stop there. Hold its final clause until real VAD completion.
            state.source = appendTranscriptText(state.source, job.final ? result.text : continuationText(result.text));
          }
          if (abort.signal.aborted) break;
          if (!job.final) {
            update(job.id, { source: state.source, language: state.language, status: 'waiting', finalized: false });
            continue;
          }
          state.finalized = true;
          const source = state.source.trim();
          if (!source) {
            setSegments(items => items.filter(s => s.id !== job.id));
            utterances.current.delete(job.id); continue;
          }
          if (job.text !== undefined && ['auto', 'unknown'].includes(state.language)) {
            update(job.id, { status: 'recognizing' });
            state.language = await resolveTextLanguage(source, state.language, abort.signal);
            if (abort.signal.aborted) break;
          }
          update(job.id, { source, language: state.language, status: 'translating', finalized: true, error: undefined });
          let translated = '';
          // Only finalized ASR text enters translation. Complete sentences are
          // sent one at a time, with no arbitrary time/character splitting.
          for (const sentence of completeSentences(source)) {
            if (abort.signal.aborted) break;
            const prefix = translated;
            let partial = '';
            const onToken = (token: string) => {
              if (abort.signal.aborted) return;
              partial += token;
              update(job.id, { translation: appendTranscriptText(prefix, partial) });
            };
            if (config.provider === 'offline') await offlineTranslate(sentence, config.targetLanguage, state.language, onToken, abort.signal, config.offline.lowMemory);
            else await translate(sentence, config.targetLanguage, state.language, profile.translation, onToken, abort.signal);
            translated = appendTranscriptText(prefix, partial);
          }
          if (!abort.signal.aborted) update(job.id, { status: 'done', latency: Math.round(performance.now() - started) });
          utterances.current.delete(job.id);
        } catch (error) {
          if (!abort.signal.aborted) {
            const message = friendlyError(error);
            rejected.current.add(job.id);
            update(job.id, { source: state.source, language: state.language, status: 'error', finalized: state.finalized, error: message });
            if (state.finalized && error instanceof TranslationLimitError) {
              // Preserve the partial result, then continue with the next
              // utterance. One bad generation must not turn off the microphone.
              utterances.current.delete(job.id);
              continue;
            }
            setError(message);
            if (capture.current) await stopRef.current?.();
            for (const pending of queue.current) {
              rejected.current.add(pending.id);
              update(pending.id, { status: 'error', error: '上一个请求失败，此句未完成处理。请检查配置后重试或重新录音。' });
            }
            queue.current = [];
            utterances.current.clear();
          }
          break;
        }
      }
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [update]);

  const enqueue = useCallback((data: { id?: string; audio?: Uint8Array; text?: string; final?: boolean }, config: Settings) => {
    if (!mounted.current) return;
    const id = data.id || crypto.randomUUID();
    if (rejected.current.has(id)) return;
    if (queue.current.length >= 8 && (data.audio || data.text)) {
      rejected.current.add(id);
      update(id, { status: 'error', finalized: false, error: '语音积压，本句未完整识别，请重新录制。' });
      setError('模型处理速度跟不上录音，已自动暂停。请等待现有句子完成。');
      void stopRef.current?.(); return;
    }
    const final = data.final ?? true;
    let state = utterances.current.get(id);
    if (!state) {
      if (!data.audio && data.text === undefined) return;
      state = { source: data.text || '', language: config.sourceLanguage, closed: final, finalized: data.text !== undefined };
      utterances.current.set(id, state);
      setSegments(items => [...items, { id, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), source: state!.source,
        translation: '', language: config.sourceLanguage === 'auto' ? 'unknown' : config.sourceLanguage,
        targetLanguage: config.targetLanguage, status: 'queued', finalized: state!.finalized }]);
    } else if (final) state.closed = true;
    queue.current.push({ ...data, id, final, settings: structuredClone(config) });
    void drain();
  }, [drain, update]);

  const stop = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    generation.current++; startController.current?.abort();
    const current = capture.current; capture.current = undefined;
    const processor = vad.current; vad.current = undefined;
    try {
      try { await current?.stop(); }
      finally { await processor?.stop(true); }
    } catch (error) {
      if (mounted.current) setError(friendlyError(error));
      for (const [id, item] of utterances.current) if (!item.closed) {
        rejected.current.add(id);
        update(id, { status: 'error', finalized: false, error: '录音收尾失败，本句未完整识别，请重新录制。' });
        utterances.current.delete(id);
      }
    }
    finally {
      if (mounted.current) { setRecording(false); setLevel(0); setSpeechActive(false); }
      stoppingRef.current = false;
    }
  }, [update]);
  stopRef.current = stop;

  const start = async () => {
    if (startingRef.current || stoppingRef.current || capture.current) return;
    startingRef.current = true; setStarting(true); setError('');
    setAudioReceived(false); setSpeechActive(false);
    const epoch = ++generation.current;
    const abort = new AbortController(); startController.current = abort;
    const config = structuredClone(settings);
    const session = crypto.randomUUID();
    let processor: VadSession | undefined;
    try {
      if (config.provider === 'offline') {
        if (!['auto', 'zh', 'en', 'ja', 'ko', 'yue'].includes(config.sourceLanguage)) {
          throw new Error('SenseVoice 语音输入支持中、英、日、韩、粤语；请切换为自动检测，或使用文字输入。');
        }
        await requireOfflineSpeechModels();
      }
      await requestCapturePermission(releaseOfflineModels);
      abort.signal.throwIfAborted();
      if (config.provider === 'offline') await prepareOfflineSpeechModels(config.sourceLanguage, abort.signal, config.offline.lowMemory);
      if (epoch !== generation.current || !mounted.current || document.hidden) return;
      processor = await createVadSession(config.vadSilenceSeconds,
        part => enqueue({ ...part, id: `${session}:${part.id}` }, config),
        message => {
          if (!mounted.current) return;
          setError(message);
          for (const [id, item] of utterances.current) if (id.startsWith(session + ':') && !item.closed) {
            rejected.current.add(id);
            update(id, { status: 'error', finalized: false, error: 'VAD 中断，本句未完整识别，请重新录制。' });
          }
          void stopRef.current?.();
        }, abort.signal, active => { if (mounted.current && epoch === generation.current) setSpeechActive(active); });
      if (epoch !== generation.current || !mounted.current || document.hidden) { await processor.stop(false); return; }
      vad.current = processor;
      const next = await startCapture(config.deviceId, (samples, rate) => {
        if (epoch !== generation.current) return;
        const rms = processor!.push(samples, rate);
        if (mounted.current) { setAudioReceived(true); setLevel(inputLevel(rms)); }
      }, message => { setError(message); void stopRef.current?.(); }, releaseOfflineModels);
      if (epoch !== generation.current || !mounted.current || document.hidden) {
        await next.stop(); await processor.stop(false); return;
      }
      capture.current = next; setRecording(true);
    } catch (error) {
      await processor?.stop(false);
      if (mounted.current && !abort.signal.aborted) setError(friendlyError(error));
    } finally {
      if (!capture.current && vad.current === processor) vad.current = undefined;
      startController.current = undefined; startingRef.current = false;
      if (mounted.current) setStarting(false);
    }
  };

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setSeconds(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    mounted.current = true;
    const visibility = () => { if (document.hidden && capture.current) void stopRef.current?.(); };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mounted.current = false; generation.current++;
      queue.current = []; controller.current?.abort(); startController.current?.abort();
      void capture.current?.stop(); capture.current = undefined;
      void vad.current?.stop(false); vad.current = undefined;
      utterances.current.clear();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  return {
    segments, recording, starting, busy, level, audioReceived, speechActive, seconds, error, setError, start, stop,
    submitText: (text: string) => { setError(''); enqueue({ text }, settings); },
    retry: (segment: Segment) => {
      if (!segment.source || segment.finalized === false) return;
      setError(''); rejected.current.delete(segment.id);
      const language = ['auto', 'unknown'].includes(segment.language) ? settings.sourceLanguage : segment.language;
      const config = { ...settings, sourceLanguage: language, targetLanguage: segment.targetLanguage };
      update(segment.id, { status: 'queued', translation: '', error: undefined });
      utterances.current.set(segment.id, { source: segment.source, language, closed: true, finalized: true });
      queue.current.push({ id: segment.id, text: segment.source, final: true, settings: structuredClone(config) }); void drain();
    },
    clear: () => {
      if (!working.current && !capture.current && !startingRef.current) {
        utterances.current.clear(); rejected.current.clear(); lastSpeechLanguage.current = undefined; setSegments([]); setSeconds(0); setError('');
      }
    },
    cancel: () => {
      if (startingRef.current) { generation.current++; startController.current?.abort(); }
      for (const id of utterances.current.keys()) rejected.current.add(id);
      utterances.current.clear(); queue.current = []; controller.current?.abort();
      setSegments(items => items.map(s => ['queued', 'recognizing', 'waiting', 'translating'].includes(s.status)
        ? { ...s, status: 'error', error: '已取消，可重新尝试。' } : s));
    },
  };
}
