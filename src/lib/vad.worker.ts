import { VadEndpoint, type VadDetector } from './vad-endpoint';

interface Runtime {
  FS_createDataFile(parent: string, name: string, data: Uint8Array, read: boolean, write: boolean, own: boolean): void;
  sonoraUnlink(path: string): void;
}
let endpoint: VadEndpoint;
let detector: VadDetector & { handle: number; free(): void };
let pending = new Float32Array(512);
let used = 0;
const scope = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void };
self.onmessage = async (event: MessageEvent<{ action: string; origin?: string; silenceSeconds?: number; samples?: Float32Array }>) => {
  try {
    if (event.data.action === 'init') {
      const base = event.data.origin + '/wasm/sherpa/';
      const [wasm, model, runtime, api] = await Promise.all([
        fetch(base + 'sherpa.wasm').then(r => { if (!r.ok) throw new Error('VAD WASM 文件缺失'); return r.arrayBuffer(); }),
        fetch(base + 'silero_vad.onnx').then(r => { if (!r.ok) throw new Error('VAD 模型文件缺失'); return r.arrayBuffer(); }),
        import(/* @vite-ignore */ base + 'runtime.mjs'),
        import(/* @vite-ignore */ base + 'vad.mjs'),
      ]);
      const module: Runtime = await runtime.default({
        wasmBinary: wasm, print: () => {}, printErr: (message: string) => console.warn(message),
        preRun: [(instance: Runtime) => instance.FS_createDataFile('/', 'silero_vad.onnx', new Uint8Array(model), true, false, true)],
      });
      detector = api.createVad(module, {
        sileroVad: { model: '/silero_vad.onnx', threshold: 0.5, minSpeechDuration: 0.2,
          minSilenceDuration: event.data.silenceSeconds || 0.8, windowSize: 512, maxSpeechDuration: 3600 },
        sampleRate: 16000, numThreads: 1, debug: 0, provider: 'cpu', bufferSizeInSeconds: 30,
      });
      if (!detector.handle) throw new Error('无法初始化 Silero VAD');
      module.sonoraUnlink('/silero_vad.onnx');
      endpoint = new VadEndpoint(detector, event.data.silenceSeconds || 0.8,
        segment => scope.postMessage({ type: 'segment', segment }, segment.audio ? [segment.audio.buffer as ArrayBuffer] : []));
      self.postMessage({ type: 'ready' });
    } else if (event.data.action === 'audio') {
      const samples = event.data.samples!;
      let offset = 0;
      while (offset < samples.length) {
        const count = Math.min(512 - used, samples.length - offset);
        pending.set(samples.subarray(offset, offset + count), used);
        used += count; offset += count;
        if (used === 512) { endpoint.push(pending); pending = new Float32Array(512); used = 0; }
      }
      self.postMessage({ type: 'processed', samples: samples.length, speech: detector.isDetected() });
    } else if (event.data.action === 'finish') {
      if (used) endpoint.push(pending);
      endpoint.finish(); detector.free();
      self.postMessage({ type: 'finished' });
    }
  } catch (error) { self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
};
