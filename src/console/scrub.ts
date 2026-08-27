/**
 * Dragging a number box sideways to change it, in arithmetic alone.
 *
 * Its own module, with no React in it, for the reason `marquee` has none: what
 * a pixel of travel is worth is the whole of this control, and it is a question
 * that can be answered -- and checked -- without a pointer.
 */

/**
 * How far the pointer must travel before a press counts as a drag.
 *
 * A number box answers three gestures now, and this is what keeps them apart: a
 * press that goes nowhere is a click and changes nothing, and only past this is
 * a value being dragged. Without it, every double click would land on a value a
 * pixel or two from where it started -- and the box a user double-clicks is
 * usually one they are about to type an exact number into.
 */
export const SCRUB_SLOP = 3

/**
 * Pixels of travel to cross a control's whole range.
 *
 * Deliberately longer than the slider beside it, which crosses in about a
 * hundred and thirty. The two are not the same control at different sizes: the
 * slider is for finding roughly the right place, and the box is where a number
 * is settled to the step. A scrub that matched the slider's rate would be a
 * second slider, and a worse one, since it has no track to show where it is.
 */
export const SCRUB_SPAN = 600

/**
 * What one pixel of drag is worth on a given control.
 *
 * The wider the range, the more each pixel carries -- except that it never
 * carries less than one step, which is the smallest change the control can
 * make anyway. That floor is what keeps a finely-stepped field from needing a
 * drag across two monitors: a position runs -8 to 8 in steps of 0.05, so its
 * pixel is a step, and 320 of them cross the lot.
 */
export function scrubRate(min: number, max: number, step: number): number {
  if (!(step > 0)) return (max - min) / SCRUB_SPAN
  return Math.max(step, (max - min) / SCRUB_SPAN)
}

/**
 * Where a value lands, dragged `dx` pixels from where the press started.
 *
 * Measured from the value at the PRESS rather than folded into the running one,
 * the same rule the gizmo's arrow drags follow and for the same reason: a
 * pointer held still must not creep, and a drag that runs past a limit and
 * comes back must arrive where it left. Adding a delta per frame does neither
 * -- it loses everything the clamp swallowed, so the value comes back short.
 *
 * Snapped to the step on the way out, so a dragged number is one the box could
 * also have been typed with, and rounded off the floating-point tail that
 * multiplying a step by an integer leaves behind.
 */
export function scrubbed(
  from: number,
  dx: number,
  min: number,
  max: number,
  step: number
): number {
  const raw = from + dx * scrubRate(min, max, step)
  const stepped = step > 0 ? Math.round(raw / step) * step : raw
  return Number(Math.min(max, Math.max(min, stepped)).toFixed(6))
}
