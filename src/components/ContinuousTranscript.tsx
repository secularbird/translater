import { useEffect, useRef } from 'react';
import { Copy, Loader2, RotateCcw } from 'lucide-react';
import type { Segment } from '../types';
import { transcriptParts } from '../lib/transcript';

export default function ContinuousTranscript({ segments, recording = false, preparing = false, autoScroll = false, onCopy, onRetry, busy = false }: {
  segments: Segment[];
  recording?: boolean;
  preparing?: boolean;
  autoScroll?: boolean;
  onCopy: (text: string) => void;
  onRetry?: (segment: Segment) => void;
  busy?: boolean;
}) {
  const original = transcriptParts(segments, 'source');
  const translated = transcriptParts(segments, 'translation');
  const originalText = original.map(part => part.text).join('');
  const translatedText = translated.map(part => part.text).join('');
  const originalScroll = useRef<HTMLDivElement>(null);
  const translatedScroll = useRef<HTMLDivElement>(null);
  const recognizing = segments.some(s => s.status === 'recognizing' || (s.status === 'queued' && !s.source));
  const translating = segments.some(s => s.status === 'translating');
  const translatingId = segments.find(s => s.status === 'translating')?.id;
  const waiting = segments.some(s => s.status === 'queued' || s.status === 'recognizing');
  const waitingForEnd = segments.some(s => s.status === 'waiting');
  const failures = segments.filter(s => s.status === 'error');
  const retryable = failures.find(s => s.source.trim() && s.finalized !== false);

  useEffect(() => {
    if (autoScroll && originalScroll.current) originalScroll.current.scrollTop = originalScroll.current.scrollHeight;
  }, [originalText, autoScroll]);
  useEffect(() => {
    if (autoScroll && translatedScroll.current) translatedScroll.current.scrollTop = translatedScroll.current.scrollHeight;
  }, [translatedText, autoScroll]);

  return (
    <div className="continuous-transcript" role="group" aria-label="识别和翻译结果">
      <section className="transcript-pane original" aria-label="原文">
        <header className="pane-heading">
          <h3>原文</h3>
          {recognizing && <span className="pane-state"><Loader2 size={13} className="spin" />识别中</span>}
          <button className="icon-button" aria-label="复制原文" title="复制全部原文" disabled={!originalText} onClick={() => onCopy(originalText)}><Copy size={16} /></button>
        </header>
        <div className="pane-scroll" ref={originalScroll} role="log" aria-label="识别原文" aria-live="polite" aria-relevant="additions text" tabIndex={0}>
          {originalText ? (
            <p className="transcript-text" dir="auto">{original.map(part => <span key={part.id}>{part.text}</span>)}</p>
          ) : <p className="transcript-placeholder">{recognizing ? '正在识别语音…' : recording ? '正在聆听…' : preparing ? '准备完成后即可开始说话' : '点击麦克风，开始说话'}</p>}
        </div>
      </section>

      <section className="transcript-pane translated" aria-label="译文">
        <header className="pane-heading">
          <h3>译文</h3>
          {(translating || waiting || waitingForEnd) && <span className="pane-state"><Loader2 size={13} className="spin" />{translating ? '翻译中' : waitingForEnd ? '等待完整句' : '等待处理'}</span>}
          <button className="icon-button" aria-label="复制译文" title="复制全部译文" disabled={!translatedText} onClick={() => onCopy(translatedText)}><Copy size={16} /></button>
        </header>
        <div className="pane-scroll" ref={translatedScroll} role="log" aria-label="翻译结果" aria-live="polite" aria-relevant="additions text" tabIndex={0}>
          {translatedText ? (
            <p className="transcript-text" dir="auto">{translated.map(part => <span key={part.id}>{part.text}{part.id === translatingId && <span className="typing-cursor" aria-hidden="true" />}</span>)}</p>
          ) : <p className="transcript-placeholder">{translating ? '正在翻译…' : '翻译会显示在这里'}</p>}
        </div>
        {failures.length > 0 && <div className="transcript-error" role="status">
          <p>{failures.length > 1 && '有部分内容未完成。'}{failures[0].error || '处理失败，请重试。'}</p>
          {retryable && onRetry && <button onClick={() => onRetry(retryable)} disabled={busy}><RotateCcw size={14} />重试</button>}
        </div>}
      </section>
    </div>
  );
}
