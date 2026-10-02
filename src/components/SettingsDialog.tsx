import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Cloud, Cpu, Eye, EyeOff, Loader2, X } from 'lucide-react';
import type { Endpoint, Profile, Provider, Settings } from '../types';
import { endpointUrl } from '../lib/settings';
import { friendlyError, probe } from '../lib/api';
import OfflineModels from './OfflineModels';
import { useOfflineModels } from '../offline/client';

export default function SettingsDialog({ settings, onSave, onClose }: {
  settings: Settings; onSave: (value: Settings) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [showKeys, setShowKeys] = useState(false);
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string }>();
  useEffect(() => { dialog.current?.showModal(); }, []);
  const mode = draft.provider, serviceMode = mode === 'offline' ? 'local' : mode, profile = draft[serviceMode];
  const offlineState = useOfflineModels(mode === 'offline');
  const switchMode = (provider: Provider) => { setDraft(d => ({ ...d, provider })); setFeedback(undefined); };
  const patch = (kind: 'asr' | 'translation', key: keyof Endpoint, value: string) => {
    setDraft(d => ({ ...d, [serviceMode]: { ...d[serviceMode], [kind]: { ...d[serviceMode][kind], [key]: value } } }));
    setFeedback(undefined);
  };
  const validate = () => {
    if (mode === 'offline') {
      if (draft.offline.downloadBaseUrl) endpointUrl(draft.offline.downloadBaseUrl, '');
      return;
    }
    endpointUrl(profile.asr.url, ''); endpointUrl(profile.translation.url, '');
    if (!profile.asr.model.trim() || !profile.translation.model.trim()) throw new Error('请填写语音识别和翻译模型的名称。');
  };
  const save = () => {
    try {
      validate();
      onSave(draft); onClose();
    }
    catch (error) { setFeedback({ ok: false, text: friendlyError(error) }); }
  };
  const test = async () => {
    setChecking(true); setFeedback(undefined);
    try { validate(); setFeedback({ ok: true, text: await probe(profile) }); }
    catch (error) { setFeedback({ ok: false, text: friendlyError(error) }); }
    finally { setChecking(false); }
  };
  return <dialog ref={dialog} className="settings-dialog" onCancel={onClose} onClick={e => { if (e.target === dialog.current) onClose(); }}>
    <div className="dialog-content">
      <header className="dialog-header"><h2>模型设置</h2><button className="icon-button" onClick={onClose} aria-label="关闭设置"><X size={21} /></button></header>
      <div className="provider-tabs"><button className={mode === 'offline' ? 'selected' : ''} onClick={() => switchMode('offline')} disabled={checking || offlineState.operation}><Cpu size={17} />设备离线</button><button className={mode === 'local' ? 'selected' : ''} onClick={() => switchMode('local')} disabled={checking || offlineState.operation}>本地服务</button><button className={mode === 'remote' ? 'selected' : ''} onClick={() => switchMode('remote')} disabled={checking || offlineState.operation}><Cloud size={17} />远程 API</button></div>
      {mode === 'offline' ? <OfflineModels config={draft.offline} onChange={offline => setDraft(d => ({ ...d, offline }))} /> : <>
      <p className="dialog-description">{mode === 'local' ? '连接本机或局域网的 whisper.cpp / Ollama 服务。音频只会发送到你配置的地址。' : '兼容 OpenAI 格式的语音与聊天接口，可分别指定服务商。'}</p>
      <fieldset disabled={checking}>
        <div className="setting-section-title"><h3>语音识别</h3></div>
        <label className="field">接口协议<select value={profile.asrProtocol} onChange={e => setDraft(d => ({ ...d, [serviceMode]: { ...d[serviceMode], asrProtocol: e.target.value as Profile['asrProtocol'] } }))}><option value="whisper">whisper.cpp · /inference</option><option value="openai">OpenAI 兼容 · /audio/transcriptions</option></select></label>
        <label className="field">服务基础地址<input type="url" value={profile.asr.url} onChange={e => patch('asr', 'url', e.target.value)} placeholder="http://127.0.0.1:8080" spellCheck={false} /></label>
        <div className="fields-row"><label className="field">模型名称<input value={profile.asr.model} onChange={e => patch('asr', 'model', e.target.value)} spellCheck={false} /></label><label className="field">API Key <span className="optional">可选</span><input type={showKeys ? 'text' : 'password'} value={profile.asr.apiKey} onChange={e => patch('asr', 'apiKey', e.target.value)} placeholder="仅保留在本次运行内存中" autoComplete="off" /></label></div>
        <div className="setting-section-title"><h3>文本翻译</h3></div>
        <label className="field">OpenAI 兼容基础地址<input type="url" value={profile.translation.url} onChange={e => patch('translation', 'url', e.target.value)} placeholder="http://127.0.0.1:11434/v1" spellCheck={false} /></label>
        <div className="fields-row"><label className="field">模型名称<input value={profile.translation.model} onChange={e => patch('translation', 'model', e.target.value)} spellCheck={false} /></label><label className="field">API Key <span className="optional">可选</span><input type={showKeys ? 'text' : 'password'} value={profile.translation.apiKey} onChange={e => patch('translation', 'apiKey', e.target.value)} placeholder="仅保留在本次运行内存中" autoComplete="off" /></label></div>
        <button className="text-button key-toggle" onClick={() => setShowKeys(!showKeys)}>{showKeys ? <EyeOff size={14} /> : <Eye size={14} />}{showKeys ? '隐藏' : '显示'} API Key</button>
      </fieldset>
      <div className="config-note"><ChevronRight size={16} /><p>{mode === 'local' ? '此模式仍通过 HTTP 调用模型服务。手机连接电脑时填写局域网 IP；Android 模拟器使用 10.0.2.2。' : '基础地址通常以 /v1 结尾，不要填写完整的 /chat/completions 路径。API Key 不会写入本地存储。'}</p></div>
      </>}
      <fieldset disabled={checking}>
        <div className="setting-section-title"><h3>翻译偏好</h3></div>
        <label className="setting-inline"><span>VAD 结束静音<small>Silero VAD 检测语音起止；短暂停顿合并，整句识别后翻译</small></span><select value={draft.vadSilenceSeconds} onChange={e => setDraft(d => ({ ...d, vadSilenceSeconds: Number(e.target.value) }))}>{[0.5, 0.8, 1.2, 1.6].map(n => <option key={n} value={n}>{n} 秒</option>)}</select></label>
        <label className="setting-inline"><span>自动跟随新内容<small>译文生成时滚动到最新片段</small></span><input type="checkbox" checked={draft.autoScroll} onChange={e => setDraft(d => ({ ...d, autoScroll: e.target.checked }))} /></label>
      </fieldset>
      {feedback && <p role="status" className={`connection-result ${feedback.ok ? 'success' : 'failure'}`}>{feedback.ok && <Check size={16} />}{feedback.text}</p>}
      <footer className="dialog-footer">{mode !== 'offline' ? <button className="secondary-button" onClick={test} disabled={checking}>{checking && <Loader2 size={16} className="spin" />}{checking ? '正在连接…' : '测试服务连接'}</button> : <span /> }<button className="primary-button" disabled={checking || offlineState.operation} onClick={save}>保存设置<Check size={16} /></button></footer>
    </div>
  </dialog>;
}
