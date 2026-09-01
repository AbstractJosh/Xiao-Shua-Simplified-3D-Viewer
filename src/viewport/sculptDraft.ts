import { create } from 'zustand'
import { bezierChain, curveHandles } from '../geometry/curve'
import type { Pt } from '../geometry/curve'

/**
 * THE PROFILE YOU ARE DRAWING, before it is the wall.
 *
 * The Lathe screen's answer to `cutDraft`, and deliberately the same shape of
 * thing: points placed in order, one nullable handle each, read as a polyline
 * or as a Bézier chain through them. What differs is the PLANE and nothing
 * else. A cut is drawn in one face's (u, v); this is drawn in the section the
 * whole screen already is -- `[height, radius]`, in scene units off the
 * faceplate -- so a point survives a zoom, a resize of the stock and a change
 * of base, none of which it could if it were kept in the SVG's coordinates.
 *
 * ITS OWN STORE, NOT `latheStore`, and that line is the one that matters most.
 * `latheStore` holds the piece -- one wall, with a history behind it -- and a
 * draft is not a piece: it is what you are about to do, thrown away by Reset,
 * emptied when the tool is put down, and never in the undo stack. Only Apply
 * turns it into something the history has heard of. See `applySculpt`.
 *
 * NOT `toolStore` either, for the reason `cutDraft` is not: this is written
 * many times a second by a hand dragging a point, and exactly two components
 * read it. The tool store is where the theme and the unit live and every
 * control in the bar subscribes to it.
 */

type SculptState = {
  /** The placed points, bottom-of-the-line first only if that is how they were
   *  placed -- the order is the order of placement, and the line is read along
   *  it. */
  points: Pt[]
  /**
   * One mirrored handle offset per point, or NULL for a point whose tangent is
   * still the curve's own.
   *
   * The same model `cutDraft` settled on, and it earns its keep here for the
   * same reason: owning a handle is a property of the POINT, not of the tool,
   * so aiming the tangent at one shoulder does not cost you the fit through
   * every other point. A point is placed with a null and keeps taking the
   * fitted tangent for as long as it holds one, which is what lets its
   * neighbours go on reshaping the curve through it.
   *
   * Ignored while the curve is off -- a straight segment has no tangent to aim
   * -- and KEPT through it rather than dropped, so turning the curve off to
   * reposition a point and on again does not throw away the shaping already
   * done.
   */
  handles: (Pt | null)[]
  /**
   * Which point is IN HAND: the one whose tangent is drawn, and the only one
   * whose grips can be taken hold of. Null only while nothing has been placed.
   *
   * ONE TANGENT AT A TIME, and the reason is the drawing rather than the state.
   * Every point still carries a handle -- `handles` above is untouched, and the
   * curve still reads all of them -- but a run of six points drawn with six
   * tangents out is eighteen marks over a line made of six, and every bar
   * crosses the very curve it is bending. Worse, they are all the same size and
   * colour as each other, so the thing under the pointer is whichever mark
   * happens to be nearest rather than the one being worked on.
   *
   * SO PLACING SELECTS, and pressing a placed point selects it back. The point
   * you just put down is the one you are shaping -- that is what makes placing
   * and adjusting a single gesture -- and an earlier point is reached the way
   * anything else on this screen is reached: by pressing on it. Nothing is a
   * mode and nothing is lost; a tangent you aimed six points ago is still
   * aimed, and clicking its knot brings the grips back out where you left them.
   * See `useSculptGesture`, where the press that takes hold of a knot is the
   * same press that makes it live.
   *
   * AN INDEX RATHER THAN A POINT, so a selected point that is then dragged is
   * still the selected one. `removePoint` is the one thing that can make an
   * index mean a different knot than it did, and it walks this field itself
   * rather than leaving the drawing pointing at a stranger.
   */
  selected: number | null
  /** Put another point down at the end of the line, with the curve's own
   *  tangent -- and make it the live one, since it is what the hand is on. */
  addPoint: (at: Pt) => void
  /** Make one already-placed point live: the way back to a tangent you have
   *  moved on from. An index that names no point is ignored rather than
   *  stored, so nothing can leave the drawing pointing at a knot that is not
   *  there. */
  selectPoint: (index: number) => void
  /** Move a placed point. Handles are not touched: the fitted ones follow the
   *  drag on their own, and an aimed one is an answer to a question the drag
   *  has not asked again. */
  movePoint: (index: number, at: Pt) => void
  /**
   * Aim one point's handles.
   *
   * `at` is where the handle was dragged to; the offset is what is stored, and
   * its mirror is the other handle. `side` says which of the two was grabbed --
   * dragging the incoming one aims the pair the other way about, which is the
   * only way a mirrored pair can answer both handles.
   */
  moveHandle: (index: number, at: Pt, side: 1 | -1) => void
  /** Hand one point's tangent back to the curve. The way out of an aimed
   *  handle, and the reason aiming one is not a trap. */
  refitHandle: (index: number) => void
  /**
   * Take one point out of the line.
   *
   * THE LINE IS THE ORDER, so this is a splice and the shape of the answer
   * falls straight out of that -- which is exactly what the tool promises.
   * Take an END point off and the line BACKTRACKS: it now stops at the knot
   * before it, and the wall over the stretch that point used to reach is
   * outside the span the profile covers, so Apply leaves it alone. Take a
   * MIDDLE one out and its two neighbours BRIDGE: the segment between them is
   * whatever the pair make on their own -- straight with the curve off, and a
   * fitted arc with it on, since `curveHandles` reads the run that is there
   * rather than the run that was.
   *
   * NEIGHBOURS KEEP WHAT THEY WERE AIMED TO, on the rule `movePoint` already
   * follows: a tangent is a property of its point, and a delete somewhere else
   * on the line has not asked that question again. The fitted ones re-fit
   * because that is what fitted means.
   *
   * AND THE SELECTION IS WALKED RATHER THAN DROPPED. Every index above the gap
   * slides down one, so a knot you were shaping is still the one wearing its
   * handles; delete the LIVE knot and the one before it takes over, which is
   * the point the line now runs to. Emptying the drawing leaves nothing in
   * hand, the way `clear` does. An index naming no point is ignored, so a
   * stale one cannot cut the drawing short.
   */
  removePoint: (index: number) => void
  /** Throw the drawing away. */
  clear: () => void
}

