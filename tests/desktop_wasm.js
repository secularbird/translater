(async () => {
  const config = __SONORA_TEST_CONFIG__;
  const origin = new URL('/', location.href).href.replace(/\/$/, '');
  const records = [];
  const phases = [];
  const workers = [];
  const call = (worker, payload) => new Promise((resolve, reject) => {
    const started = performance.now();
    const timer = setTimeout(() => reject(new Error('WASM diagnostic timed out')), 180000);
    worker.onerror = e => { clearTimeout(timer); reject(new Error(e.message)); };
    let text = '';
    worker.onmessage = e => {
      if (e.data.ready) return;
      if (e.data.progress) {
        phases.push({task: payload.action, message: e.data.progress, milliseconds: performance.now()-started, visibility: document.visibilityState});
        return;
      }
      if (e.data.token !== undefined) { text += e.data.token; return; }
      clearTimeout(timer);
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.result ?? e.data.status ?? text);
      if (text) records.push({ task: 'translation', text });
    };
    worker.postMessage({ id: crypto.randomUUID(), origin, ...payload });
  });
  const spawn = file => {
    const worker = new Worker(new URL(file, location.href), { type: 'module' });
    workers.push(worker);
    return worker;
  };
  let report;
  const stage = value => window.__TAURI_INTERNALS__.invoke('offline_self_test_result', { result: { stage: value } });
  try {
    await stage('starting-cache');
    const storage = spawn(config.storage);
    const status = await call(storage, { action: 'download', baseUrl: config.baseUrl + '/offline-assets' });
    if (!status.asr || !status.translation) throw new Error('Models not completely cached');
    await stage('cache-ready');
    storage.terminate();
    const wav = await (await fetch(config.baseUrl + '/samples/zh.wav')).arrayBuffer();
    const view = new DataView(wav);
    let samples = Float32Array.from({ length: (wav.byteLength - 44) / 2 }, (_, i) => view.getInt16(44 + i * 2, true) / 32768);
    if (config.resident) {
      const saved = JSON.parse(localStorage.getItem('sonora.settings.v1') || '{}');
      saved.offline = { ...(saved.offline || {}), lowMemory: false };
      localStorage.setItem('sonora.settings.v1', JSON.stringify(saved));
      const benchmark = __SONORA_RESIDENCY_BENCHMARK__;
      const result = await benchmark({ origin, inference: config.inference, samples });
      result.savedLowMemory = JSON.parse(localStorage.getItem('sonora.settings.v1')).offline.lowMemory;
      if (result.savedLowMemory !== false) throw new Error('Resident preference was not persisted');
      await window.__TAURI_INTERNALS__.invoke('offline_self_test_result', { result });
      return;
    }
    await stage('detecting-speech');
    const detect = __SONORA_VAD_CHECK__;
    const detected = await detect({file: config.vad, samples, origin});
    samples = detected.samples;
    records.push({task: 'vad', seconds: detected.seconds});
    let worker = spawn(config.inference);
    await stage('recognizing');
    let start = performance.now();
    const recognized = await call(worker, { action: 'asr', language: 'auto', samples });
    if (recognized.language !== 'zh' || !recognized.text.includes('时间')) throw new Error('Unexpected ASR: ' + JSON.stringify(recognized));
    records.push({ task: 'asr', result: recognized, milliseconds: performance.now() - start });
    worker.terminate();
    worker = spawn(config.inference);
    await stage('translating');
    start = performance.now();
    await call(worker, { action: 'translation', language: 'en', target: 'zh', text: 'Hello, how are you?' });
    const translated = records.find(item => item.task === 'translation');
    if (!translated || !/[\u4e00-\u9fff]/.test(translated.text)) throw new Error('Translation did not produce Chinese');
    translated.milliseconds = performance.now() - start;
    worker.terminate();
    await stage('auto-text-ui');
    const wait = async predicate => {
      const deadline = performance.now() + 120000;
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error('Automatic text UI timed out');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    await wait(() => document.querySelector('#source-language'));
    document.querySelector('[aria-label="模型设置"]').click();
    await wait(() => document.querySelector('dialog[open]'));
    const dialogButton = text => [...document.querySelectorAll('dialog button')].find(button => button.textContent.trim() === text);
    dialogButton('设备离线').click();
    await new Promise(resolve => setTimeout(resolve, 100));
    dialogButton('保存设置').click();
    await wait(() => !document.querySelector('dialog[open]'));
    const select = (selector, value) => {
      const element = document.querySelector(selector);
      element.value = value; element.dispatchEvent(new Event('change', {bubbles:true}));
    };
    select('#source-language', 'auto'); select('#target-language', 'zh');
    document.querySelector('[aria-label="文字输入"]').click();
    await wait(() => document.querySelector('#text-input'));
    const input = document.querySelector('#text-input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Hello, how are you?');
    input.dispatchEvent(new Event('input', {bubbles:true}));
    await new Promise(resolve => setTimeout(resolve, 100));
    start = performance.now();
    document.querySelector('.text-composer').requestSubmit();
    await wait(() => !document.querySelector('[aria-label="保存会话"]').disabled);
    if (document.querySelector('.transcript-error')) throw new Error(document.querySelector('.transcript-error').textContent);
    const autoText = document.querySelector('.translated .transcript-text')?.textContent;
    if (!autoText || !/[\u4e00-\u9fff]/.test(autoText)) throw new Error('Automatic text translation missing');
    if (!document.querySelector('.transcript-footer').textContent.includes('已识别：英语')) throw new Error('Text language was not detected');
    if (document.querySelector('#source-language').value !== 'auto') throw new Error('Automatic source preference was overwritten');
    records.push({task:'auto-text-ui', text:autoText, milliseconds:performance.now()-start});
    report = { passed: true, origin, records, phases };
  } catch (error) {
    report = { passed: false, origin, error: String(error), records, phases };
  } finally {
    workers.forEach(worker => worker.terminate());
  }
  await window.__TAURI_INTERNALS__.invoke('offline_self_test_result', { result: report });
})();
