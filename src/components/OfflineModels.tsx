import { useRef } from 'react';
import { Download, FolderOpen, Loader2, Trash2 } from 'lucide-react';
import { MODEL_ASSETS } from '../offline/catalog';
import { cancelModelDownload, manageModels, releaseOfflineModels, TOTAL_BYTES, useOfflineModels } from '../offline/client';
import type { Settings } from '../types';
import { endpointUrl } from '../lib/settings';

export default function OfflineModels({ config, onChange }: {
  config: Settings['offline']; onChange: (value: Settings['offline']) => void;
}) {
  const state = useOfflineModels();
  const input = useRef<HTMLInputElement>(null);
  const ready = state.asr && state.translation;
  const locked = state.operation || state.running;
  const download = () => {
    try { if (config.downloadBaseUrl) endpointUrl(config.downloadBaseUrl, ''); }
    catch { return; }
    void manageModels('download', undefined, config.downloadBaseUrl);
  };
  const progress = state.progress ? Math.min(100, state.progress.loaded / state.progress.total * 100) : undefined;
  return <div className="offline-models">
    <p className="dialog-description">模型在此设备的 WASM 中运行。下载后无需模型服务器，音频和原文不会上传。</p>
    <div className="offline-model-row"><div><strong>SenseVoice Small · INT8</strong><span>语音识别 · 中 / 英 / 日 / 韩 / 粤 · 240 MB</span></div><small className={state.asr ? 'success' : ''}>{state.loaded.includes('asr') ? '内存已加载' : state.asr ? '已下载' : '未下载'}</small></div>
    <div className="offline-model-row"><div><strong>Meta M2M100 · Q8</strong><span>多语言翻译 · WASM CPU · 640 MB</span></div><small className={state.translation ? 'success' : ''}>{state.loaded.includes('translation') ? '内存已加载' : state.translation ? '已下载' : '未下载'}</small></div>
    <p className="cache-summary">已缓存 {(state.bytes / 1e6).toFixed(0)} / {(TOTAL_BYTES / 1e6).toFixed(0)} MB</p>
    {(state.operation || state.running) && <div className="model-progress" role="status">
      <span><Loader2 size={14} className="spin" />{state.message}</span>
      {state.progress && <><small>{state.progress.file}</small><progress max="100" value={progress} /><small>{progress?.toFixed(0)}% · {(state.progress.loaded / 1e6).toFixed(1)} / {(state.progress.total / 1e6).toFixed(1)} MB</small></>}
    </div>}
    {state.error && <p className="connection-result failure" role="alert">{state.error}</p>}
    {!locked && state.message && <p className="connection-result success" role="status">{state.message}</p>}
    <div className="model-actions">
      {state.operation ? <button className="secondary-button" onClick={cancelModelDownload}>暂停下载</button>
        : <button className="primary-button" disabled={ready || state.running} onClick={download}><Download size={16} />{ready ? '已可离线使用' : state.bytes ? '继续下载模型' : '下载离线模型'}</button>}
      <button className="secondary-button" disabled={locked} onClick={() => input.current?.click()}><FolderOpen size={16} />导入文件</button>
      <input ref={input} type="file" className="sr-only" aria-label="导入离线模型文件" multiple accept=".onnx,.json,.txt"
        onChange={e => { if (e.target.files?.length) void manageModels('import', [...e.target.files]); e.target.value = ''; }} />
    </div>
    <label className="setting-inline"><span>低内存模式<small>{config.lowMemory ? '当前会交替卸载和重载，速度较慢；关闭后两个模型同时常驻' : '当前为常驻模式：首次加载后复用，停止录音也保留模型'}</small></span><input type="checkbox" checked={config.lowMemory} disabled={locked} onChange={e => onChange({ ...config, lowMemory: e.target.checked })} /></label>
    {(state.loadCounts.asr > 0 || state.loadCounts.translation > 0) && <p className="cache-summary">本次运行加载次数：识别 {state.loadCounts.asr} / 翻译 {state.loadCounts.translation}</p>}
    <div className="model-actions compact">
      <button className="text-button" disabled={locked || !state.loaded.length} onClick={releaseOfflineModels}>释放模型内存</button>
      <button className="text-button" disabled={locked || !state.bytes} onClick={() => void manageModels('clear')}><Trash2 size={14} />删除已下载模型</button>
    </div>
    <details className="offline-details"><summary>下载与文件说明</summary>
      <p>首次从 Hugging Face 下载约 880 MB。中断后可继续，导入的 ONNX 权重会进行 SHA-256 校验。模型缓存保存在此应用的本地存储中。</p>
      <p>文字和语音均可自动检测原文语言，也可手动选择。短词或混合语言可能需要手动校正；每句离线文字最多 500 字。粤语识别结果按中文文本翻译。</p>
      <label className="field">静态模型镜像地址（可选）<input type="url" value={config.downloadBaseUrl} disabled={locked} placeholder="留空使用 Hugging Face" onChange={e => onChange({ ...config, downloadBaseUrl: e.target.value })} /></label>
      {config.downloadBaseUrl && (() => { try { endpointUrl(config.downloadBaseUrl, ''); return null; } catch { return <p className="failure">镜像需要是有效的 HTTP(S) 基础地址。</p>; } })()}
      <p>镜像需按以下相对路径提供文件；也可以用「导入文件」逐个或批量导入：</p>
      <ul>{MODEL_ASSETS.map(asset => <li key={asset.id}><code>{asset.id}</code></li>)}</ul>
      <p>模型运行内存高于文件体积。设备内存不足时可使用低内存模式或服务模式。M2M100 为 MIT；SenseVoice 遵循其模型许可。</p>
    </details>
  </div>;
}