const empty = {
  points: [] as Pt[],
  handles: [] as (Pt | null)[],
  selected: null as number | null,
}

export const useSculptDraft = create<SculptState>((set) => ({
  ...empty,

  clear: () => set({ ...empty }),

  addPoint: (at) =>
    set((s) => ({
      points: [...s.points, at],
      handles: [...s.handles, null],
      // The new point takes the handles off whatever was wearing them. It is
      // the thing under the hand, and the tangent worth showing is the one
      // being placed rather than the one placed before it.
      selected: s.points.length,
    })),

  selectPoint: (index) =>
    set((s) => (index < 0 || index >= s.points.length ? s : { selected: index })),

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

  removePoint: (index) =>
    set((s) => {
      if (index < 0 || index >= s.points.length) return s
      const points = s.points.filter((_, i) => i !== index)
      const handles = s.handles.filter((_, i) => i !== index)
      return { points, handles, selected: afterRemoval(s.selected, index, points.length) }
    }),
}))

/**
 * Where the handles go when a knot is taken off the line.
 *
 * Three cases and no more, which is why it is worth a name: the live knot was
 * the one deleted, so the knot BEFORE it takes over -- back down the line, the
 * way the eye is already travelling, and the first point's neighbour is the one
 * that becomes first; the live knot was above the gap, so it has slid down one
 * and the index has to follow it; or it was below, and nothing about it moved.
 * An emptied drawing has nothing in hand at all.
 */
function afterRemoval(selected: number | null, index: number, left: number): number | null {
  if (left === 0 || selected === null) return null
  if (selected === index) return Math.max(0, index - 1)
  return selected > index ? selected - 1 : selected
}

/**
 * The line a draft actually describes: the one the preview draws and the one
 * Apply cuts the wall to.
 *
 * ONE FUNCTION FOR BOTH READINGS, which is the point of it. The preview and the
 * wall must never disagree about what the line is -- a preview computed one way
 * and a cut computed another is a tool that turns something other than what it
 * showed -- so both call this and there is nothing to keep in step.
 *
 * With the curve off the points ARE the line, which is what makes a straight
 * shoulder exactly straight. With it on they are a Bézier chain through those
 * same points, given whatever mixture of aimed and fitted tangents
 * `curveHandles` resolves -- which is also why throwing the switch does not make
 * the line jump: a run with nothing aimed yet is exactly the fitted curve.
 */
export function sculptLine(
  draft: Pick<SculptState, 'points' | 'handles'>,
  fit: boolean
): Pt[] {
  if (draft.points.length < 2) return []
  if (!fit) return draft.points
  return bezierChain(draft.points, curveHandles(draft.points, draft.handles))
}

/** Whether there is enough of a drawing to cut the wall with. */
export function sculptReady(
  draft: Pick<SculptState, 'points' | 'handles'>,
  fit: boolean
): boolean {
  return sculptLine(draft, fit).length >= 2
}
