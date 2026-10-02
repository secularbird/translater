import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { MODEL_ASSETS, assetUrl, type ModelAsset } from './catalog';

const DATABASE = 'sonora-offline-models-v1';
const CHUNK_SIZE = 2 * 1024 * 1024;
interface FileRecord { id: string; revision: string; downloaded: number; chunks: number; complete: boolean }
export interface CacheProgress { file: string; loaded: number; total: number; message: string }
type Progress = (value: CacheProgress) => void;
let connection: Promise<IDBDatabase> | undefined;

function database() {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('files', { keyPath: 'id' });
      request.result.createObjectStore('chunks');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { connection = undefined; reject(request.error); };
  });
  return connection;
}
function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function committed(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('模型存储失败，请检查剩余空间。'));
  });
}
async function record(asset: ModelAsset): Promise<FileRecord | undefined> {
  const db = await database();
  const found = await result<FileRecord | undefined>(db.transaction('files').objectStore('files').get(asset.id));
  if (found?.revision !== asset.revision) return undefined;
  return found;
}
async function saveChunk(asset: ModelAsset, state: FileRecord, data: Uint8Array) {
  const db = await database();
  const tx = db.transaction(['files', 'chunks'], 'readwrite');
  const done = committed(tx);
  tx.objectStore('chunks').put(new Blob([data as BlobPart]), `${asset.id}:${state.chunks}`);
  state.chunks++;
  state.downloaded += data.length;
  tx.objectStore('files').put({ ...state });
  await done;
}
async function reset(asset: ModelAsset) {
  const db = await database();
  const tx = db.transaction(['files', 'chunks'], 'readwrite');
  const done = committed(tx);
  tx.objectStore('files').delete(asset.id);
  tx.objectStore('chunks').delete(IDBKeyRange.bound(`${asset.id}:`, `${asset.id}:\uffff`));
  await done;
}
export async function cachedBlob(id: string): Promise<Blob> {
  const asset = MODEL_ASSETS.find(file => file.id === id);
  if (!asset) throw new Error(`未知模型文件：${id}`);
  const state = await record(asset);
  if (!state?.complete || state.downloaded !== asset.size) throw new Error(`模型未下载完整：${asset.file}。请在模型设置中下载或导入。`);
  const db = await database();
  const store = db.transaction('chunks').objectStore('chunks');
  const chunks = await Promise.all(Array.from({ length: state.chunks }, (_, i) => result<Blob>(store.get(`${id}:${i}`))));
  if (chunks.some(chunk => !chunk)) throw new Error('模型缓存缺失，请删除后重新下载。');
  const blob = new Blob(chunks);
  if (blob.size !== asset.size) throw new Error('模型缓存大小异常，请删除后重新下载。');
  return blob;
}
export async function cacheStatus() {
  const files = await Promise.all(MODEL_ASSETS.map(async asset => ({ asset, state: await record(asset) })));
  return {
    bytes: files.reduce((total, file) => total + (file.state?.downloaded || 0), 0),
    asr: files.filter(f => f.asset.engine === 'asr').every(f => f.state?.complete && f.state.downloaded === f.asset.size),
    translation: files.filter(f => f.asset.engine === 'translation').every(f => f.state?.complete && f.state.downloaded === f.asset.size),
  };
}
async function storeStream(asset: ModelAsset, stream: ReadableStream<Uint8Array>, state: FileRecord,
  hash: ReturnType<typeof sha256.create>, progress: Progress, signal: AbortSignal) {
  const reader = stream.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let buffer = new Uint8Array(CHUNK_SIZE), used = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (state.downloaded + used + value.length > asset.size) {
        await reset(asset);
        throw new Error(`模型文件大小不符合预期：${asset.file}`);
      }
      hash.update(value);
      let offset = 0;
      while (offset < value.length) {
        const length = Math.min(value.length - offset, CHUNK_SIZE - used);
        buffer.set(value.subarray(offset, offset + length), used);
        used += length; offset += length;
        if (used === CHUNK_SIZE) {
          await saveChunk(asset, state, buffer);
          buffer = new Uint8Array(CHUNK_SIZE); used = 0;
        }
      }
      progress({ file: asset.file, loaded: state.downloaded + used, total: asset.size, message: '下载并保存模型' });
    }
    if (state.downloaded + used !== asset.size) throw new Error(`模型下载不完整：${asset.file}，可以继续下载。`);
    if (used) await saveChunk(asset, state, buffer.subarray(0, used));
    if (asset.sha256 && bytesToHex(hash.digest()) !== asset.sha256) {
      await reset(asset);
      throw new Error(`模型校验失败：${asset.file}，请重新下载。`);
    }
    state.complete = true;
    const db = await database();
    const tx = db.transaction('files', 'readwrite');
    const done = committed(tx);
    tx.objectStore('files').put(state);
    await done;
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function downloadModels(progress: Progress, signal: AbortSignal, baseUrl = '') {
  for (const asset of MODEL_ASSETS) {
    signal.throwIfAborted();
    let state = await record(asset);
    if (state?.complete) continue;
    let hash = sha256.create();
    if (state?.downloaded) {
      progress({ file: asset.file, loaded: state.downloaded, total: asset.size, message: '检查断点数据' });
      const db = await database();
      for (let i = 0; i < state.chunks; i++) {
        signal.throwIfAborted();
        const chunk = await result<Blob>(db.transaction('chunks').objectStore('chunks').get(`${asset.id}:${i}`));
        if (!chunk) { await reset(asset); state = undefined; hash = sha256.create(); break; }
        hash.update(new Uint8Array(await chunk.arrayBuffer()));
      }
    }
    if (state?.downloaded === asset.size) {
      if (asset.sha256 && bytesToHex(hash.digest()) !== asset.sha256) { await reset(asset); throw new Error(`模型校验失败：${asset.file}`); }
      const db = await database();
      const tx = db.transaction('files', 'readwrite');
      const done = committed(tx);
      tx.objectStore('files').put({ ...state, complete: true });
      await done;
      continue;
    }
    if (!state) await reset(asset);
    const url = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/${asset.id}` : assetUrl(asset);
    const response = await fetch(url, {
      headers: state?.downloaded ? { Range: `bytes=${state.downloaded}-` } : undefined, signal,
    });
    if (!response.ok || !response.body) throw new Error(`下载失败（${response.status}）：${asset.file}。可重试或导入文件。`);
    const range = response.headers.get('Content-Range');
    if (response.status === 206 && range && !range.startsWith(`bytes ${state?.downloaded || 0}-`)) {
      await response.body.cancel();
      throw new Error(`服务器返回了错误的续传范围：${asset.file}。请检查镜像地址。`);
    }
    if (state?.downloaded && response.status !== 206) { await reset(asset); state = undefined; hash = sha256.create(); }
    state ??= { id: asset.id, revision: asset.revision, downloaded: 0, chunks: 0, complete: false };
    await storeStream(asset, response.body, state, hash, progress, signal);
  }
}
export async function importModels(files: File[], progress: Progress, signal: AbortSignal) {
  for (const file of files) {
    signal.throwIfAborted();
    const asset = MODEL_ASSETS.find(asset => asset.file.split('/').at(-1) === file.name);
    if (!asset) throw new Error(`不支持的模型文件：${file.name}。请选择模型清单中的文件。`);
    if (file.size !== asset.size) throw new Error(`文件版本或大小不匹配：${file.name}`);
    const installed = await record(asset);
    if (installed?.complete && installed.downloaded === asset.size) continue;
    await reset(asset);
    await storeStream(asset, file.stream(), { id: asset.id, revision: asset.revision, downloaded: 0, chunks: 0, complete: false }, sha256.create(), progress, signal);
  }
}
export async function clearModels() {
  const db = await database();
  const tx = db.transaction(['files', 'chunks'], 'readwrite');
  const done = committed(tx);
  tx.objectStore('files').clear(); tx.objectStore('chunks').clear();
  await done;
}
