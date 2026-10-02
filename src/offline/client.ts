import { useEffect, useSyncExternalStore } from 'react';
import { TOTAL_BYTES, sourceCode, translationLanguages, wavSamples, type Engine } from './catalog';
import type { CacheProgress } from './cache';
import { resolveTextLanguage } from '../lib/text-language';
import { TranslationLimitError } from './errors';

interface CacheStatus { bytes: number; asr: boolean; translation: boolean }
export interface OfflineState extends CacheStatus {
  operation: boolean; running: boolean; message: string; error: string;
  progress?: CacheProgress; loaded: Engine[];
  loadCounts: Record<Engine, number>;
}
let state: OfflineState = { bytes: 0, asr: false, translation: false, operation: false, running: false, message: '', error: '', loaded: [], loadCounts: { asr: 0, translation: 0 } };
const listeners = new Set<() => void>();
const update = (patch: Partial<OfflineState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => state;
export const getOfflineModelState = snapshot;

let storage: Worker | undefined;
const storageRequests = new Map<string, { resolve: (value: CacheStatus) => void; reject: (error: Error) => void }>();
function storageCall(action: string, extra: Record<string, unknown> = {}) {
  if (!storage) {
    storage = new Worker(new URL('./storage.worker.ts', import.meta.url), { type: 'module' });
    storage.onmessage = event => {
      const { id, progress, status, error, cancelled } = event.data;
      const request = storageRequests.get(id);
      if (!request) return;
      if (progress) { update({ progress, message: progress.message }); return; }
      storageRequests.delete(id);
      if (error) request.reject(new Error(cancelled ? '已暂停下载，可以继续。' : error));
      else { update(status); request.resolve(status); }
    };
    storage.onerror = event => {
      const error = new Error(event.message || '模型缓存不可用，请检查存储空间。');
      for (const request of storageRequests.values()) request.reject(error);
      storageRequests.clear(); storage?.terminate(); storage = undefined;
      update({ operation: false, error: error.message });
    };
  }
  const id = crypto.randomUUID();
  return new Promise<CacheStatus>((resolve, reject) => {
    storageRequests.set(id, { resolve, reject });
    storage!.postMessage({ id, action, ...extra });
  });
}
export async function refreshOfflineStatus() {
  try { return await storageCall('status'); }
  catch (error) { update({ error: String(error) }); throw error; }
}
export function useOfflineModels(enabled = true) {
  const value = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => { if (enabled) void refreshOfflineStatus().catch(() => {}); }, [enabled]);
  return value;
}
export async function manageModels(action: 'download' | 'import' | 'clear', files?: File[], baseUrl?: string) {
  if (state.operation || state.running) return;
  if (action === 'clear') releaseOfflineModels();
  update({ operation: true, error: '', progress: undefined, message: action === 'clear' ? '正在删除模型…' : '正在准备模型文件…' });
  try {
    if (action !== 'clear') await navigator.storage?.persist?.().catch(() => false);
    await storageCall(action, { files, baseUrl });
    update({ message: action === 'clear' ? '模型已删除' : '模型文件已保存，可离线使用' });
  } catch (error) {
    update({ error: error instanceof Error ? error.message : String(error), message: '' });
    await refreshOfflineStatus().catch(() => {});
  } finally { update({ operation: false, progress: undefined }); }
}
export function cancelModelDownload() { storage?.postMessage({ action: 'cancel' }); }

