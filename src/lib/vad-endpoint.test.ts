import { describe, expect, it } from 'vitest';
import { VadEndpoint, type VadDetector, type VadSegment } from './vad-endpoint';

class Detector implements VadDetector {
  detected = false;
  queue: { samples: Float32Array; start: number }[] = [];
  buffered = 0;
  acceptWaveform(samples: Float32Array) { if (this.detected) this.buffered += samples.length; }
  isDetected() { return this.detected; }
  isEmpty() { return this.queue.length === 0; }
  front() { return this.queue[0]; }
  pop() { this.queue.shift(); }
  flush() { if (this.buffered) this.queue.push({ samples: new Float32Array(this.buffered), start: 0 }); this.buffered = 0; }
  reset() { this.detected = false; }
  endSpeech() { this.flush(); this.detected = false; }
}
const pushSeconds = (pipeline: VadEndpoint, seconds: number) => {
  for (let i = 0; i < seconds * 16000; i += 512) pipeline.push(new Float32Array(512));
};

describe('VAD utterance boundaries', () => {
  it('does not cut a long voiced sentence at the previous 2/4/6/8 second boundaries', () => {
    const detector = new Detector(); detector.detected = true;
    const output: VadSegment[] = [];
    const pipeline = new VadEndpoint(detector, 0.8, value => output.push(value));
    pushSeconds(pipeline, 10);
    expect(output).toHaveLength(0);
    detector.endSpeech(); pipeline.push(new Float32Array(512));
    expect(output).toHaveLength(1);
    expect(output[0].final).toBe(true);
    expect(output[0].audio!.length).toBeGreaterThan(44 + 16000 * 8 * 2);
  });
  it('marks protective transport windows as continuation of the same utterance', () => {
    const detector = new Detector(); detector.detected = true;
    const output: VadSegment[] = [];
    const pipeline = new VadEndpoint(detector, 0.8, value => output.push(value), 2);
    pushSeconds(pipeline, 2);
    expect(output.map(s => s.final)).toEqual([false]);
    detector.detected = true;
    pushSeconds(pipeline, 0.5);
    detector.endSpeech(); pipeline.push(new Float32Array(512));
    expect(output.map(s => s.final)).toEqual([false, true]);
    expect(output[0].id).toBe(output[1].id);
  });
  it('closes a continuation even if only silence follows the safety window', () => {
    const detector = new Detector(); detector.detected = true;
    const output: VadSegment[] = [];
    const pipeline = new VadEndpoint(detector, 0.8, value => output.push(value), 2);
    pushSeconds(pipeline, 2); pushSeconds(pipeline, 1.2);
    expect(output).toHaveLength(2);
    expect(output[1]).toEqual({ id: output[0].id, final: true });
  });
  it('flushes a final utterance once on explicit stop, and ignores silence', () => {
    const detector = new Detector();
    const output: VadSegment[] = [];
    const pipeline = new VadEndpoint(detector, 0.8, value => output.push(value));
    pushSeconds(pipeline, 2); pipeline.finish();
    expect(output).toHaveLength(0);
    detector.detected = true; pushSeconds(pipeline, 1);
    pipeline.finish(); pipeline.finish();
    expect(output).toHaveLength(1);
    expect(output[0].final).toBe(true);
  });
});
