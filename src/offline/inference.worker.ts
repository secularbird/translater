import { cachedBlob } from './cache';
import { MODEL_ASSETS, sourceCode, translationLanguages } from './catalog';
import { env, pipeline, TextStreamer } from '@huggingface/transformers';
import { TranslationLimitError } from './errors';

// All executable code is bundled. Models come exclusively from IndexedDB.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false;
env.useFSCache = false;
env.useCustomCache = true;
env.customCache = {
  match: async (key: string) => {
    const marker = 'Xenova/m2m100_418M/';
    const suffix = key.slice(key.indexOf(marker) + marker.length).replace(/^resolve\/[^/]+\//, '');
    const asset = MODEL_ASSETS.find(asset => asset.engine === 'translation' && asset.file === suffix);
    if (!asset) return undefined;
    return new Response(await cachedBlob(asset.id));
  },
  put: async () => {},
};
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
}

interface SherpaStream { acceptWaveform: (rate: number, samples: Float32Array) => void; free: () => void }
interface Recognizer {
  handle: number;
  createStream: () => SherpaStream;
  decode: (stream: SherpaStream) => void;
  getResult: (stream: SherpaStream) => { text: string; lang?: string; event?: string };
}
interface SherpaModule {
  FS_createDataFile: (parent: string, name: string, data: Uint8Array, read: boolean, write: boolean, own: boolean) => void;
  sonoraUnlink: (path: string) => void;
}
let recognizer: Recognizer | undefined;
let asrLanguage = '';
// Narrow the library's large pipeline overload union at the model boundary.
type Translator = ((text: string, options: Record<string, unknown>) => Promise<{ translation_text: string }[]>)
  & { tokenizer: ConstructorParameters<typeof TextStreamer>[0] };
const createTranslation = pipeline as unknown as (task: 'translation', model: string, options: Record<string, unknown>) => Promise<Translator>;
let translator: Translator | undefined;
let busy = false;

async function loadAsr(origin: string, language: string) {
  if (recognizer && asrLanguage === language) return;
  const [model, tokens, wasm, runtime, api] = await Promise.all([
    cachedBlob('sense/model.int8.onnx').then(blob => blob.arrayBuffer()),
    cachedBlob('sense/tokens.txt').then(blob => blob.arrayBuffer()),
    fetch(`${origin}/wasm/sherpa/sherpa.wasm`).then(r => { if (!r.ok) throw new Error('SenseVoice WASM 文件缺失'); return r.arrayBuffer(); }),
    import(/* @vite-ignore */ `${origin}/wasm/sherpa/runtime.mjs`),
    import(/* @vite-ignore */ `${origin}/wasm/sherpa/recognizer.mjs`),
  ]);
  let module: SherpaModule;
  const options = {
    wasmBinary: wasm,
    print: () => {}, printErr: (text: string) => console.warn(text),
    preRun: [(instance: SherpaModule) => {
      instance.FS_createDataFile('/', 'sense-voice.onnx', new Uint8Array(model), true, false, true);
      instance.FS_createDataFile('/', 'tokens.txt', new Uint8Array(tokens), true, false, true);
    }],
  };
  module = await runtime.default(options);
  recognizer = new api.OfflineRecognizer({
    modelConfig: {
      tokens: '/tokens.txt', numThreads: 1, debug: 0,
      senseVoice: { model: '/sense-voice.onnx', language, useInverseTextNormalization: 1 },
    },
  }, module);
  if (!recognizer?.handle) throw new Error('SenseVoice 初始化失败，请检查模型文件或可用内存。');
  module.sonoraUnlink('/sense-voice.onnx');
  module.sonoraUnlink('/tokens.txt');
  asrLanguage = language;
}
async function loadTranslation(origin: string) {
  if (translator) return;
  if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = `${origin}/wasm/ort/`;
  const memoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const smallMobile = /Android|iPhone|iPad/i.test(navigator.userAgent) && (memoryGB === undefined || memoryGB <= 4);
  translator = await createTranslation('translation', 'Xenova/m2m100_418M', {
    device: 'wasm', dtype: 'q8', local_files_only: true,
    session_options: {
      enableCpuMemArena: false, enableMemPattern: false,
      // The merged decoder has two subgraphs. Avoid extra packed-weight
      // buffers on memory-constrained mobile WebViews while keeping sessions.
      extra: smallMobile ? { session: { disable_prepacking: '1' } } : undefined,
    },
  });
}
self.onmessage = async (event: MessageEvent<{
  id: string; action: 'asr' | 'translation'; origin: string;
  language?: string; samples?: Float32Array; text?: string; target?: string; prepare?: boolean;
}>) => {
  const { id, action, origin } = event.data;
  if (busy) { self.postMessage({ id, error: '模型正在处理上一个片段。' }); return; }
  busy = true;
  const progress = (message: string) => self.postMessage({ id, progress: message });
  try {
    if (action === 'asr') {
      const language = sourceCode(event.data.language || 'auto');
      if (!['auto', 'zh', 'en', 'ja', 'ko', 'yue'].includes(language)) throw new Error('SenseVoice 支持普通话、粤语、英语、日语和韩语。');
      if (!recognizer || asrLanguage !== language) progress('正在加载 SenseVoice…');
      await loadAsr(origin, language);
      self.postMessage({ id, ready: true });
      if (event.data.prepare) { self.postMessage({ id, result: true }); return; }
      progress('正在本机识别…');
      const stream = recognizer!.createStream();
      try {
        stream.acceptWaveform(16000, event.data.samples!);
        recognizer!.decode(stream);
        const result = recognizer!.getResult(stream);
        self.postMessage({ id, result: { text: result.text.trim(), language: sourceCode(result.lang || language) } });
      } finally { stream.free(); }
    } else {
      if (event.data.prepare) {
        if (!translator) progress('正在加载 Meta M2M100…');
        await loadTranslation(origin);
        self.postMessage({ id, ready: true });
        self.postMessage({ id, result: true });
        return;
      }
      const text = event.data.text || '';
      if ([...text].length > 500) throw new Error('离线翻译每段最多 500 字，请将长文字分段输入。');
      const languages = translationLanguages(event.data.language || 'auto', event.data.target!);
      if (languages.src_lang === languages.tgt_lang) {
        self.postMessage({ id, token: text }); self.postMessage({ id, result: true }); return;
      }
      if (!translator) progress('正在加载 Meta M2M100…');
      await loadTranslation(origin);
      self.postMessage({ id, ready: true });
      progress('正在本机翻译…');
      let content = '';
      let lastToken: bigint | undefined;
      const streamer = new TextStreamer(translator!.tokenizer, {
        skip_prompt: true, skip_special_tokens: true,
        callback_function: (token: string) => { content += token; self.postMessage({ id, token }); },
      });
      const put = streamer.put.bind(streamer);
      streamer.put = tokens => { lastToken = tokens[0]?.at(-1); put(tokens); };
      const result = await translator!(text, { ...languages, max_new_tokens: 192, num_beams: 1, do_sample: false, streamer });
      const output = (Array.isArray(result) ? result[0] : result) as { translation_text: string };
      if (!content && output.translation_text) self.postMessage({ id, token: output.translation_text });
      if (!output.translation_text?.trim()) throw new Error('离线模型未生成译文。');
      if (lastToken !== 2n) throw new TranslationLimitError();
      self.postMessage({ id, result: true });
    }
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error), code: error instanceof TranslationLimitError ? 'output_limit' : undefined });
  } finally { busy = false; }
};
