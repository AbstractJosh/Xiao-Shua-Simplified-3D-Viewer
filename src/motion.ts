/**
 * Whether the app's decorative movement plays.
 *
 * THE OS HAS AN OPINION AND THE APP CAN OVERRULE IT. Browsers report
 * `prefers-reduced-motion: reduce` when the system asks for less movement --
 * on Windows that is Settings > Accessibility > Visual effects > Animation
 * effects, which is off on a good many machines for reasons that have nothing
 * to do with the front door's loop. A page cannot change what the browser
 * reports; it can only decide what to do with it, and this is where that is
 * decided. `system` does what the app always did and follows the report; `on`
 * plays everything whatever the OS says; `off` stills everything whatever it
 * says.
 *
 * APPLIED THE WAY THE THEME IS. The resolved answer is written to `data-motion`
 * on the document element as `full` or `reduce`, and every reduced-motion rule
 * in the stylesheet keys off that attribute rather than off the media query --
 * so one switch governs the console's idle turns, the welcome loop and the
 * stylesheet's own small travels together, and none of them can disagree with
 * the setting. `console/motion.ts` is the runtime half; `App` writes the
 * attribute.
 *
 * Plain data with no imports, like `theme.ts` and `screens.ts`, so the store,
 * the persistence table and the check suite can read it without a component.
 */
export type Motion = 'off' | 'system' | 'on'

/** Every answer on offer, in the order the switch shows them: from nothing
 *  moving, through the system's own answer, to everything moving. */
export const MOTION_MODES: Motion[] = ['off', 'system', 'on']

/** What each is called on the switch. */
export const MOTION_LABELS: Record<Motion, string> = {
  off: 'Off',
  system: 'System',
  on: 'On',
}

/** What a first visit gets. On, and deliberately not the system's answer: the
 *  OS switch that feeds the report is off on plenty of machines for reasons
 *  that have nothing to do with a front door, and a loop that never played
 *  for them would be a loop nobody knew was there. System is one press away
 *  for anyone who did mean it. */
export const DEFAULT_MOTION: Motion = 'on'

/** The attribute the stylesheet keys off, named once so the hook that writes
 *  it and the rules that read it cannot disagree. */
export const MOTION_ATTRIBUTE = 'data-motion'

/** What the OS reports, or false anywhere there is no window to ask. */
export function systemPrefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** The setting and the system's report, resolved to one answer. */
export function reducedMotion(motion: Motion, system: boolean): boolean {
  if (motion === 'on') return false
  if (motion === 'off') return true
  return system
}
