import { cacheStatus, clearModels, downloadModels, importModels } from './cache';

let controller: AbortController | undefined;
self.onmessage = async (event: MessageEvent<{ id: string; action: string; files?: File[]; baseUrl?: string }>) => {
  const { id, action, files } = event.data;
  if (action === 'cancel') { controller?.abort(); return; }
  try {
    if (action === 'status') { self.postMessage({ id, status: await cacheStatus() }); return; }
    if (controller) throw new Error('正在处理模型文件，请稍后再试。');
    controller = new AbortController();
    const report = (progress: unknown) => self.postMessage({ id, progress });
    if (action === 'download') await downloadModels(report, controller.signal, event.data.baseUrl);
    else if (action === 'import') await importModels(files || [], report, controller.signal);
    else if (action === 'clear') await clearModels();
    self.postMessage({ id, status: await cacheStatus() });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error), cancelled: controller?.signal.aborted });
  } finally { if (action !== 'status') controller = undefined; }
};
