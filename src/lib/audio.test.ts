import { describe, expect, it } from 'vitest';
import { encodeWav, pcmFromBase64, resample, StreamingResampler, toBase64 } from './audio';

describe('audio transport', () => {
  it('encodes standalone 16 kHz mono PCM WAV with clipped samples', () => {
    const wav = encodeWav(new Float32Array([-2, -1, 0, 1, 2]));
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(10);
    expect(Array.from({ length: 5 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([-32768, -32768, 0, 32767, 32767]);
  });
  it('decodes native little-endian PCM without alignment assumptions', () => {
    expect([...pcmFromBase64(toBase64(new Uint8Array([0, 128, 0, 0, 255, 127])))]).toEqual([-1, 0, 32767 / 32768]);
  });
  it('preserves duration and DC signal when resampling 44.1 kHz audio', () => {
    const output = resample(new Float32Array(44100).fill(0.4), 44100);
    expect(output.length).toBe(16000);
    expect(output[0]).toBeCloseTo(0.4, 5);
    expect(output[15999]).toBeCloseTo(0.4, 5);
  });
  it.each([44100, 48000])('does not accumulate sample loss between %i Hz capture callbacks', rate => {
    const input = Float32Array.from({ length: rate * 5 }, (_, i) => Math.sin(i / 40) * 0.2);
    const stream = new StreamingResampler();
    const output: number[] = [];
    for (let i = 0; i < input.length; i += 2048) output.push(...stream.push(input.slice(i, i + 2048), rate));
    const expected = resample(input, rate);
    expect(Math.abs(output.length - expected.length)).toBeLessThanOrEqual(1);
    for (let i = 0; i < output.length; i += 53) expect(output[i]).toBeCloseTo(expected[i], 5);
  });
  it('copies native 16 kHz frames so transferring a buffer cannot detach the caller’s frame', () => {
    const input = new Float32Array([0.1, 0.2]);
    const output = new StreamingResampler().push(input, 16000);
    expect(output).toEqual(input);
    expect(output.buffer).not.toBe(input.buffer);
  });
});
