export type Provider = 'offline' | 'local' | 'remote';
export type AsrProtocol = 'whisper' | 'openai';
export interface Endpoint { url: string; model: string; apiKey: string }
export interface Profile { asr: Endpoint; translation: Endpoint; asrProtocol: AsrProtocol }
export interface Settings {
  provider: Provider;
  local: Profile;
  remote: Profile;
  offline: { lowMemory: boolean; downloadBaseUrl: string };
  sourceLanguage: string;
  targetLanguage: string;
  deviceId: string;
  vadSilenceSeconds: number;
  autoScroll: boolean;
}
export type SegmentStatus = 'queued' | 'recognizing' | 'waiting' | 'translating' | 'done' | 'error';
export interface Segment {
  id: string;
  time: string;
  source: string;
  translation: string;
  language: string;
  targetLanguage: string;
  status: SegmentStatus;
  error?: string;
  latency?: number;
  finalized?: boolean;
}
export const LANGUAGES = [
  { code: 'zh', name: '简体中文', native: '中文', label: 'Chinese' },
  { code: 'en', name: '英语', native: 'English', label: 'English' },
  { code: 'ja', name: '日语', native: '日本語', label: 'Japanese' },
  { code: 'ko', name: '韩语', native: '한국어', label: 'Korean' },
  { code: 'fr', name: '法语', native: 'Français', label: 'French' },
  { code: 'de', name: '德语', native: 'Deutsch', label: 'German' },
  { code: 'es', name: '西班牙语', native: 'Español', label: 'Spanish' },
  { code: 'pt', name: '葡萄牙语', native: 'Português', label: 'Portuguese' },
  { code: 'ru', name: '俄语', native: 'Русский', label: 'Russian' },
  { code: 'ar', name: '阿拉伯语', native: 'العربية', label: 'Arabic' },
  { code: 'it', name: '意大利语', native: 'Italiano', label: 'Italian' },
  { code: 'hi', name: '印地语', native: 'हिन्दी', label: 'Hindi' },
] as const;
export function languageName(code: string) {
  if (code === 'yue' || code.toLowerCase() === 'cantonese') return '粤语';
  if (code === 'auto') return '自动检测';
  if (!code || code === 'unknown') return '待检测';
  return LANGUAGES.find(l => l.code === code || l.label.toLowerCase() === code.toLowerCase())?.name ?? code;
}
