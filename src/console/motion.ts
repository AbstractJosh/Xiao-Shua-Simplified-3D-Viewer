import { useEffect, useState } from 'react'
import { reducedMotion, systemPrefersReducedMotion } from '../motion'
import { useTools } from '../store/toolStore'

/**
 * Whether to hold still, for anything that asks once as it starts.
 *
 * Both idle animations in the console -- the polygon chip and the sided rows of
 * the Solids list -- and the clipboard's turntable ask this before they start,
 * so the setting silences the panel rather than half of it. It reads the Motion
 * setting first and the system only when the setting says to; see `motion.ts`
 * at the root for the three answers and what each means.
 */
export function prefersReducedMotion(): boolean {
  return reducedMotion(useTools.getState().motion, systemPrefersReducedMotion())
}

/**
 * The same answer as a hook, for anything that has to stop or start WHEN IT
 * CHANGES rather than ask once: the welcome loop, and the attribute the
 * stylesheet reads. Follows the switch through the store and the system through
 * the media query's own change event, so flipping either mid-session takes
 * effect without a reload.
 */
export function useReducedMotion(): boolean {
  const motion = useTools((s) => s.motion)
  const [system, setSystem] = useState(systemPrefersReducedMotion)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const read = () => setSystem(query.matches)
    read()
    query.addEventListener('change', read)
    return () => query.removeEventListener('change', read)
  }, [])
  return reducedMotion(motion, system)
}
