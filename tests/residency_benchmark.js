// Real WASM benchmark. The same two workers are retained for every round.
(async (config) => {
  const origin = config.origin || new URL('/', location.href).href.replace(/\/$/, '');
  let samples = config.samples;
  if (!samples) {
    const bytes = Uint8Array.from(atob(config.wav), c => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    samples = Float32Array.from({ length: (bytes.length - 44) / 2 }, (_, i) => view.getInt16(44 + i * 2, true) / 32768);
  }
  const workers = {
    asr: new Worker(new URL(config.inference, location.href), { type: 'module' }),
    translation: new Worker(new URL(config.inference, location.href), { type: 'module' }),
  };
  const loadCounts = { asr: 0, translation: 0 };
  const loadMs = {};
  const rounds = [];
  const call = (engine, payload) => new Promise((resolve, reject) => {
    const worker = workers[engine];
    const id = crypto.randomUUID();
    const started = performance.now();
    const timer = setTimeout(() => reject(new Error(`${engine} timed out`)), 180000);
    let text = '';
    worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
    worker.onmessage = event => {
      const data = event.data;
      if (data.id !== id) return;
      if (data.progress) {
        if (data.progress.startsWith('正在加载')) loadCounts[engine]++;
        return;
      }
      if (data.ready) return;
      if (data.token !== undefined) { text += data.token; return; }
      clearTimeout(timer);
      if (data.error) reject(new Error(data.error));
      else resolve({ result: engine === 'translation' && !payload.prepare ? text : data.result, milliseconds: performance.now() - started });
    };
    worker.postMessage({ id, action: engine, origin, ...payload });
  });
  try {
    loadMs.translation = (await call('translation', { prepare: true })).milliseconds;
    loadMs.asr = (await call('asr', { language: 'auto', prepare: true })).milliseconds;
    for (let i = 0; i < 3; i++) {
      const asr = await call('asr', { language: 'auto', samples });
      if (asr.result.language !== 'zh' || !asr.result.text.includes('时间')) throw new Error('Unexpected ASR result');
      const translation = await call('translation', { language: 'en', target: 'zh', text: 'Hello, how are you?' });
      if (!/[\u4e00-\u9fff]/.test(translation.result)) throw new Error('Unexpected translation');
      rounds.push({ round: i + 1, asr, translation });
    }
    if (loadCounts.asr !== 1 || loadCounts.translation !== 1) throw new Error(`Repeated initialization: ${JSON.stringify(loadCounts)}`);
    return { passed: true, loadCounts, loadMs, rounds, visibility: document.visibilityState };
  } finally {
    workers.asr.terminate(); workers.translation.terminate();
  }
})
