/** Perceptual display only. Speech detection remains exclusively Silero VAD. */
export function inputLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const decibels = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (decibels + 60) / 45));
}
