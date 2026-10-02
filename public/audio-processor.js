// Capture on the audio thread, with bounded messages to the UI thread.
class SonoraCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(2048); this.offset = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.buffer[this.offset++] = input[i];
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer.slice(), []);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('sonora-capture', SonoraCapture);
