import { addPluginListener, invoke, isTauri, type PluginListener } from '@tauri-apps/api/core';
import { pcmFromBase64 } from './audio';

export const isNativeMobile = () => isTauri() && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
export interface Capture { stop: () => Promise<void> }
export async function requestCapturePermission(beforePrompt?: () => void): Promise<void> {
  if (!isNativeMobile()) return;
  const current = await invoke<{ microphone: string }>('plugin:microphone|check_permissions');
  if (current.microphone === 'granted') return;
  beforePrompt?.();
  const permission = await invoke<{ microphone: string }>('plugin:microphone|request_permissions', { permissions: ['microphone'] });
  if (permission.microphone !== 'granted') throw new Error('麦克风权限未开启，请在系统设置中允许声桥使用麦克风。');
}
export async function devices(): Promise<MediaDeviceInfo[]> {
  if (isNativeMobile() || !navigator.mediaDevices) return [];
  return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
}
export async function startCapture(
  deviceId: string,
  onFrame: (samples: Float32Array, rate: number) => void,
  onError: (message: string) => void,
  beforePermissionPrompt?: () => void,
): Promise<Capture> {
  if (isNativeMobile()) {
    await requestCapturePermission(beforePermissionPrompt);
    const listeners: PluginListener[] = [];
    try {
      listeners.push(await addPluginListener<{ pcm: string; sampleRate: number }>('microphone', 'audio', event => onFrame(pcmFromBase64(event.pcm), event.sampleRate)));
      listeners.push(await addPluginListener<{ message: string }>('microphone', 'error', event => onError(event.message)));
      await invoke('plugin:microphone|start');
    } catch (error) {
      await Promise.all(listeners.map(l => l.unregister()));
      throw error;
    }
    let stopped = false;
    // Reconcile after native background/interruption events, even when the
    // WebView was suspended and could not receive the original event.
    const timer = setInterval(async () => {
      if (stopped || document.hidden) return;
      try {
        const status = await invoke<{ recording: boolean }>('plugin:microphone|status');
        if (!stopped && !status.recording) onError('录音已被系统暂停，请重新开始。');
      } catch (error) {
        if (!stopped) onError(`无法确认麦克风状态：${String(error)}`);
      }
    }, 1000);
    return { stop: async () => {
      stopped = true; clearInterval(timer);
      try { await invoke('plugin:microphone|stop'); }
      finally { await Promise.all(listeners.map(l => l.unregister())); }
    } };
  }
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境不支持录音，请在原生应用或 localhost / HTTPS 页面中打开。');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    channelCount: 1, echoCancellation: true, noiseSuppression: true,
  } });
  let context: AudioContext | undefined;
  try {
    context = new AudioContext();
    await context.audioWorklet.addModule('/audio-processor.js');
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'sonora-capture');
    const mute = context.createGain(); mute.gain.value = 0;
    node.port.onmessage = event => onFrame(event.data as Float32Array, context!.sampleRate);
    source.connect(node); node.connect(mute); mute.connect(context.destination);
    stream.getAudioTracks().forEach(track => { track.onended = () => onError('麦克风已断开，请重新选择输入设备。'); });
    await context.resume();
    return { stop: async () => {
      node.port.onmessage = null;
      stream.getTracks().forEach(track => { track.onended = null; track.stop(); });
      source.disconnect(); node.disconnect(); mute.disconnect(); await context!.close();
    } };
  } catch (error) {
    stream.getTracks().forEach(track => track.stop());
    await context?.close();
    throw error;
  }
}
