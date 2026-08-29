import { create } from 'zustand'
import { freshClay, mold, resize } from '../geometry/clay'
import type { Clay, Dab } from '../geometry/clay'

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
 * WHAT IS MISSING, said out loud: there is no undo. The bar's undo acts on the
 * document and stands down on this screen with everything else that does, so a
 * stroke on the lathe cannot be walked back -- only worked back out with the
 * other tool, or centred fresh from the Clay panel. That is the honest state of
 * it rather than an argument that a lathe should not have one.
 */
type LatheState = {
  clay: Clay
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
  /** Change the stock, carrying the shape with it -- see `resize`. */
  setHeight: (height: number) => void
  setRadius: (radius: number) => void
  /** Take the piece off and centre a fresh lump of the same stock. */
  centreFresh: () => void
}

export const useLathe = create<LatheState>((set) => ({
  clay: freshClay(),
  stroke: null,
  beginStroke: () => set((s) => ({ stroke: s.clay.wall })),
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
  // Both size fields end the stroke by implication: they can only be reached
  // from a panel, which means the pointer is not on the clay -- and a dish
  // measured from a wall that has since been rescaled is measured from nothing.
  setHeight: (height) => set((s) => ({ clay: resize(s.clay, { height }), stroke: null })),
  setRadius: (radius) => set((s) => ({ clay: resize(s.clay, { radius }), stroke: null })),
  // The stock is kept, the shaping is not: this is "start again", not "start
  // again from the app's idea of a lump". Somebody who has set a tall narrow
  // stock and made a mess of it wants the tall narrow stock back.
  centreFresh: () =>
    set((s) => ({ clay: freshClay(s.clay.height, s.clay.radius), stroke: null })),
}))
