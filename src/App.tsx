import { useEffect, useState } from 'react';
import {
  ArrowLeft, ArrowLeftRight, Check, ChevronDown, Copy, History,
  Keyboard, Loader2, Mic, Save, Send, Settings2, Square, Trash2, X,
} from 'lucide-react';
import { LANGUAGES, languageName, type Segment, type Settings } from './types';
import { loadSettings, saveSettings } from './lib/settings';
import { devices, isNativeMobile } from './lib/capture';
import { useTranslator } from './hooks/useTranslator';
import { useViewportSize } from './hooks/useViewportSize';
import SettingsDialog from './components/SettingsDialog';
import { useOfflineModels } from './offline/client';
import { OFFLINE_SOURCE_LANGUAGES } from './offline/catalog';
import ContinuousTranscript from './components/ContinuousTranscript';
import { sessionText } from './lib/transcript';

interface SavedSession { id: string; date: string; segments: Segment[] }
const HISTORY_KEY = 'sonora.history.v1';

function loadHistory(): SavedSession[] {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(value)
      ? value.filter(s => typeof s.id === 'string' && Array.isArray(s.segments)).slice(0, 20)
      : [];
  } catch { return []; }
}

function time(value: number) {
  return `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
}

async function copyText(text: string) {
  if (navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); return; }
    catch { /* Older WebViews use the fallback below. */ }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('当前系统不支持自动复制，请手动选择文字复制。');
}

export default function App() {
  useViewportSize();
  const [settings, setSettings] = useState(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [page, setPage] = useState<'live' | 'history'>('live');
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [textOpen, setTextOpen] = useState(false);
  const [text, setText] = useState('');
  const [toast, setToast] = useState('');
  const [history, setHistory] = useState(loadHistory);
  const [selectedSession, setSelectedSession] = useState<string>();
  const translator = useTranslator(settings);
  const offline = useOfflineModels(settings.provider === 'offline');
  const locked = translator.recording || translator.starting || translator.busy;
  const segments = page === 'live'
    ? translator.segments
    : history.find(h => h.id === selectedSession)?.segments || [];
  const latestLanguage = [...translator.segments].reverse()
    .find(s => s.language !== 'unknown' && s.language !== 'auto')?.language;

  const refreshDevices = () => { void devices().then(setInputDevices).catch(() => {}); };
  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
  }, []);
  useEffect(() => { if (translator.recording) refreshDevices(); }, [translator.recording]);
  useEffect(() => {
    try { saveSettings(settings); }
    catch { setToast('设置无法写入本地存储，本次运行仍可使用。'); }
  }, [settings]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const change = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings(s => ({ ...s, [key]: value }));
  };
  const copy = (value: string) => {
    void copyText(value).then(() => setToast('已复制')).catch(e => setToast(String(e)));
  };
  const saveSession = () => {
    const next = [{
      id: crypto.randomUUID(),
      date: new Date().toLocaleString('zh-CN', { hour12: false }),
      segments: translator.segments,
    }, ...history].slice(0, 20);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      setHistory(next);
      setToast('会话已保存');
    } catch { setToast('存储空间不足，未能保存会话。'); }
  };
  const deleteSession = (id: string) => {
    const next = history.filter(h => h.id !== id);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      setHistory(next);
      if (selectedSession === id) setSelectedSession(next[0]?.id);
    } catch { setToast('未能删除记录，请检查本地存储权限。'); }
  };
  const submit = () => {
    if (!text.trim()) return;
    translator.submitText(text.trim());
    setText('');
    setTextOpen(false);
    setPage('live');
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-title">
          {page === 'history' && (
            <button className="icon-button" aria-label="实时翻译" onClick={() => setPage('live')}>
              <ArrowLeft size={21} />
            </button>
          )}
          <h1>{page === 'live' ? '声桥' : '历史记录'}</h1>
        </div>
        <nav className="header-actions" aria-label="主导航">
          {page === 'live' && <div className="session-actions">
            <button className="icon-button" aria-label="保存会话" title="保存会话" disabled={locked || !segments.length} onClick={saveSession}><Save size={18} /></button>
            <button className="icon-button" aria-label="清空会话" title="清空会话" disabled={locked || !segments.length} onClick={translator.clear}><Trash2 size={18} /></button>
          </div>}
          {page === 'live' && (
            <button className="icon-button" aria-label="历史记录" title="历史记录" onClick={() => {
              setPage('history');
              setSelectedSession(history[0]?.id);
            }}><History size={21} /></button>
          )}
          <button className="icon-button" aria-label="模型设置" title="模型设置" disabled={locked} onClick={() => setSettingsOpen(true)}>
            <Settings2 size={21} />
          </button>
        </nav>
      </header>

      {page === 'live' ? (
        <main className={`live-workspace${textOpen ? ' composing' : ''}`}>
          <section className="language-bar" aria-label="翻译语言选择">
            <div className="language-select">
              <label htmlFor="source-language">我说的语言</label>
              <div className="select-wrapper">
                <select id="source-language" disabled={locked} value={settings.sourceLanguage} onChange={e => change('sourceLanguage', e.target.value)}>
                  <option value="auto">自动检测</option>
                  {(settings.provider === 'offline' ? OFFLINE_SOURCE_LANGUAGES : LANGUAGES).map(l => <option value={l.code} key={l.code}>{l.name}</option>)}
                </select>
                <ChevronDown size={16} />
              </div>
            </div>
            <button className="swap-button" aria-label="交换源语言和目标语言"
              title={settings.sourceLanguage === 'auto' ? '请选择源语言后交换' : '交换语言'}
              disabled={locked || settings.sourceLanguage === 'auto'}
              onClick={() => setSettings(s => ({ ...s, sourceLanguage: s.targetLanguage, targetLanguage: s.sourceLanguage }))}>
              <ArrowLeftRight size={19} />
            </button>
            <div className="language-select">
              <label htmlFor="target-language">翻译为</label>
              <div className="select-wrapper">
                <select id="target-language" disabled={locked} value={settings.targetLanguage} onChange={e => change('targetLanguage', e.target.value)}>
                  {LANGUAGES.map(l => <option value={l.code} key={l.code}>{l.name}</option>)}
                </select>
                <ChevronDown size={16} />
              </div>
            </div>
          </section>

          <section className="transcript-panel" aria-label="实时会话">
            <h2 className="sr-only">实时会话</h2>
            <ContinuousTranscript segments={segments} recording={translator.recording} preparing={translator.starting} autoScroll={settings.autoScroll} onCopy={copy} onRetry={translator.retry} busy={locked} />
            <div className="transcript-footer">
              <span>{latestLanguage ? `已识别：${languageName(latestLanguage)}` : settings.sourceLanguage === 'auto' ? '等待语言检测' : `源语言：${languageName(settings.sourceLanguage)}`}</span>
              <button onClick={() => change('autoScroll', !settings.autoScroll)} aria-pressed={settings.autoScroll}>
                {settings.autoScroll && <Check size={12} />}自动跟随
              </button>
            </div>
          </section>

          {translator.error && (
            <div className="error-banner" role="alert">
              <p>{translator.error}</p>
              <div>
                <button className="text-button" disabled={locked} onClick={() => setSettingsOpen(true)}>检查设置</button>
                <button className="icon-button" aria-label="关闭错误提示" onClick={() => translator.setError('')}><X size={17} /></button>
              </div>
            </div>
          )}

          {textOpen && (
            <form className="text-composer" onSubmit={e => { e.preventDefault(); submit(); }}>
              <div className="composer-heading">
                <label htmlFor="text-input">输入一句话，测试翻译模型</label>
                <button className="icon-button" type="button" aria-label="关闭文字输入" onClick={() => setTextOpen(false)}><X size={17} /></button>
              </div>
              <div className="composer-input">
                <textarea id="text-input" autoFocus value={text} maxLength={6000}
                  onChange={e => setText(e.target.value)} placeholder="输入要翻译的文字…" rows={2} />
                <button className="primary-button" type="submit" disabled={!text.trim() || translator.busy}><Send size={17} />翻译</button>
              </div>
            </form>
          )}

          <section className="recording-controls" aria-label="录音控制">
            <div className="recording-actions">
              <button className={`aux-button ${textOpen ? 'selected' : ''}`} title="文字输入" aria-label="文字输入"
                disabled={translator.recording || translator.starting}
                onClick={() => setTextOpen(!textOpen)} aria-expanded={textOpen}>
                <Keyboard size={23} />
              </button>
              <button className={`record-button ${translator.recording ? 'stop' : ''}`}
                disabled={translator.starting || (translator.busy && !translator.recording)}
                onClick={() => { if (translator.recording) void translator.stop(); else if (settings.provider === 'offline' && (!offline.asr || !offline.translation)) setSettingsOpen(true); else { setTextOpen(false); void translator.start(); } }}
                aria-label={translator.starting ? '开启麦克风' : translator.recording ? '结束录音' : translator.busy ? '正在处理' : '开始翻译'}>
                {translator.starting || (translator.busy && !translator.recording)
                  ? <Loader2 size={26} className="spin" />
                  : translator.recording ? <Square size={22} fill="currentColor" /> : <Mic size={28} strokeWidth={1.7} />}
              </button>
              <div className="control-balance" aria-hidden="true">
                {translator.recording && <div className="input-meter" data-level={translator.level.toFixed(2)}>{[0.5, 0.8, 1, 0.65, 0.4].map((scale, i) => (
                  <i key={i} style={{ height: `${4 + translator.level * scale * 24}px` }} />
                ))}</div>}
              </div>
            </div>
            <div className="recording-status" role="status">
              {translator.recording ? <><span className="live-dot" />{!translator.audioReceived ? '等待音频输入' : translator.speechActive ? '收到语音 · 等待停顿' : '正在聆听'}<span className="session-clock">{time(translator.seconds)}</span></>
                : translator.starting ? <>{settings.provider === 'offline' && offline.running ? offline.message : '正在开启麦克风…'}<button className="text-button" onClick={translator.cancel}>取消启动</button></>
                : translator.busy ? <>{settings.provider === 'offline' ? offline.message || '正在本机翻译' : '正在翻译'}<button className="text-button" onClick={translator.cancel}>取消处理</button></>
                : '点击开始翻译'}
            </div>
            {settings.provider === 'offline' && <button className="offline-indicator" disabled={locked} onClick={() => setSettingsOpen(true)}>{offline.operation ? offline.message : `设备离线 · ${settings.offline.lowMemory && offline.asr && offline.translation ? '低内存模式' : offline.loaded.length === 2 ? '双模型已常驻' : offline.loaded.length === 1 ? `${offline.loaded[0] === 'asr' ? '识别' : '翻译'}模型已常驻` : offline.asr && offline.translation ? '首次录音将预热' : '请先下载模型'}`}</button>}
            {!isNativeMobile() && (
              <div className="device-select select-wrapper">
                <label className="sr-only" htmlFor="input-device">音频输入</label>
                <select id="input-device" value={settings.deviceId} disabled={locked} onChange={e => change('deviceId', e.target.value)}>
                  <option value="">系统默认麦克风</option>
                  {inputDevices.filter(d => d.deviceId && d.deviceId !== 'default').map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || `麦克风 ${i + 1}`}</option>
                  ))}
                </select>
                <ChevronDown size={12} />
              </div>
            )}
          </section>
        </main>
      ) : (
        <main className="history-workspace">
          <section className="history-layout">
            <div className="history-list">
              <h2>已保存的会话 <span>{history.length}</span></h2>
              {history.length ? history.map(session => (
                <div key={session.id} className={`history-item ${selectedSession === session.id ? 'selected' : ''}`}>
                  <button onClick={() => setSelectedSession(session.id)}>
                    <span>{session.date}</span>
                    <strong>{session.segments.find(s => s.source)?.source || '语音会话'}</strong>
                  </button>
                  <button className="icon-button" aria-label="删除此会话" onClick={() => deleteSession(session.id)}><Trash2 size={17} /></button>
                </div>
              )) : <p className="history-empty">还没有保存的对话。<br />完成翻译后，点击保存图标即可。</p>}
            </div>
            <div className="history-detail">
              <div className="panel-toolbar">
                <h2>会话内容</h2>
                <button className="text-button" disabled={!segments.length}
                  onClick={() => copy(sessionText(segments))}>
                  <Copy size={16} />复制全部
                </button>
              </div>
              {segments.length ? <ContinuousTranscript key={selectedSession} segments={segments} onCopy={copy} />
                : <p className="history-placeholder">选择一条记录查看</p>}
            </div>
          </section>
        </main>
      )}

      {settingsOpen && <SettingsDialog settings={settings} onSave={setSettings} onClose={() => setSettingsOpen(false)} />}
      {toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}
    </div>
  );
}
