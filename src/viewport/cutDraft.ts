import { create } from 'zustand'
import { bezierChain, fittedHandles, resample, ropeFollow } from '../geometry/laserCut'
import type { FaceAxis, Pt } from '../geometry/laserCut'

/**
 * THE LINE YOU ARE DRAWING, before it is a cut.
 *
 * Its own store rather than a field in `toolStore`, the way `useMarquee` is its
 * own: this is state a gesture in the viewport writes many times a second and
 * exactly one component draws. Putting it in the tool store would sit a
 * hundred-point array next to the theme and the unit, in the file every control
 * in the bar subscribes to.
 *
 * It is NOT in `laserStore` either, and that line is the one that matters most.
 * A draft is not a thing you have made -- it is what you are about to do,
 * abandoned by Reset, replaced by the next stroke, and never in the undo
 * history. `laserStore` holds pieces, and a draft is not a piece until Apply
 * has turned it into one.
 *
 * WHICH FACE IT BELONGS TO IS PART OF IT. A line is a pair of numbers per point
 * in one face's own (u, v), which means nothing without saying whose. The
 * viewport clears the draft when the compass settles somewhere else -- a line
 * you cannot see is worse than no line, because Apply would still fire it.
 */

/** The two ways of putting a line on a face -- one tool each. */
export type DraftKind = 'freehand' | 'points'

type DraftState = {
  /** The face the draft is drawn on, or null when there is no draft. */
  face: FaceAxis | null
  kind: DraftKind
  /**
   * The freehand stroke, as the STABILISER left it rather than as the pointer
   * moved.
   *
   * What is recorded is where the tool got to, not where the hand went -- see
   * `ropeFollow`. That is the whole of what the smoothing dial does, and doing
   * it here rather than at Apply is what makes the line on screen the line that
   * will be cut: a filter applied afterwards would show one shape and burn
   * another.
   */
  stroke: Pt[]
  /** The placed points, in the order they were placed. */
  points: Pt[]
  /**
   * One mirrored handle offset per point, used forwards out of a point and
   * backwards into it -- see `bezierChain` -- or NULL for a point whose tangent
   * is still the curve's own.
   *
   * NULL IS WHAT REPLACED A WHOLE MODE. There used to be three readings of a
   * set of points: straight, a fitted curve, and "Manual", which was the fitted
   * curve with every tangent handed over to the user at once. That made owning
   * a handle a property of the TOOL, so aiming a single point cost you the fit
   * on every other point, and there was no way to say "this tangent is mine and
   * the rest are the curve's".
   *
   * Per point, that sentence has somewhere to live. A point is placed with a
   * null and takes the fitted tangent for as long as it holds one -- so moving
   * its neighbours goes on reshaping the curve through it, which is the whole
   * value of a fit. Aim its handle and the null is replaced by the offset you
   * aimed, and from then on that tangent is yours and stays put. See
   * `curveHandles`, where the two are read as one list.
   *
   * Ignored outright while the curve is off: a straight segment has no tangent
   * to aim. The aimed ones are KEPT through it rather than dropped, so turning
   * the curve off to reposition a point and on again does not throw away the
   * shaping already done.
   */
  handles: (Pt | null)[]
  /** Take up a tool on a face. Clears whatever was being drawn. */
  begin: (face: FaceAxis, kind: DraftKind) => void
  /** Start a fresh stroke at a point. One stroke is one line: a second press
   *  replaces the first rather than adding to it. */
  strokeFrom: (at: Pt) => void
  /** Carry the stroke toward the pointer on the end of a rope of `slack`. */
  strokeTo: (pointer: Pt, slack: number) => void
  /**
   * Put another point down at the end of the line.
   *
   * It arrives with a NULL handle, which is to say with the curve's own
   * tangent. No flag and no refitting: the fit is a function of the points and
   * is computed whenever the line is read, so a new last point changes the
   * tangent at the one before it for free -- unless that one has been aimed by
   * hand, in which case leaving it exactly alone is what was wanted.
   */
  addPoint: (at: Pt) => void
  /**
   * Move a placed point.
   *
   * Handles are not touched, and do not need to be. The fitted ones are derived
   * from the points, so they follow the drag on their own; an aimed one is the
   * user's answer to a question the drag has not asked again, so carrying it
   * along unchanged is what keeps hand-shaping from being undone by a nudge.
   */
  movePoint: (index: number, at: Pt) => void
  /**
   * Aim one point's handles.
   *
   * `at` is where the handle was dragged to, in face coordinates; the offset is
   * what is stored, and its mirror is the other handle. Which of the two was
   * grabbed is `side`: dragging the incoming one aims the pair the other way
   * about, which is the only way a mirrored pair can answer both handles.
   */
  moveHandle: (index: number, at: Pt, side: 1 | -1) => void
  /**
   * Hand one point's tangent back to the curve.
   *
   * The way out of an aimed handle, and the reason aiming one is not a trap:
   * without it the only road back to a fitted tangent would be to delete the
   * point and place it again. Inert on a point that has not been aimed.
   */
  refitHandle: (index: number) => void
  /** Throw the drawing away, keeping the face and the tool. */
  clear: () => void
}

