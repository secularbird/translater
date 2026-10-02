// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, addPluginListener } from '@tauri-apps/api/core';
import { requestCapturePermission, startCapture } from './capture';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn(), addPluginListener: vi.fn() }));
const unregister = vi.fn(async () => {});
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers();
  vi.stubGlobal('navigator', { userAgent: 'Android' });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.mocked(addPluginListener).mockResolvedValue({ unregister } as unknown as Awaited<ReturnType<typeof addPluginListener>>);
  vi.mocked(invoke).mockImplementation(async command => {
    if (command.endsWith('check_permissions')) return { microphone: 'prompt' };
    if (command.endsWith('request_permissions')) return { microphone: 'granted' };
    if (command.endsWith('status')) return { recording: true };
    return undefined;
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('native microphone state reconciliation', () => {
  it('uses the declared permission command and stops polling after capture ends', async () => {
    const capture = await startCapture('', () => {}, () => {});
    expect(invoke).toHaveBeenCalledWith('plugin:microphone|request_permissions', { permissions: ['microphone'] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(invoke).toHaveBeenCalledWith('plugin:microphone|status');
    await capture.stop();
    const calls = vi.mocked(invoke).mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(invoke).toHaveBeenCalledTimes(calls);
    expect(unregister).toHaveBeenCalledTimes(2);
  });
  it('detects a native stop even when the suspended WebView missed the event', async () => {
    const onError = vi.fn();
    const capture = await startCapture('', () => {}, onError);
    vi.mocked(invoke).mockResolvedValue({ recording: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledWith('录音已被系统暂停，请重新开始。');
    await capture.stop();
  });
  it('does not subscribe to audio or start native recording after permission denial', async () => {
    vi.mocked(invoke).mockResolvedValue({ microphone: 'denied' });
    await expect(startCapture('', () => {}, () => {})).rejects.toThrow('权限未开启');
    expect(addPluginListener).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('releases models only before a required native permission prompt, without opening audio', async () => {
    const release = vi.fn();
    await requestCapturePermission(release);
    expect(release).toHaveBeenCalledTimes(1);
    expect(addPluginListener).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('plugin:microphone|start');
    release.mockClear();
    vi.mocked(invoke).mockResolvedValue({ microphone: 'granted' });
    await requestCapturePermission(release);
    expect(release).not.toHaveBeenCalled();
  });
});
