import { copyFile, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'public/licenses'), { recursive: true });
await copyFile(path.join(root, 'node_modules/tinyld/license'), path.join(root, 'public/licenses/tinyld.txt'));
const destination = path.join(root, 'public/wasm/ort');
await mkdir(destination, { recursive: true });
for (const name of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']) {
  await copyFile(path.join(root, 'node_modules/onnxruntime-web/dist', name), path.join(destination, name));
}
try {
  await access(path.join(root, 'public/wasm/sherpa/sherpa.wasm'));
  await access(path.join(root, 'public/wasm/sherpa/silero_vad.onnx'));
  await access(path.join(root, 'public/wasm/sherpa/vad.mjs'));
} catch {
  throw new Error('SenseVoice WASM runtime is missing. Run npm run models:setup first.');
}
