// Independent PCM utterances: each uploaded WAV has its own valid RIFF header.
export function resample(samples: Float32Array, fromRate: number, toRate = 16000): Float32Array {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const output = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < output.length; i++) {
    // Area averaging reduces aliasing for speech downsampling.
    const start = i * ratio, end = (i + 1) * ratio;
    let total = 0;
    for (let j = Math.floor(start); j < Math.ceil(end); j++) {
      total += (samples[j] ?? 0) * Math.max(0, Math.min(end, j + 1) - Math.max(start, j));
    }
    output[i] = total / ratio;
  }
  return output;
}
export function encodeWav(samples: Float32Array, sampleRate = 16000): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((value, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767), true));
  return new Uint8Array(buffer);
}
export function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export function pcmFromBase64(value: string): Float32Array {
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  return Float32Array.from({ length: bytes.length / 2 }, (_, i) => view.getInt16(i * 2, true) / 32768);
}

/** Preserve fractional sample positions across capture callbacks. */
export class StreamingResampler {
  private tail = new Float32Array(0);
  private position = 0;
  private rate = 0;
  push(samples: Float32Array, fromRate: number): Float32Array {
    if (fromRate !== this.rate) { this.tail = new Float32Array(0); this.position = 0; this.rate = fromRate; }
    if (fromRate === 16000) return samples.slice();
    const input = new Float32Array(this.tail.length + samples.length);
    input.set(this.tail); input.set(samples, this.tail.length);
    const ratio = fromRate / 16000;
    const count = Math.max(0, Math.floor((input.length - this.position) / ratio));
    const output = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const start = this.position + i * ratio, end = start + ratio;
      let total = 0;
      for (let j = Math.floor(start); j < Math.ceil(end); j++) {
        total += (input[j] ?? 0) * Math.max(0, Math.min(end, j + 1) - Math.max(start, j));
      }
      output[i] = total / ratio;
    }
    const consumed = this.position + count * ratio;
    this.tail = input.slice(Math.floor(consumed));
    this.position = consumed - Math.floor(consumed);
    return output;
  }
}
