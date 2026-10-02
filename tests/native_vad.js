async ({file, samples, origin}) => {
  const worker = new Worker(new URL(file, location.href), {type: 'module'});
  const segments = [];
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native VAD timed out')), 30000);
      const fail = message => { clearTimeout(timer); reject(new Error(message)); };
      worker.onerror = event => fail(event.message);
      worker.onmessage = ({data}) => {
        if (data.type === 'error') return fail(data.message);
        if (data.type === 'segment') segments.push(data.segment);
        if (data.type === 'ready') {
          const padded = new Float32Array(samples.length + 19200);
          padded.set(samples);
          worker.postMessage({action: 'audio', samples: padded}, [padded.buffer]);
          worker.postMessage({action: 'finish'});
        }
        if (data.type === 'finished') { clearTimeout(timer); resolve(); }
      };
      worker.postMessage({action: 'init', origin, silenceSeconds: 0.8});
    });
    if (segments.length !== 1 || !segments[0].final || !segments[0].audio) {
      throw new Error('Expected one complete native VAD utterance');
    }
    const bytes = segments[0].audio;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const speech = Float32Array.from({length: (bytes.length - 44) / 2}, (_, i) => view.getInt16(44 + i * 2, true) / 32768);
    return {samples: speech, seconds: speech.length / 16000};
  } finally { worker.terminate(); }
}
