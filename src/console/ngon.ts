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

/**
 * Vertices of a regular n-gon on a 32x32 icon canvas.
 *
 * Even-sided shapes are rotated half a step so they rest on a flat edge, which
 * is how a square and an octagon are read; odd-sided ones keep a vertex at the
 * top, which is how a triangle and a pentagon are read.
 */
export function ngonPoints(sides: number, r = 12): string {
  const start = -Math.PI / 2 + (sides % 2 === 0 ? Math.PI / sides : 0)
  return Array.from({ length: sides }, (_, i) => {
    const a = start + (i / sides) * Math.PI * 2
    return `${(16 + Math.cos(a) * r).toFixed(2)},${(16 + Math.sin(a) * r).toFixed(2)}`
  }).join(' ')
}
