import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { cachedBlob, cacheStatus, clearModels, downloadModels, importModels } from './cache';

const CHUNK = 2 * 1024 * 1024;
const LARGE = CHUNK + 13;
vi.mock('./catalog', () => ({
  MODEL_ASSETS: [
    { id: 'sense/hello.onnx', engine: 'asr', file: 'hello.onnx', revision: 'fixed', size: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' },
    { id: 'm2m/large.onnx', engine: 'translation', file: 'large.onnx', revision: 'fixed', size: 2097165, sha256: null },
  ],
  assetUrl: (asset: { file: string }) => `https://fixture.invalid/${asset.file}`,
}));
const signal = () => new AbortController().signal;
beforeAll(() => { vi.stubGlobal('indexedDB', indexedDB); vi.stubGlobal('IDBKeyRange', IDBKeyRange); });
beforeEach(async () => { await clearModels(); });
afterAll(() => { vi.unstubAllGlobals(); });

describe('persistent model cache', () => {
  it('writes and reloads both engines without any second network request', async () => {
    const fetch = vi.fn(async (url: string) => new Response(url.endsWith('hello.onnx') ? 'hello' : new Uint8Array(LARGE).fill(7)));
    vi.stubGlobal('fetch', fetch);
    await downloadModels(() => {}, signal());
    expect(await cacheStatus()).toEqual({ bytes: LARGE + 5, asr: true, translation: true });
    expect(await (await cachedBlob('sense/hello.onnx')).text()).toBe('hello');
    expect((await cachedBlob('m2m/large.onnx')).size).toBe(LARGE);
    await downloadModels(() => {}, signal());
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('retains completed chunks after cancel and resumes from the correct byte', async () => {
    const abort = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('hello.onnx')) return new Response('hello');
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(CHUNK).fill(7)); } }));
    }));
    await expect(downloadModels(progress => {
      if (progress.file === 'large.onnx' && progress.loaded >= CHUNK) abort.abort();
    }, abort.signal)).rejects.toThrow();
    expect(await cacheStatus()).toEqual({ bytes: CHUNK + 5, asr: true, translation: false });
    const fetch = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.headers).toEqual({ Range: `bytes=${CHUNK}-` });
      return new Response(new Uint8Array(13).fill(7), { status: 206 });
    });
    vi.stubGlobal('fetch', fetch);
    await downloadModels(() => {}, signal());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await cacheStatus()).translation).toBe(true);
    expect(new Uint8Array(await (await cachedBlob('m2m/large.onnx')).arrayBuffer()).every(n => n === 7)).toBe(true);
  });
  it('discards corrupted weights instead of marking the model installed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('wrong')));
    await expect(downloadModels(() => {}, signal())).rejects.toThrow('校验失败');
    expect(await cacheStatus()).toEqual({ bytes: 0, asr: false, translation: false });
    await expect(cachedBlob('sense/hello.onnx')).rejects.toThrow('未下载完整');
  });
  it('rejects oversized responses without leaving an unusable resume offset', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('hello with unexpected extra bytes')));
    await expect(downloadModels(() => {}, signal())).rejects.toThrow('大小不符合');
    expect((await cacheStatus()).bytes).toBe(0);
  });
  it('imports selected files and refuses mismatched files before overwriting the cache', async () => {
    const file = { name: 'hello.onnx', size: 5, stream: () => new Blob(['hello']).stream() } as File;
    await importModels([file], () => {}, signal());
    expect((await cacheStatus()).asr).toBe(true);
    await expect(importModels([{ ...file, size: 4 } as File], () => {}, signal())).rejects.toThrow('大小不匹配');
    expect(await (await cachedBlob('sense/hello.onnx')).text()).toBe('hello');
    await clearModels();
    expect((await cacheStatus()).bytes).toBe(0);
  });
});
