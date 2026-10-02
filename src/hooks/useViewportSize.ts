import { useEffect } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';

/** WebViews may pan the visual viewport for the IME without changing 100dvh. */
export function useViewportSize() {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let frame = 0;
    let unobscuredHeight = window.innerHeight;
    let width = window.innerWidth;
    let active = true, queryingInsets = false;
    const nativeInsets = async () => {
      if (!active || queryingInsets || !isTauri() || !/Android/i.test(navigator.userAgent)) return;
      queryingInsets = true;
      try {
        const insets = await invoke<Record<'top' | 'right' | 'bottom' | 'left', number>>('plugin:microphone|insets');
        if (active) for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
          if (Number.isFinite(insets[edge]) && insets[edge] >= 0) root.style.setProperty(`--native-safe-area-${edge}`, `${insets[edge]}px`);
        }
      } catch { /* Browser/iOS use CSS environment insets; older APKs can too. */ }
      finally { queryingInsets = false; }
    };
    const update = () => {
      const unzoomed = !viewport || Math.abs(viewport.scale - 1) < 0.01;
      const height = unzoomed && viewport ? viewport.height : window.innerHeight;
      const top = unzoomed && viewport ? viewport.offsetTop : 0;
      const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
      if (!editing || width !== window.innerWidth) unobscuredHeight = window.innerHeight;
      width = window.innerWidth;
      root.style.setProperty('--app-height', `${Math.round(height)}px`);
      root.style.setProperty('--viewport-top', `${Math.round(top)}px`);
      root.dataset.compactViewport = String(height < 520);
      root.dataset.keyboardOpen = String(!!editing && unzoomed && unobscuredHeight - height > 120);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); void nativeInsets(); };
    update();
    void nativeInsets();
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
      root.style.removeProperty('--app-height'); root.style.removeProperty('--viewport-top');
      for (const edge of ['top', 'right', 'bottom', 'left']) root.style.removeProperty(`--native-safe-area-${edge}`);
      delete root.dataset.compactViewport; delete root.dataset.keyboardOpen;
    };
  }, []);
}
