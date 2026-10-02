import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcribe, translate } from './api';
import { DEFAULT_SETTINGS, endpointUrl, loadSettings, saveSettings } from './settings';
import { encodeWav } from './audio';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));
afterEach(() => vi.unstubAllGlobals());
const profile = DEFAULT_SETTINGS.local;
const signal = () => new AbortController().signal;
describe('model adapters', () => {
  it('sends a WAV multipart request and preserves the actual detected language', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ text: ' Hello world. ', language: 'english' }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await transcribe(encodeWav(new Float32Array(3200)), profile, 'auto', signal());
    expect(result).toEqual({ text: 'Hello world.', language: 'english' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8080/inference');
    expect(options.body.get('language')).toBe('auto');
    expect(options.body.get('file').type).toBe('audio/wav');
  });
  it('reports unknown detection rather than inventing a language', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ text: 'Bonjour' })));
    const result = await transcribe(encodeWav(new Float32Array(3200)), DEFAULT_SETTINGS.remote, 'auto', signal());
    expect(result.language).toBe('unknown');
  });
  it('streams tokens and surfaces incomplete responses instead of marking them done', async () => {
    const data = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(data, { headers: { 'content-type': 'text/event-stream' } })));
    const tokens: string[] = [];
    await expect(translate('Hello', 'zh', 'en', profile.translation, t => tokens.push(t), signal())).rejects.toThrow('连接中断');
    expect(tokens).toEqual(['你好']);
  });
  it('accepts completed streams and non-streaming compatible providers', async () => {
    const data = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(data, { headers: { 'content-type': 'text/event-stream' } })));
    const tokens: string[] = [];
    await translate('Hello', 'zh', 'en', profile.translation, t => tokens.push(t), signal());
    expect(tokens.join('')).toBe('你好');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: '你好' } }] })));
    await translate('Hello', 'zh', 'en', profile.translation, t => tokens.push(t), signal());
    expect(tokens).toEqual(['你好', '你好']);
  });
  it('surfaces authentication and provider failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { message: 'Invalid API key' } }, { status: 401 })));
    await expect(translate('Hello', 'zh', 'en', profile.translation, () => {}, signal())).rejects.toThrow('401：Invalid API key');
  });
});

describe('settings persistence', () => {
  it('never persists API keys and survives damaged storage', () => {
    let storage = '';
    vi.stubGlobal('localStorage', { setItem: (_: string, value: string) => { storage = value; }, getItem: () => storage });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.remote.asr.apiKey = 'secret-asr'; settings.local.translation.apiKey = 'secret-translation';
    settings.targetLanguage = 'ja';
    saveSettings(settings);
    expect(storage).not.toContain('secret');
    expect(loadSettings().targetLanguage).toBe('ja');
    expect(loadSettings().remote.asr.apiKey).toBe('');
    storage = '{';
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
  it('joins endpoint paths and rejects credentials and unsupported schemes', () => {
    expect(endpointUrl('http://localhost:11434/v1/', '/chat/completions')).toBe('http://localhost:11434/v1/chat/completions');
    expect(() => endpointUrl('file:///tmp/model', 'models')).toThrow();
    expect(() => endpointUrl('https://user:password@example.com', 'models')).toThrow();
  });
});
