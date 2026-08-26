import type { Shape2D } from './types'

export type Point2 = [number, number]

const CIRCLE_SEGMENTS = 48

/** Extra samples per straight edge when the host surface is curved, so the
 *  swept wall follows the curvature instead of chording across it. */
const CURVED_EDGE_SUBDIVISIONS = 8

/**
 * Sample a shape into a closed, counter-clockwise outline in the tangent frame.
 *
 * CCW matters: the prism builder assumes it when orienting faces, and the
 * tangent basis is built so that uDir cross vDir === surface normal. Reverse
 * the winding and every generated face points inward.
 *
 * All three v1 shapes are convex, which is what lets the prism caps use a
 * simple triangle fan. A concave shape would need proper triangulation.
 */
export function sampleOutline(
  shape: Shape2D,
  rotation: number,
  curved: boolean
): Point2[] {
  const raw = rawOutline(shape, curved)
  if (rotation === 0) return raw
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  return raw.map(([x, y]): Point2 => [x * cos - y * sin, x * sin + y * cos])
}

/**
 * One of the outline's OWN axes, written in the surface's (u, v).
 *
 * The sketch gizmo's two tangent arrows lie along these rather than along the
 * surface's raw u and v, so that a right-drag stretches the dimension the arrow
 * is actually pointing down -- on a rectangle spun 30 degrees, the width axis is
 * spun with it. A slide is stored in (u, v) though, so the travel an arrow reads
 * has to come back here to be written down.
 *
 * Here beside `sampleOutline` because it IS that rotation, applied to the unit
 * axes instead of to the shape: the two would silently disagree the moment one
 * of them changed sign convention, and the disagreement would show up as a
 * sketch that slid sideways when it was dragged along its own edge.
 */
export function outlineAxis(axis: 0 | 1, rotation: number): Point2 {
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  return axis === 0 ? [cos, sin] : [-sin, cos]
}

function rawOutline(shape: Shape2D, curved: boolean): Point2[] {
  switch (shape.type) {
    case 'circle':
      return radialOutline(shape.r, CIRCLE_SEGMENTS)
    case 'ngon':
      return radialOutline(shape.r, Math.max(3, Math.round(shape.sides)))
    case 'rect': {
      const hw = shape.w / 2
      const hh = shape.h / 2
      const corners: Point2[] = [
        [-hw, -hh],
        [hw, -hh],
        [hw, hh],
        [-hw, hh],
      ]
      return curved ? subdivide(corners, CURVED_EDGE_SUBDIVISIONS) : corners
    }
  }
}

function radialOutline(r: number, segments: number): Point2[] {
  const pts: Point2[] = []
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    pts.push([Math.cos(a) * r, Math.sin(a) * r])
  }
  return pts
}

/** Insert `n - 1` extra points along each edge of a closed polygon. */
function subdivide(pts: Point2[], n: number): Point2[] {
  if (n <= 1) return pts
  const out: Point2[] = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    for (let s = 0; s < n; s++) {
      const t = s / n
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }
  return out
}
