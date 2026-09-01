import { create } from 'zustand'
import { bezierChain, curveHandles } from '../geometry/curve'
import { mirrorLines } from '../geometry/faceMirror'
import type { MirrorAxis } from '../geometry/faceMirror'
import { resample, ropeFollow } from '../geometry/laserCut'
import type { FaceAxis, Pt } from '../geometry/laserCut'

export { curveHandles }

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
  /**
   * Whether the run of points is a LOOP: the last one bridged back to the
   * first, so the line encircles a region instead of crossing the face.
   *
   * ONE BOOLEAN AND NO EXTRA POINT, which is the choice the rest of the file
   * follows from. The obvious alternative is to close the loop by appending a
   * copy of the first point to `points`, and it goes wrong immediately: the
   * copy is a knot the user can take hold of and drag, and dragging it opens a
   * gap at the seam that nothing on screen explains. It would also want a
   * handle of its own, giving the seam two tangents to disagree about.
   *
   * So the points stay exactly the points that were placed, and this says how
   * to read the run. The repeated point appears once, in `draftLine`, at the
   * moment the line is asked for -- which is also the only place anything needs
   * it. See `isClosedLine`, which is how the geometry then reads it back.
   *
   * FREEHAND NEVER SETS IT. A stroke has no knots to click on, so there is
   * nothing to press to close one, and the rope would never bring a hand back
   * to the exact point it started from anyway.
   */
  closed: boolean
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
   * Bridge the last point back to the first, or take the bridge out again.
   *
   * A TOGGLE RATHER THAN A ONE-WAY DOOR, because the gesture that fires it is
   * one click on one knot and a gesture with no way back is a trap. Clicking
   * the first point closes the loop; clicking it again opens it, and the points
   * are untouched either way -- so nothing is lost by trying it.
   *
   * INERT UNDER THREE POINTS. Two points bridged back to each other are the
   * same segment walked twice: it encircles nothing, there is no island for a
   * cut to drop out, and the "loop" would look exactly like the line already on
   * screen. A tool that reported itself closed while nothing had changed is
   * worse than one that did nothing. Opening is always allowed, so a run that
   * somehow arrived closed can always be opened again.
   */
  toggleClosed: () => void
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

// `closed` is in here rather than beside it, so every road to an empty
// drawing -- Reset, a new tool, a turn of the compass -- opens the line as well
// as emptying it. A draft with no points that still called itself closed would
// bridge the first two points placed after it.
const empty = {
  stroke: [] as Pt[],
  points: [] as Pt[],
  handles: [] as (Pt | null)[],
  closed: false,
}

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

  toggleClosed: () =>
    set((s) => {
      if (!s.closed && s.points.length < 3) return s
      return { closed: !s.closed }
    }),
}))

/* `curveHandles` is re-exported at the top rather than written here: the rule
   it states -- the aimed handle where there is one, the fit everywhere else --
   has to hold for the Lathe screen's points as well, and there is no reading of
   "one place the two are reconciled" that survives two copies of it. See
   `curve.ts`. */

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
 *
 * AND THIS IS WHERE A LOOP BECOMES ONE. `closed` is a way of reading the run
 * of points -- see the field -- and the reading is performed here, once, by
 * writing the first point out again at the end. Downstream nothing is told
 * anything: the preview offsets a strip along whatever line it is handed, and
 * the cut sweeps a wall along it, and both find the repeated point for
 * themselves. The bridge is therefore drawn and burned by the same arithmetic
 * as every other segment, which is the one property that stops a loop being a
 * second tool. See `isClosedLine`.
 */
export function draftLine(
  draft: Pick<DraftState, 'kind' | 'stroke' | 'points' | 'handles' | 'closed'>,
  fit: boolean
): Pt[] {
  if (draft.kind === 'freehand') {
    return draft.stroke.length < 2 ? [] : resample(draft.stroke)
  }
  if (draft.points.length < 2) return []
  // Two points cannot enclose anything, so a run that is somehow marked closed
  // and is too short to be is read as the open line it looks like.
  const ring = draft.closed && draft.points.length > 2
  if (!fit) return ring ? [...draft.points, draft.points[0]] : draft.points
  return bezierChain(
    draft.points,
    curveHandles(draft.points, draft.handles, ring),
    undefined,
    ring
  )
}

/**
 * Every line the drawing is about to burn: the one that was drawn, or -- with a
 * mirror standing on the face -- the part of it that falls inside the lit
 * region, and that part's reflections.
 *
 * ONE MORE STEP ALONG THE ROAD `draftLine` ALREADY WALKS, and it is here for
 * exactly the reason that one is. `draftLine` settles what the HAND drew; this
 * settles what the LASER gets, and the moment a mirror is standing those stop
 * being the same question. Both answers have to come from one place or the tool
 * is one that shows two lines and burns four. See `mirrorLines`.
 *
 * A LINE THAT ENDS ON THE AXIS IS SEWN TO ITS OWN REFLECTION. Draw half a shape
 * from the axis, round, and back to the axis, and what comes back is one CLOSED
 * line rather than two open ones -- so the shape drops out of the block as an
 * island, which is what the completed silhouette on screen was promising all
 * along. The join is `mirrorLines`' own work, and it is the reason this hands
 * back a set of lines rather than one copy per mirror: what comes out is not
 * the number of reflections.
 *
 * A line that ends anywhere ELSE is carried out to the border along its own
 * tangent, exactly as every open line on this screen always has been.
 *
 * Empty means there is nothing to burn, and it covers more than a drawing too
 * short to cut: a perfectly good line drawn entirely in a DIMMED part of the
 * face comes back empty as well, because none of it is inside the part being
 * worked in. Both are the same fact to a caller.
 */
export function draftCut(
  draft: Pick<DraftState, 'kind' | 'stroke' | 'points' | 'handles' | 'closed'>,
  fit: boolean,
  mirror: MirrorAxis | null
): Pt[][] {
  const line = draftLine(draft, fit)
  if (line.length < 2) return []
  return mirror ? mirrorLines(line, mirror) : [line]
}

/** Whether there is enough of a drawing to cut with. */
export function draftReady(
  draft: Pick<DraftState, 'kind' | 'stroke' | 'points' | 'handles' | 'closed'>,
  fit: boolean,
  mirror: MirrorAxis | null = null
): boolean {
  return draftCut(draft, fit, mirror).length > 0
}
