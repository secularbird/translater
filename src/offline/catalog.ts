import manifest from './assets.json';
import { LANGUAGES } from '../types';

export type Engine = 'asr' | 'translation';
export interface ModelAsset {
  id: string; engine: string; repo: string; revision: string; file: string; size: number; sha256: string | null;
}
export const MODEL_ASSETS: ModelAsset[] = manifest;
export const TOTAL_BYTES = MODEL_ASSETS.reduce((sum, file) => sum + file.size, 0);
export const OFFLINE_SOURCE_LANGUAGES = [
  ...LANGUAGES.map(l => ({ ...l, name: ['zh', 'en', 'ja', 'ko'].includes(l.code) ? l.name : `${l.name}（仅文字）` })),
  { code: 'yue', name: '粤语', native: '粤语', label: 'Cantonese' },
];
export function assetUrl(asset: ModelAsset) {
  return `https://huggingface.co/${asset.repo}/resolve/${asset.revision}/${asset.file}`;
}
export function sourceCode(value: string) {
  const clean = value.replace(/^<\||\|>$/g, '').toLowerCase();
  const aliases: Record<string, string> = { chinese: 'zh', mandarin: 'zh', english: 'en', japanese: 'ja', korean: 'ko', cantonese: 'yue' };
  return aliases[clean] || clean;
}
export function translationLanguages(source: string, target: string) {
  let src = sourceCode(source);
  if (src === 'yue') src = 'zh';
  if (src === 'auto' || src === 'unknown') throw new Error('尚未确定原文语言，请重试自动检测或手动选择原文语言。');
  if (!LANGUAGES.some(l => l.code === src)) throw new Error(`当前离线翻译暂不支持此原文语言（${src}），可切换为服务模式。`);
  if (!LANGUAGES.some(l => l.code === target)) throw new Error('当前离线翻译模型不支持此目标语言。');
  return { src_lang: src, tgt_lang: target };
}
export function wavSamples(wav: Uint8Array) {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  if (wav.length < 44 || new TextDecoder().decode(wav.subarray(0, 4)) !== 'RIFF' || view.getUint32(24, true) !== 16000 || view.getUint16(22, true) !== 1 || view.getUint16(34, true) !== 16) {
    throw new Error('离线识别需要 16 kHz 单声道 PCM WAV。');
  }
  return Float32Array.from({ length: (wav.length - 44) / 2 }, (_, i) => view.getInt16(44 + i * 2, true) / 32768);
}
