/**
 * Pure polygon-icon geometry, kept out of the component so it can be tested
 * and previewed without React.
 */

/**
 * Side counts offered by the polygon chip, ordered as the user reads them off
 * the button: index 0 sits at the BOTTOM. Rare counts (7, 9, 11) are omitted
 * rather than diluting the target areas.
 */
export const NGON_SIDES = [3, 4, 5, 6, 8, 10]

export const NGON_NAMES: Record<number, string> = {
  3: 'Triangle',
  4: 'Square',
  5: 'Pentagon',
  6: 'Hexagon',
  8: 'Octagon',
  10: 'Decagon',
}

export const DEFAULT_SIDES = 6

/** Bands are laid out top-down, so the display order is the reverse. */
export const NGON_SIDES_TOP_DOWN = [...NGON_SIDES].reverse()

const TWO_PI = Math.PI * 2

/** The icon canvas is 32x32, so every outline is drawn around its middle. */
const CENTRE = 16

/**
 * Where a polygon's corners sit.
 *
 * Even-sided shapes are rotated half a step so they rest on a flat edge, which
 * is how a square and an octagon are read; odd-sided ones keep a vertex at the
 * top, which is how a triangle and a pentagon are read.
 */
function vertexAngles(sides: number): number[] {
  const start = -Math.PI / 2 + (sides % 2 === 0 ? Math.PI / sides : 0)
  return Array.from({ length: sides }, (_, i) => start + (i / sides) * Math.PI * 2)
}

const point = (angle: number, radius: number) =>
  `${(CENTRE + Math.cos(angle) * radius).toFixed(2)},${(CENTRE + Math.sin(angle) * radius).toFixed(2)}`

/** Vertices of a regular n-gon on the icon canvas. */
export function ngonPoints(sides: number, r = 12): string {
  return vertexAngles(sides)
    .map((a) => point(a, r))
    .join(' ')
}

/**
 * What the chip calls itself while it is showing the whole family rather than
 * one member of it. The chip is a polygon *picker*, and resting under the name
 * of whichever polygon happened to be last used read as "this places hexagons".
 */
export const NGON_LABEL = 'Polygon'

/** How long a polygon is held before the idle chip morphs on to the next. */
export const NGON_HOLD_MS = 1000

/** And how long that morph runs. Long enough to follow, short enough to ignore. */
export const NGON_MORPH_MS = 200

/** Next count in the idle chip's cycle; wraps, and an unknown count restarts it. */
export function nextNgonSides(sides: number): number {
  return NGON_SIDES[(NGON_SIDES.indexOf(sides) + 1) % NGON_SIDES.length]
}

/**
 * Angles the morph samples every outline at: every corner angle of every
 * polygon the chip offers, deduplicated and sorted into one ring.
 *
 * Two shapes can only be interpolated point by point if they have the same
 * number of points, and these six do not -- so each is resampled onto this
 * shared ring first. Sampling at the union of all corners is what makes that
 * resampling lossless: between any two neighbouring angles here, NO polygon
 * has a corner, so every one of them runs dead straight across the gap and is
 * reproduced exactly rather than approximated. A morph therefore starts and
 * ends on the real shape, and the held polygon needs no separate code path.
 */
export const MORPH_ANGLES: number[] = (() => {
  const wrap = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI
  const sorted = NGON_SIDES.flatMap(vertexAngles).map(wrap).sort((a, b) => a - b)
  const tol = 1e-9
  const ring: number[] = []
  for (const a of sorted) {
    const last = ring.at(-1)
    if (last !== undefined && a - last < tol) continue
    // The seam hands back the same corner as ~0 and as ~2*PI when two polygons
    // compute it from different arithmetic; that pair is one angle, not two.
    if (ring.length > 0 && a - ring[0] > TWO_PI - tol) continue
    ring.push(a)
  }
  return ring
})()

/**
 * How far the polygon's edge is from the centre at each ring angle.
 *
 * A regular polygon is its apothem stretched by how obliquely the ray crosses
 * the edge it hits, so the angle is folded onto a single edge and measured
 * from that edge's midpoint.
 */
export function ngonRadii(sides: number, r = 12): number[] {
  const step = TWO_PI / sides
  const half = Math.PI / sides
  const apothem = r * Math.cos(half)
  const firstMidpoint = vertexAngles(sides)[0] + half
  return MORPH_ANGLES.map((angle) => {
    const off = angle - firstMidpoint
    const psi = (((off + half) % step) + step) % step - half
    return apothem / Math.cos(psi)
  })
}

/**
 * The outline `t` of the way from one polygon to another, 0 and 1 landing on
 * the real shapes. Corners slide along fixed rays, so the chip reads as one
 * outline rethinking itself rather than as a shape spinning to fit the next
 * one -- which is what index-by-index interpolation would give, since a
 * triangle points up where a square shows a corner.
 *
 * Eased out: the morph is short, and arriving is the part worth seeing.
 */
export function morphPoints(from: number, to: number, t: number, r = 12): string {
  const a = ngonRadii(from, r)
  const b = ngonRadii(to, r)
  const eased = t * (2 - t)
  return MORPH_ANGLES.map((angle, i) => point(angle, a[i] + (b[i] - a[i]) * eased)).join(' ')
}
