/**
 * Motion the user did not ask for and cannot stop; honour the system setting.
 *
 * Both idle animations in the console -- the polygon chip and the sided rows of
 * the Solids list -- ask this before they start, so the setting silences the
 * panel rather than half of it.
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}
