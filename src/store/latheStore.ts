import { create } from 'zustand'
import { clampSides, clampWall, freshClay, mold, resize, sculpt, withWall } from '../geometry/clay'
import type { Clay, Dab, Hollow } from '../geometry/clay'
import type { Pt } from '../geometry/curve'

/**
 * The lump on the lathe: what the Lathe screen has made.
 *
 * ITS OWN STORE, beside `docStore` rather than inside it, and the reason is the
 * same one that keeps the two screens' consoles apart. `docStore` holds a
 * DOCUMENT -- a list of objects with features, colours, a selection and an undo
 * stack -- and a piece is none of those things: it is one array of radii, it
 * has no selection to speak of, and nothing in the modelling screen can act on
 * it.
 * Folding it in would mean every panel that reads the document learning to
 * ignore a field, and every piece edit pushing an entry onto a history the bar
 * dims on this screen anyway. See `SCREEN_HAS_DOCUMENT`.
 *
 * NOT the tool store either, though that is where `screen` lives. The rule
 * there is stated at the top of the file and it is a good one: that store is
 * how you are WORKING, and this is what you have BUILT. Which tool is in your
 * hand and how wide its brush is are tool state and live over there; the clay
 * they are pointed at is here.
 *
 * UNDO IS HERE NOW, and it is the wall and nothing else -- see `past`. The bar's
 * two buttons act on whichever screen is up: on Modelling they walk the
 * document's history, on Lathe they walk this one. They are the same act to the
 * user and there was never a good reason for the lathe to be the screen where
 * the obvious keystroke does nothing.
 */
/**
 * How many strokes back you can walk. The document's own limit, and the same
 * one for the same reason: far more than anybody reaches for in a sitting, and
 * small enough that the stack is a rounding error beside the mesh.
 */
const HISTORY_LIMIT = 50

type LatheState = {
  clay: Clay
  /**
   * The wall as it stood before each act that changed it, oldest first.
   *
   * THE WALL, NOT THE LUMP. What is remembered is one array of radii, and undo
   * puts it back into whatever lump is on the lathe now -- so the size fields,
   * the base and the hollow are untouched by it. That is the honest line
   * between the two kinds of change on this screen: the wall is SHAPED, by
   * gestures that cannot be typed back in, and everything else is SET, by a
   * control that is one click away from where it was. An undo that reverted a
   * width somebody typed after the stroke it was undoing would be the surprise
   * that stops people trusting the button.
   *
   * One entry per STROKE rather than per frame: `beginStroke` pushes, and the
   * sixty dabs that follow it are the one act it opened. The only other pusher
   * is `centreFresh`, the one act that throws shaping away wholesale -- which
   * is exactly the press somebody wants back.
   */
  past: number[][]
  future: number[][]
  /**
   * The wall as the CURRENT STROKE found it, or null between strokes.
   *
   * The dish a held tool sinks is measured from here rather than from wherever
   * the wall has got to this frame -- see `mold`, where it is the difference
   * between a brush and a punch. It is a stroke's worth of state and it lives
   * beside the clay because the stroke is a fact about the piece being worked,
   * not about the tool: which tool is in your hand is the same question whether
   * or not you are pressing it against anything.
   */
  stroke: number[] | null
  /** Take hold: remember the wall this stroke is being cut from. */
  beginStroke: () => void
  /** Let go. The next press starts a new dish from wherever the wall now is. */
  endStroke: () => void
  /**
   * Hold the tool against the wall for one instant.
   *
   * Called once per animation frame for as long as the pointer is down, which
   * is what makes the screen feel like a lathe rather than a drawing program:
   * the clay goes on moving toward a tool that is held still, because on a
   * lathe it is the piece that is moving, not the tool. See `mold` in
   * `clay.ts` for what one instant of contact does.
   */
  work: (dab: Dab) => void
  /**
   * Re-cut the wall to a drawn line: one press of Point Sculpt.
   *
   * ONE ENTRY, WHERE A STROKE IS ALSO ONE. It is not a stroke -- there is no
   * `beginStroke` under it and no dish measured from anything, because nothing
   * is being held against the wall -- but it is one ACT in exactly the sense
   * the history is kept in: the user composed a line, pressed once, and the
   * piece changed. Placing and dragging the points that led up to it are not in
   * here at all, and should not be: a draft is not a thing you have made. See
   * `useSculptDraft`.
   *
   * Any stroke in progress is over, for the reason `undo` ends one: the wall a
   * dish was being measured from has just been replaced under it.
   */
  applySculpt: (line: Pt[]) => void
  /** Change the stock, carrying the shape with it -- see `resize`. */
  setHeight: (height: number) => void
  setRadius: (radius: number) => void
  /**
   * Change the base the piece stands on: round, or a triangle through a
   * decagon.
   *
   * It touches nothing else. The wall is the same row of radii on every base --
   * see `Clay.sides` -- so this is not a resize and carries no risk of one: a
   * piece worked for ten minutes and then turned hexagonal is the same piece
   * with corners on it, and turning it back leaves it exactly as it was.
   */
  setSides: (sides: number | null) => void
  /**
   * Bore the piece out, or fill it back in: `null` is solid.
   *
   * Whole rather than field by field -- no `setWallThickness`, no
   * `setCapTop` -- because the three of them are one answer. "Hollow, 6 mm,
   * open at the top" is a single state, and a store with three setters for it
   * is a store where two of them are unreachable while it is switched off.
   *
   * NOT REMEMBERED BY UNDO, and for the reason the size fields are not: the
   * history on this screen holds the WALL -- see `past` -- and hollowing moves
   * no part of it. It is a switch you can flip back.
   */
  setHollow: (hollow: Hollow | null) => void
  /** Take the piece off and centre a fresh lump of the same stock. */
  centreFresh: () => void
  /** Step the wall back one act, or forward again. Inert with nothing to step. */
  undo: () => void
  redo: () => void
}

