import { encodeWav } from './audio';

export const MAX_ASR_WINDOW_SECONDS = 25;
export interface VadSegment { id: number; audio?: Uint8Array; final: boolean }
export interface VadDetector {
  acceptWaveform(samples: Float32Array): void;
  isDetected(): boolean;
  isEmpty(): boolean;
  front(): { samples: Float32Array; start: number };
  pop(): void;
  flush(): void;
  reset(): void;
}

/** VAD defines utterances. A safety window is transport only, not a sentence. */
export class VadEndpoint {
  private id = 0;
  private open = false;
  private buffered = 0;
  private quiet = 0;
  constructor(private detector: VadDetector, private silenceSeconds: number,
    private emit: (value: VadSegment) => void, private maxSeconds = MAX_ASR_WINDOW_SECONDS) {}

  private drain(final: boolean) {
    while (!this.detector.isEmpty()) {
      const speech = this.detector.front();
      this.detector.pop();
      this.open = true;
      this.emit({ id: this.id, audio: encodeWav(speech.samples), final });
      this.buffered = 0; this.quiet = 0;
      if (final) { this.open = false; this.id++; }
    }
  }
  push(samples: Float32Array) {
    this.detector.acceptWaveform(samples);
    if (this.detector.isDetected()) { this.open = true; this.quiet = 0; }
    else if (this.open) this.quiet += samples.length;
    this.drain(true);
    if (this.open) this.buffered += samples.length;
    if (this.open && this.buffered >= this.maxSeconds * 16000) {
      this.detector.flush();
      this.drain(false);
      this.detector.reset();
      this.buffered = 0; this.quiet = 0;
    }
    // After a safety flush, the remaining tail may be silence only. Close the
    // same utterance explicitly instead of waiting forever for another chunk.
    // Allow the reset detector its 0.2s minimum speech onset plus frame latency
    // to detect speech resuming near the silence threshold.
    if (this.open && !this.detector.isDetected() && this.quiet >= (this.silenceSeconds + 0.3) * 16000) {
      this.detector.flush(); this.drain(true);
      if (this.open) { this.emit({ id: this.id++, final: true }); this.open = false; }
      this.buffered = this.quiet = 0;
    }
  }
  finish() {
    this.detector.flush(); this.drain(true);
    if (this.open) { this.emit({ id: this.id++, final: true }); this.open = false; }
    this.buffered = this.quiet = 0;
  }
}
