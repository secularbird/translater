import { describe, expect, it } from 'vitest';
import { consumeSSE } from './sse';

function stream(value: string, size: number) {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
    controller.close();
  } });
}
describe('SSE transport', () => {
  it.each([1, 2, 7, 1000])('preserves split Unicode, CRLF, comments and multi-line events (chunk %i)', async size => {
    const events: string[] = [];
    await consumeSSE(stream(': keepalive\r\ndata: {"text":"你好 🌍"}\r\n\r\nevent: delta\ndata: first\ndata: second\n\ndata: [DONE]\n\n', size), data => events.push(data));
    expect(events).toEqual(['{"text":"你好 🌍"}', 'first\nsecond', '[DONE]']);
  });
  it('handles a final frame without a trailing newline', async () => {
    const events: string[] = [];
    await consumeSSE(stream('data: last', 2), data => events.push(data));
    expect(events).toEqual(['last']);
  });
  it('propagates provider errors raised by event consumers', async () => {
    await expect(consumeSSE(stream('data: {"error":"bad key"}\n\n', 3), () => { throw new Error('bad key'); })).rejects.toThrow('bad key');
  });
});
