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
 * What one pixel of drag is worth at the START of a gesture -- the finest the
 * control goes.
 *
 * One step, always. The step IS the smallest change the control can make, so a
 * first pixel worth less than one would move nothing, and one worth more would
 * put values out of reach that the box can hold and the keyboard can type.
 */
export function scrubRate(_min: number, _max: number, step: number): number {
  return step > 0 ? step : 0
}

/**
 * How far a drag has travelled after `dx` pixels -- the whole of the feel.
 *
 * It ACCELERATES. A flat rate cannot serve a control whose range is five
 * thousand times its step: pick the rate that nudges a millimetre and crossing
 * the range takes a drag five metres long; pick the rate that crosses the
 * range and the smallest thing you can do is jump a centimetre. This app now
 * has exactly that spread -- `dimensions.ts` runs from 0.01 to 50 -- and the
 * old flat `range / 600` is what made a position scrub three times coarser the
 * moment the envelope grew.
 *
 * So the first pixels are worth one step each and the rate climbs with the
 * distance already dragged: a nudge stays a nudge, and the same gesture, kept
 * going, still crosses the whole range in the SCRUB_SPAN pixels it always did.
 *
 * Quadratic, and deliberately the simplest curve that can be:
 *
 *     travel(d) = step * d + k * d^2
 *
 * with `k` solved so that `travel(SCRUB_SPAN)` lands exactly on the range. When
 * the range is narrow enough that a step a pixel already crosses it -- a
 * rotation, a snap distance -- `k` comes out negative and is floored at zero,
 * and this degrades into precisely the flat rate it replaced.
 *
 * ODD IN `dx`, and it has to be: `scrubbed` measures from the value at the
 * press, so `travel(-d) === -travel(d)` is what makes a drag that runs out and
 * comes back arrive exactly where it left rather than a little short.
 *
 * It is also unchanged by a change of UNITS. Scale `min`, `max` and `step`
 * together -- millimetres to centimetres -- and `step * d` and `k * d^2` both
 * scale with them, so a pixel is worth the same distance in the WORLD whatever
 * is written on screen.
 */
export function scrubTravel(dx: number, min: number, max: number, step: number): number {
  const range = max - min
  if (!(step > 0)) return (dx * range) / SCRUB_SPAN
  // What the flat part alone would cover, and so what is left for the ramp.
  const ramp = Math.max(0, range - SCRUB_SPAN * step) / (SCRUB_SPAN * SCRUB_SPAN)
  const d = Math.abs(dx)
  return Math.sign(dx) * (step * d + ramp * d * d)
}

/**
 * The stretch of the range a SLIDER TRACK should span.
 *
 * A track is about a hundred and thirty pixels wide. Handing it the whole of a
 * hundred-unit position range puts nearly eight centimetres under every pixel,
 * which is not a control so much as a rough guess -- and it got that way for
 * the same reason the scrub did, by the range growing underneath it.
 *
 * So the track shows a WINDOW: an eighth of the range, centred on where the
 * value currently sits, clamped so it never runs off either end. Eight grabs
 * still cross the lot, which is what the track is for -- finding roughly the
 * right place -- and the box beside it was always the one for settling an
 * exact number.
 *
 * The floor matters as much as the fraction. On a control whose range is small
 * next to its step, an eighth would be a handful of steps wide and the thumb
 * would jump between three positions; below `TRACK_PIXELS * step` the window
 * opens back out, and a narrow-ranged control simply keeps the full track it
 * always had.
 */
export const TRACK_PIXELS = 130
export const TRACK_FRACTION = 8

export function trackWindow(
  value: number,
  min: number,
  max: number,
  step: number
): { lo: number; hi: number } {
  const range = max - min
  const width = Math.min(
    range,
    Math.max(range / TRACK_FRACTION, step > 0 ? TRACK_PIXELS * step : 0)
  )
  if (!(width > 0) || width >= range) return { lo: min, hi: max }
  // Centred on the value, then slid back inside the range rather than
  // truncated: a window clipped at an end would be half as wide there, and the
  // track would change sensitivity as it neared the limits.
  const half = width / 2
  const lo = Math.min(Math.max(value - half, min), max - width)
  return { lo, hi: lo + width }
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
  const raw = from + scrubTravel(dx, min, max, step)
  const stepped = step > 0 ? Math.round(raw / step) * step : raw
  return Number(Math.min(max, Math.max(min, stepped)).toFixed(6))
}
