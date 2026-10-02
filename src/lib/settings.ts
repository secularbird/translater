import type { Settings } from '../types';

export const DEFAULT_SETTINGS: Settings = {
  provider: 'offline',
  offline: { lowMemory: false, downloadBaseUrl: '' },
  local: {
    asrProtocol: 'whisper',
    asr: { url: 'http://127.0.0.1:8080', model: 'whisper-large-v3-turbo', apiKey: '' },
    translation: { url: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', apiKey: '' },
  },
  remote: {
    asrProtocol: 'openai',
    asr: { url: 'https://api.openai.com/v1', model: 'whisper-1', apiKey: '' },
    translation: { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '' },
  },
  sourceLanguage: 'auto', targetLanguage: 'zh', deviceId: '', vadSilenceSeconds: 0.8, autoScroll: true,
};
const KEY = 'sonora.settings.v1';
export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!saved) return structuredClone(DEFAULT_SETTINGS);
    // Explicitly select fields; API keys are deliberately never persisted.
    const result = structuredClone(DEFAULT_SETTINGS);
    for (const mode of ['local', 'remote'] as const) {
      for (const kind of ['asr', 'translation'] as const) {
        for (const field of ['url', 'model'] as const) {
          if (typeof saved[mode]?.[kind]?.[field] === 'string') result[mode][kind][field] = saved[mode][kind][field];
        }
      }
      if (['whisper', 'openai'].includes(saved[mode]?.asrProtocol)) result[mode].asrProtocol = saved[mode].asrProtocol;
    }
    if (['offline', 'local', 'remote'].includes(saved.provider)) result.provider = saved.provider;
    if (typeof saved.offline?.lowMemory === 'boolean') result.offline.lowMemory = saved.offline.lowMemory;
    if (typeof saved.offline?.downloadBaseUrl === 'string') result.offline.downloadBaseUrl = saved.offline.downloadBaseUrl;
    // Move only the untouched legacy localhost preset to the new offline default.
    if (!saved.version && saved.provider === 'local'
      && saved.local?.asr?.url === DEFAULT_SETTINGS.local.asr.url
      && saved.local?.translation?.url === DEFAULT_SETTINGS.local.translation.url
      && saved.local?.translation?.model === DEFAULT_SETTINGS.local.translation.model) result.provider = 'offline';
    for (const field of ['sourceLanguage', 'targetLanguage', 'deviceId'] as const) {
      if (typeof saved[field] === 'string') result[field] = saved[field];
    }
    if ([0.5, 0.8, 1.2, 1.6].includes(saved.vadSilenceSeconds)) result.vadSilenceSeconds = saved.vadSilenceSeconds;
    if (typeof saved.autoScroll === 'boolean') result.autoScroll = saved.autoScroll;
    return result;
  } catch { return structuredClone(DEFAULT_SETTINGS); }
}
export function saveSettings(settings: Settings) {
  const safe = structuredClone(settings);
  safe.local.asr.apiKey = safe.local.translation.apiKey = '';
  safe.remote.asr.apiKey = safe.remote.translation.apiKey = '';
  localStorage.setItem(KEY, JSON.stringify({ ...safe, version: 2 }));
}
export function endpointUrl(base: string, path: string): string {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址需要是 HTTP(S) 基础地址，不能包含密码、查询参数或锚点。');
  }
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
