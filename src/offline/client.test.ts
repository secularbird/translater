// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeWav } from '../lib/audio';

interface Request { id: string; action: string; prepare?: boolean; language?: string; target?: string; text?: string }
class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  static hold = false;
  readonly storage: boolean;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: Request[] = [];
  terminated = false;
  constructor(url: URL) {
    super(); this.storage = String(url).includes('storage.worker'); FakeWorker.instances.push(this);
  }
  postMessage(request: Request) {
    this.requests.push(request);
    queueMicrotask(() => {
      if (this.terminated || (FakeWorker.hold && !this.storage)) return;
      if (this.storage) { this.reply({ id: request.id, status: { bytes: 880000000, asr: true, translation: true } }); return; }
      const passthrough = request.action === 'translation' && !request.prepare && request.language === request.target;
      if (!passthrough) this.reply({ id: request.id, ready: true });
      if (request.action === 'translation' && !request.prepare) this.reply({ id: request.id, token: passthrough ? request.text : '你好' });
      this.reply({ id: request.id, result: request.action === 'asr' && !request.prepare ? { text: 'Hello', language: 'en' } : true });
    });
  }
  reply(data: unknown) {
    const event = new MessageEvent('message', { data });
    this.onmessage?.(event); this.dispatchEvent(event);
  }
  terminate() { this.terminated = true; }
}

let client: typeof import('./client');
const wav = () => encodeWav(new Float32Array(3200));
const signal = () => new AbortController().signal;
const inferenceWorkers = () => FakeWorker.instances.filter(worker => !worker.storage);
beforeEach(async () => {
  vi.resetModules();
  FakeWorker.instances = []; FakeWorker.hold = false;
  vi.stubGlobal('Worker', FakeWorker);
  client = await import('./client');
});
afterEach(() => { client.releaseOfflineModels(); vi.unstubAllGlobals(); });

describe('resident offline engines', () => {
  it('keeps a healthy translation session after an output-limit error', async () => {
    await client.prepareOfflineSpeechModels('auto', signal(), false);
    FakeWorker.hold = true;
    const pending = client.offlineTranslate('First.', 'zh', 'en', () => {}, signal(), false);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TranslationLimitError' });
    const worker = inferenceWorkers().find(w => w.requests[0].action === 'translation')!;
    await vi.waitFor(() => expect(worker.requests.at(-1)?.text).toBe('First.'));
    worker.reply({ id: worker.requests.at(-1)!.id, error: 'output limit', code: 'output_limit' });
    await rejected;
    expect(worker.terminated).toBe(false);
    FakeWorker.hold = false;
    await client.offlineTranslate('Second.', 'zh', 'en', () => {}, signal(), false);
    expect(client.getOfflineModelState().loadCounts).toEqual({ asr: 1, translation: 1 });
  });
  it('resolves automatic text language without creating an ASR worker', async () => {
    await client.offlineTranslate('今天天气很好。', 'en', 'auto', () => {}, signal(), false);
    expect(inferenceWorkers()).toHaveLength(1);
    expect(inferenceWorkers()[0].requests[0]).toMatchObject({ action: 'translation', language: 'zh', target: 'en' });
    expect(client.getOfflineModelState().loadCounts).toEqual({ asr: 0, translation: 1 });
  });
  it('keeps the same two models for alternating recognition/translation and repeated starts', async () => {
    await client.prepareOfflineSpeechModels('auto', signal(), false);
    expect(client.getOfflineModelState().loaded).toEqual(expect.arrayContaining(['asr', 'translation']));
    for (let i = 0; i < 3; i++) {
      await client.offlineTranscribe(wav(), 'auto', signal(), false);
      await client.offlineTranslate('Hello', 'zh', 'en', () => {}, signal(), false);
    }
    const requestCounts = inferenceWorkers().map(worker => worker.requests.length);
    await client.prepareOfflineSpeechModels('auto', signal(), false);
    expect(inferenceWorkers()).toHaveLength(2);
    expect(inferenceWorkers().every(worker => !worker.terminated)).toBe(true);
    expect(inferenceWorkers().map(worker => worker.requests.length)).toEqual(requestCounts);
    expect(client.getOfflineModelState().loadCounts).toEqual({ asr: 1, translation: 1 });
  });
  it('still unloads the other model when the user explicitly selects low-memory mode', async () => {
    await client.offlineTranscribe(wav(), 'auto', signal(), true);
    await client.offlineTranslate('Hello', 'zh', 'en', () => {}, signal(), true);
    await client.offlineTranscribe(wav(), 'auto', signal(), true);
    expect(inferenceWorkers()).toHaveLength(3);
    expect(inferenceWorkers().slice(0, 2).every(worker => worker.terminated)).toBe(true);
    expect(client.getOfflineModelState().loaded).toEqual(['asr']);
    expect(client.getOfflineModelState().loadCounts).toEqual({ asr: 2, translation: 1 });
  });
  it('reports a model loaded only after receiving its initialization acknowledgement', async () => {
    FakeWorker.hold = true;
    const pending = client.prepareOfflineSpeechModels('auto', signal(), true);
    await vi.waitFor(() => expect(inferenceWorkers()).toHaveLength(1));
    expect(client.getOfflineModelState().loaded).toEqual([]);
    const worker = inferenceWorkers()[0];
    const id = worker.requests[0].id;
    worker.reply({ id, ready: true });
    expect(client.getOfflineModelState().loaded).toEqual(['asr']);
    worker.reply({ id, result: true });
    await pending;
  });
  it('terminates a cancelled initialization and leaves no ready model behind', async () => {
    FakeWorker.hold = true;
    const abort = new AbortController();
    const pending = client.prepareOfflineSpeechModels('auto', abort.signal, false);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(inferenceWorkers()).toHaveLength(1));
    abort.abort();
    await rejection;
    expect(inferenceWorkers()[0].terminated).toBe(true);
    expect(client.getOfflineModelState().loaded).toEqual([]);
    expect(client.getOfflineModelState().running).toBe(false);
  });
  it('reinitializes only after an explicit release', async () => {
    await client.prepareOfflineSpeechModels('auto', signal(), false);
    client.releaseOfflineModels();
    expect(client.getOfflineModelState().loaded).toEqual([]);
    await client.prepareOfflineSpeechModels('auto', signal(), false);
    expect(client.getOfflineModelState().loadCounts).toEqual({ asr: 2, translation: 2 });
  });
  it('does not claim a model is loaded for same-language passthrough', async () => {
    const token = vi.fn();
    await client.offlineTranslate('Hello', 'en', 'en', token, signal(), false);
    expect(token).toHaveBeenCalledWith('Hello');
    expect(client.getOfflineModelState().loaded).toEqual([]);
    expect(client.getOfflineModelState().loadCounts.translation).toBe(0);
  });
  it('keeps a healthy resident model when input validation fails', async () => {
    await client.prepareOfflineSpeechModels('auto', signal(), false);
    await expect(client.offlineTranslate('x'.repeat(501), 'zh', 'en', () => {}, signal(), false)).rejects.toThrow('500');
    expect(inferenceWorkers().every(worker => !worker.terminated)).toBe(true);
    expect(client.getOfflineModelState().loadCounts).toEqual({ asr: 1, translation: 1 });
  });
});