interface WorkerHandle { worker: Worker; language?: string; ready: boolean }
const engines = new Map<Engine, WorkerHandle>();
const tasks = new Map<string, { engine: Engine; reject: (error: Error) => void }>();
const loadedEngines = () => [...engines].filter(([, handle]) => handle.ready).map(([engine]) => engine);
function release(engine: Engine) {
  engines.get(engine)?.worker.terminate(); engines.delete(engine);
  for (const [id, task] of tasks) if (task.engine === engine) {
    task.reject(new DOMException('已取消离线推理', 'AbortError')); tasks.delete(id);
  }
  update({ loaded: loadedEngines() });
}
export function releaseOfflineModels() {
  release('asr'); release('translation');
  update({ loaded: [], running: false, message: '模型内存已释放，下载文件保留' });
}
async function infer<T>(engine: Engine, payload: Record<string, unknown>, signal: AbortSignal, lowMemory: boolean, onToken?: (value: string) => void): Promise<T> {
  signal.throwIfAborted();
  if (!engines.get(engine)?.ready) {
    const status = await refreshOfflineStatus();
    signal.throwIfAborted();
    if (!status[engine]) throw new Error('请先打开模型设置，下载或导入设备离线模型。');
  }
  if ([...tasks.values()].some(task => task.engine === engine)) throw new Error('模型正在处理上一个任务，请稍后再试。');
  if (lowMemory) release(engine === 'asr' ? 'translation' : 'asr');
  if (engine === 'asr' && engines.get(engine)?.language !== payload.language) release(engine);
  let handle = engines.get(engine);
  if (payload.prepare && handle?.ready) return true as T;
  if (!handle) {
    handle = { worker: new Worker(new URL('./inference.worker.ts', import.meta.url), { type: 'module' }), language: payload.language as string, ready: false };
    engines.set(engine, handle);
  }
  const worker = handle.worker;
  const id = crypto.randomUUID();
  const messageText = handle.ready
    ? engine === 'asr' ? '正在本机识别…' : '正在本机翻译…'
    : engine === 'asr' ? '正在加载 SenseVoice…' : '正在加载 Meta M2M100…';
  update({ running: true, error: '', message: messageText, loaded: loadedEngines() });
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error, result?: T) => {
      if (finished) return; finished = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      worker.removeEventListener('message', message); worker.removeEventListener('error', failed);
      tasks.delete(id);
      update({ running: tasks.size > 0, message: '', error: error?.name === 'AbortError' ? '' : error?.message || '', loaded: loadedEngines() });
      if (error) reject(error); else resolve(result as T);
    };
    const abort = () => release(engine);
    const timer = setTimeout(() => {
      finish(new Error('离线推理超时。可尝试更短的语音片段，或使用服务模式。'));
      release(engine);
    }, 180_000);
    const message = (event: MessageEvent) => {
      if (event.data.id !== id || finished) return;
      if (event.data.ready) {
        if (!handle.ready) update({ loadCounts: { ...state.loadCounts, [engine]: state.loadCounts[engine] + 1 } });
        handle.ready = true;
        update({ loaded: loadedEngines() });
        return;
      }
      if (event.data.progress) { update({ message: event.data.progress }); return; }
      if (event.data.token !== undefined) { if (!signal.aborted) onToken?.(event.data.token); return; }
      if (event.data.error) {
        const error = event.data.code === 'output_limit' ? new TranslationLimitError(event.data.error) : new Error(event.data.error);
        finish(error);
        if (!(error instanceof TranslationLimitError)) release(engine);
      } else finish(undefined, event.data.result);
    };
    const failed = (event: ErrorEvent) => {
      finish(new Error(event.message || 'WASM 模型无法运行，可能是设备内存不足。'));
      release(engine);
    };
    tasks.set(id, { engine, reject: error => finish(error) });
    signal.addEventListener('abort', abort, { once: true });
    worker.addEventListener('message', message); worker.addEventListener('error', failed);
    if (signal.aborted) { abort(); return; }
    const origin = new URL('/', window.location.href).href.replace(/\/$/, '');
    worker.postMessage({ id, action: engine, origin, ...payload }, payload.samples ? [(payload.samples as Float32Array).buffer] : []);
  });
}
export async function requireOfflineSpeechModels() {
  const status = await refreshOfflineStatus();
  if (!status.asr || !status.translation) throw new Error('请先在模型设置中下载 SenseVoice 和 Meta M2M100 离线模型。');
}
export async function prepareOfflineSpeechModels(language: string, signal: AbortSignal, lowMemory: boolean) {
  // Initialize the larger model first, before ASR contributes its resident
  // memory. Both sessions are retained in normal mode.
  if (!lowMemory) await infer('translation', { prepare: true }, signal, false);
  await infer('asr', { language: sourceCode(language), prepare: true }, signal, lowMemory);
}
export function offlineTranscribe(wav: Uint8Array, language: string, signal: AbortSignal, lowMemory: boolean) {
  return infer<{ text: string; language: string }>('asr', { samples: wavSamples(wav), language: sourceCode(language) }, signal, lowMemory);
}
export async function offlineTranslate(text: string, target: string, language: string, onToken: (value: string) => void, signal: AbortSignal, lowMemory: boolean) {
  if ([...text].length > 500) throw new Error('离线翻译每段最多 500 字，请将长文字分段输入。');
  const source = await resolveTextLanguage(text, language, signal);
  translationLanguages(source, target);
  await infer('translation', { text, target, language: source }, signal, lowMemory, onToken);
}
export { TOTAL_BYTES };