const empty = { stroke: [] as Pt[], points: [] as Pt[], handles: [] as (Pt | null)[] }

export const useCutDraft = create<DraftState>((set) => ({
  face: null,
  kind: 'freehand',
  ...empty,

  begin: (face, kind) => set({ face, kind, ...empty }),
  clear: () => set({ ...empty }),

  strokeFrom: (at) => set({ stroke: [at] }),
  strokeTo: (pointer, slack) =>
    set((s) => {
      if (s.stroke.length === 0) return s
      const from = s.stroke[s.stroke.length - 1]
      const to = ropeFollow(from, pointer, slack)
      // The rope holding still is the ordinary case with any slack at all, and
      // appending a point per frame that went nowhere would grow the stroke
      // without changing its shape.
      if (to[0] === from[0] && to[1] === from[1]) return s
      return { stroke: [...s.stroke, to] }
    }),

  addPoint: (at) =>
    set((s) => ({ points: [...s.points, at], handles: [...s.handles, null] })),

  movePoint: (index, at) =>
    set((s) => {
      if (index < 0 || index >= s.points.length) return s
      return { points: s.points.map((p, i) => (i === index ? at : p)) }
    }),

  moveHandle: (index, at, side) =>
    set((s) => {
      const point = s.points[index]
      if (!point) return s
      const offset: Pt = [(at[0] - point[0]) * side, (at[1] - point[1]) * side]
      return { handles: s.handles.map((h, i) => (i === index ? offset : h)) }
    }),

  refitHandle: (index) =>
    set((s) => {
      if (s.handles[index] == null) return s
      return { handles: s.handles.map((h, i) => (i === index ? null : h)) }
    }),
}))

/**
 * The handle every point is actually drawn and cut with: the one it was aimed
 * to, or the fit where it has not been.
 *
 * ONE PLACE THE TWO ARE RECONCILED, which is why it is a function rather than
 * three call sites each writing `?? fitted[i]`. The line that is cut, the line
 * that is previewed and the grips a hand takes hold of all have to agree about
 * where a tangent points -- a grip drawn from the fit while the cut used
 * something else would be a handle that moves the curve from somewhere other
 * than where it is standing.
 *
 * The fit is computed once for the run rather than per point: it is a function
 * of every point, so asking for one costs what asking for all of them costs.
 */
export function curveHandles(points: Pt[], handles: (Pt | null)[]): Pt[] {
  const fitted = fittedHandles(points)
  return points.map((_, i) => handles[i] ?? fitted[i])
}

/**
 * The line a draft actually describes: the one the preview draws and the one
 * Apply cuts with.
 *
 * ONE FUNCTION FOR ALL THREE CASES, which is the point of it. The preview and
 * the cut must never disagree about what the line is -- a preview computed one
 * way and a cut computed another is a tool that burns something other than what
 * it showed -- so both call this and there is nothing to keep in step.
 *
 * A stroke is its own line. Points with the curve OFF are the polyline itself.
 * With it on they are a Bézier chain through those same points, given whatever
 * mixture of aimed and fitted tangents `curveHandles` resolves -- which is also
 * why throwing the switch does not make the line jump: a run with nothing aimed
 * yet is exactly the fitted curve. See `fittedHandles`.
 */
export function draftLine(
  draft: Pick<DraftState, 'kind' | 'stroke' | 'points' | 'handles'>,
  fit: boolean
): Pt[] {
  if (draft.kind === 'freehand') {
    return draft.stroke.length < 2 ? [] : resample(draft.stroke)
  }
  if (draft.points.length < 2) return []
  if (!fit) return draft.points
  return bezierChain(draft.points, curveHandles(draft.points, draft.handles))
}

/** Whether there is enough of a drawing to cut with. */
export function draftReady(
  draft: Pick<DraftState, 'kind' | 'stroke' | 'points' | 'handles'>,
  fit: boolean
): boolean {
  return draftLine(draft, fit).length >= 2
}
