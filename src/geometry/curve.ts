/**
 * A curve through placed points, with a handle on each: the arithmetic behind
 * every tool in the app that is aimed by PUTTING POINTS DOWN rather than by
 * dragging something.
 *
 * ITS OWN FILE BECAUSE THE PLANE IS NOT PART OF IT. There are two such tools now
 * and they work in planes that have nothing to do with each other -- the laser
 * cutter's is one square face of a block, in that face's own (u, v), and the
 * lathe's is a section through a turning piece, in (height, radius). Neither
 * fact reaches any function here: a chain of Beziers through a run of points is
 * the same chain whatever the two numbers mean, and the moment one of these
 * started asking which it was, it would have to be written twice.
 *
 * It lived in `laserCut.ts` while there was only one caller, which was the right
 * place for it right up until there were two. What is still there is the part
 * that really is about cutting a block: the rope stabiliser, the resampling, the
 * kerf.
 *
 * WHAT IS DELIBERATELY NOT HERE is anything that reads the result. Sampling a
 * curve into a wall of radii is the lathe's business and sampling it into a cut
 * is the laser's; both take a polyline out of here and neither tells the other
 * what it did with it.
 */

/** A point in whatever plane the caller is working in. */
export type Pt = [number, number]

const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]]
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]]
const scale = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k]

/**
 * The handle each point would carry if the curve through them were fitted
 * rather than adjusted -- one half of what makes a fitted curve and a
 * hand-aimed one the same tool.
 *
 * A uniform Catmull-Rom spline IS a chain of cubic Béziers whose controls sit a
 * sixth of the way along the chord between a point's two neighbours. So the
 * fitted curve and the hand-adjusted one are the same arithmetic given
 * different handles, and taking hold of a handle leaves the curve exactly where
 * it was with its handles now showing. Two separate curve types would have made
 * that a visible jump.
 *
 * The ends use a one-sided difference, which is what makes the curve leave the
 * first point heading at the second rather than curling.
 *
 * A CLOSED RUN HAS NO ENDS, and that is the whole of what `closed` changes.
 * The first point's neighbours become the last one and the second, the last
 * point's the one before it and the first, and every handle is a sixth of a
 * full span. Without it the seam is the one place on a loop where two one-sided
 * differences meet, so the ring would carry a corner at the very point it was
 * closed at -- which is the point the user just clicked, and so the one they
 * are looking straight at.
 */
export function fittedHandles(points: Pt[], closed = false): Pt[] {
  const n = points.length
  if (n < 2) return points.map(() => [0, 0] as Pt)
  if (closed && n > 2) {
    return points.map((_, i) => {
      const before = points[(i - 1 + n) % n]
      const after = points[(i + 1) % n]
      return scale(sub(after, before), 1 / 6)
    })
  }
  return points.map((_, i) => {
    const before = points[Math.max(0, i - 1)]
    const after = points[Math.min(n - 1, i + 1)]
    // Halved at an end, where the difference spans one interval rather than
    // two, so the handle is the same length per interval everywhere.
    const span = i === 0 || i === n - 1 ? 3 : 6
    return scale(sub(after, before), 1 / span)
  })
}

/**
 * The curve through a run of points with mirrored handles, as a polyline.
 *
 * MIRRORED IS THE WHOLE OF THE HANDLE MODEL: one offset per point, used
 * forwards out of it and backwards into it, so the curve cannot kink at a point
 * and there is no second handle to keep in step. It is what the tool's sketch
 * asks for -- one straight line through the dot -- and it halves the state.
 *
 * `perSegment` samples per span. Fixed rather than adaptive because every caller
 * resamples the result to its own step immediately afterwards anyway; all this
 * has to do is not miss the shape.
 *
 * `closed` ADDS ONE MORE SPAN, from the last point back to the first, and
 * changes nothing else: a ring is this chain with the link that was missing.
 * What comes back therefore ends ON its own first point, exactly rather than
 * nearly -- a cubic at t = 1 is its far end untouched -- and that repeated
 * point is how everything downstream reads the line as a loop without being
 * handed a flag. See `isClosedLine`.
 */
export function bezierChain(
  points: Pt[],
  handles: Pt[],
  perSegment = 16,
  closed = false
): Pt[] {
  if (points.length < 2) return points.slice()
  // Two points enclose nothing, so a "ring" of them is the segment it already
  // was rather than a chain doubling back along itself.
  const ring = closed && points.length > 2

  const out: Pt[] = [points[0]]
  for (let i = 0; i < (ring ? points.length : points.length - 1); i += 1) {
    const p0 = points[i]
    // Round the seam on the last span of a ring, and simply the next point
    // everywhere else.
    const far = (i + 1) % points.length
    const p3 = points[far]
    const c1 = add(p0, handles[i] ?? [0, 0])
    // Backwards out of the far point, which is what "mirrored" means.
    const c2 = sub(p3, handles[far] ?? [0, 0])
    for (let s = 1; s <= perSegment; s += 1) {
      const t = s / perSegment
      const m = 1 - t
      const a = m * m * m
      const b = 3 * m * m * t
      const c = 3 * m * t * t
      const d = t * t * t
      out.push([
        a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
        a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1],
      ])
    }
  }
  return out
}

/**
 * The handle every point is actually drawn and worked with: the one it was
 * aimed to, or the fit where it has not been.
 *
 * ONE PLACE THE TWO ARE RECONCILED, which is why it is a function rather than
 * three call sites each writing `?? fitted[i]`. The line that is applied, the
 * line that is previewed and the grips a hand takes hold of all have to agree
 * about where a tangent points -- a grip drawn from the fit while the tool used
 * something else would be a handle that moves the curve from somewhere other
 * than where it is standing.
 *
 * The fit is computed once for the run rather than per point: it is a function
 * of every point, so asking for one costs what asking for all of them costs.
 *
 * `closed` goes straight through to the fit, and it has to: the grips a hand
 * takes hold of are drawn from what comes back here, so a caller that closed
 * the loop for the line but not for the handles would put the tangents of one
 * curve on another.
 */
export function curveHandles(
  points: Pt[],
  handles: (Pt | null)[],
  closed = false
): Pt[] {
  const fitted = fittedHandles(points, closed)
  return points.map((_, i) => handles[i] ?? fitted[i])
}
