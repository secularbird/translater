/** Incremental SSE parser: handles UTF-8 boundaries, CRLF and multi-line data. */
export async function consumeSSE(stream: ReadableStream<Uint8Array>, onData: (data: string) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '', lines: string[] = [];
  const line = (value: string) => {
    if (value === '') {
      if (lines.length) onData(lines.join('\n'));
      lines = [];
    } else if (value.startsWith('data:')) lines.push(value.slice(5).replace(/^ /, ''));
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let index: number;
      while ((index = pending.indexOf('\n')) !== -1) {
        line(pending.slice(0, index).replace(/\r$/, ''));
        pending = pending.slice(index + 1);
      }
      if (done) break;
      if (pending.length > 1_000_000) throw new Error('模型返回了过大的流式消息。');
    }
    if (pending) line(pending.replace(/\r$/, ''));
    line('');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