/**
 * Remember the wall as it stands, and drop whatever was undone.
 *
 * The half of every history that is easy to forget: taking a new act after an
 * undo has to throw the redo stack away, because the branch it described no
 * longer leads anywhere from here. `docStore` does the same at every one of its
 * own push sites; this is that, written once.
 */
const remember = (s: LatheState) => ({
  past: [...s.past, s.clay.wall].slice(-HISTORY_LIMIT),
  future: [],
})

export const useLathe = create<LatheState>((set) => ({
  clay: freshClay(),
  stroke: null,
  past: [],
  future: [],
  // Where a stroke is remembered, and it is the same instant the dish is
  // measured from -- one act, one entry, however many frames the hand holds
  // for. A press that turns out to move nothing still costs an entry, which is
  // the one wart: undoing it puts back a wall identical to the one on the
  // lathe. Cheaper than the alternative, which is deciding at `endStroke`
  // whether anything happened and unwinding the entry if not.
  beginStroke: () => set((s) => ({ stroke: s.clay.wall, ...remember(s) })),
  endStroke: () => set({ stroke: null }),
  // `mold` hands back the very object it was given when a dab moves nothing, so
  // a stroke that misses the piece -- or a push aimed where only a pull could
  // work -- sets state to what it already holds, and zustand's own identity
  // check stops the redraw there.
  //
  // A dab with no stroke behind it is a stroke of one, which is what `mold`
  // does with the wall it is handed. That is the honest reading of a frame
  // arriving between `beginStroke` and its own `set`, and of anything that
  // works the clay without taking hold of it first.
  work: (dab) => set((s) => ({ clay: mold(s.clay, dab, s.stroke ?? s.clay.wall) })),
  // Remembered BEFORE the cut and only when the cut moves something: `sculpt`
  // hands back the very lump it was given when the line lands where the wall
  // already is, and an entry for that would be an undo press that appears to do
  // nothing. A stroke cannot make that check cheaply -- it is sixty dabs deep
  // by the time anyone could -- which is why `beginStroke` pays for the entry
  // up front and this does not have to.
  applySculpt: (line) =>
    set((s) => {
      const clay = sculpt(s.clay, line)
      if (clay === s.clay) return s
      return { clay, stroke: null, ...remember(s) }
    }),
  // Both size fields end the stroke by implication: they can only be reached
  // from a panel, which means the pointer is not on the clay -- and a dish
  // measured from a wall that has since been rescaled is measured from nothing.
  setHeight: (height) => set((s) => ({ clay: resize(s.clay, { height }), stroke: null })),
  setRadius: (radius) => set((s) => ({ clay: resize(s.clay, { radius }), stroke: null })),
  // The stroke is LEFT ALONE here, where the two size fields end it. The reason
  // they end it is that they rescale the wall, and a dish measured from a wall
  // that has since moved is measured from nothing; this changes no radius at
  // all, so a stroke in progress is still being cut from the wall it started
  // on. Not that one can be: the selector is in the console, a window away from
  // the clay, and the pointer cannot be on both.
  setSides: (sides) =>
    set((s) => {
      const next = clampSides(sides)
      // Handing back the very lump we hold when nothing changes, the way `mold`
      // does: pressing the base a piece is already on must not redraw it.
      return next === s.clay.sides ? s : { clay: { ...s.clay, sides: next } }
    }),
  // Clamped on the way in, since a panel is what writes it and a wall thicker
  // than the app's own limit is not a wall. What it means for a given piece --
  // where the cavity reaches, whether an end really is open -- is worked out
  // fresh every time anything asks. See `bore`.
  setHollow: (hollow) =>
    set((s) => ({
      clay: {
        ...s.clay,
        hollow: hollow === null ? null : { ...hollow, thickness: clampWall(hollow.thickness) },
      },
    })),
  // The stock is kept, the shaping is not: this is "start again", not "start
  // again from the app's idea of a lump". Somebody who has set a tall narrow
  // stock and made a mess of it wants the tall narrow stock back.
  centreFresh: () =>
    // The base goes with the stock, and for the same reason: somebody who has
    // set a hexagonal lump and made a mess of it wants a hexagonal lump back.
    set((s) => ({
      clay: freshClay(s.clay.height, s.clay.radius, s.clay.sides),
      stroke: null,
      // Remembered, so the one button on this screen that throws work away is
      // also the one press it is safest to make. It used to be irreversible,
      // which is why it was worded as a whole sentence and dimmed on an
      // untouched lump.
      ...remember(s),
    })),
  undo: () =>
    set((s) => {
      if (s.past.length === 0) return s
      const wall = s.past[s.past.length - 1]
      return {
        // Put back into the lump that is on the lathe NOW, not into the one the
        // entry was taken from -- and re-clamped on the way in, because the
        // stock may have been narrowed since and a wall past the flare limit of
        // the lump it now belongs to is a shape this screen cannot go on
        // working. See `wallBounds`.
        clay: withWall(s.clay, wall),
        past: s.past.slice(0, -1),
        future: [s.clay.wall, ...s.future].slice(0, HISTORY_LIMIT),
        // Any stroke in progress is over: its dish was measured from a wall
        // that has just been replaced.
        stroke: null,
      }
    }),
  redo: () =>
    set((s) => {
      if (s.future.length === 0) return s
      return {
        clay: withWall(s.clay, s.future[0]),
        past: [...s.past, s.clay.wall].slice(-HISTORY_LIMIT),
        future: s.future.slice(1),
        stroke: null,
      }
    }),
}))
