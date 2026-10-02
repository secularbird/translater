({pcm}) => {
  // Test-only input substitution: production native capture, resampler, VAD,
  // ASR, translation and UI queue still run. No inference result is mocked.
  const bytes = Uint8Array.from(atob(pcm), c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const speech = Float32Array.from({length: bytes.length / 2}, (_, i) => view.getInt16(i * 2, true) / 32768);
  const NativeWorker = window.Worker;
  const state = window.resourceTest = {cycle: 0, playing: false, offset: 0, events: [], results: [], errors: [], audioSamples: 0};
  const phase = name => {
    state.events.push({phase: name, timestamp: Date.now()});
    console.log('RESOURCE_PHASE=' + name);
  };
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      this.vad = String(url).includes('vad.worker-');
      if (this.vad) state.vadUrl = String(url);
      this.inference = String(url).includes('inference.worker-');
      this.addEventListener('message', ({data}) => {
        if (data.error || data.type === 'error') state.errors.push(data.error || data.message);
        if (this.vad && data.type === 'ready') phase('vad-listening');
        if (this.vad && data.type === 'segment') state.events.push({type: 'vad-segment', final: data.segment.final, timestamp: Date.now()});
        if (this.inference && data.id === this.request?.id && data.result !== undefined) {
          state.events.push({type: 'completed', action: this.request.action, prepare: !!this.request.prepare, timestamp: Date.now()});
          if (!this.request.prepare) {
            state.results.push({cycle: state.cycle, action: this.request.action, result: data.result, milliseconds: performance.now() - this.started});
            if (this.request.action === 'translation') phase('vad-listening');
          }
        }
      });
    }
    postMessage(message, transfer) {
      if (this.inference) {
        this.request = message;
        this.started = performance.now();
        phase((message.prepare ? 'load-' : '') + message.action);
      }
      if (this.vad && message.action === 'init') phase('vad-initialize');
      if (this.vad && message.action === 'audio') {
        const samples = new Float32Array(message.samples.length);
        state.audioSamples += samples.length;
        if (state.playing) {
          const part = speech.subarray(state.offset, state.offset + samples.length);
          samples.set(part); state.offset += part.length;
          if (state.offset === speech.length) state.playing = false;
        }
        return super.postMessage({...message, samples}, [samples.buffer]);
      }
      return super.postMessage(message, transfer);
    }
  };
  state.play = () => { state.cycle++; state.offset = 0; state.playing = true; phase('speech-input'); };
  return {seconds: speech.length / 16000};
}
