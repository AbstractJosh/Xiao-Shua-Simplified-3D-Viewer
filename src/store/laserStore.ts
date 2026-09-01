import type { BufferGeometry } from 'three'
import { create } from 'zustand'
import { MAX_SIZE, MIN_DIMENSION } from '../geometry/dimensions'
import { images } from '../geometry/faceMirror'
import type { MirrorAxis } from '../geometry/faceMirror'
import {
  BLOCK_VOLUME,
  cutPieces,
  faceBasis,
  freshBlock,
  pieceCentre,
  pieceVolume,
} from '../geometry/laserCut'
import type { FaceAxis, Pt } from '../geometry/laserCut'
import { DEFAULT_SPAN } from '../geometry/types'

/**
 * The block in the laser cutter, and whatever it has been cut into.
 *
 * ITS OWN STORE, beside `latheStore` rather than inside `docStore`, and for the
 * reason set out at the top of that file: `docStore` holds a DOCUMENT -- a list
 * of objects with features, colours, a selection and an undo stack -- and a
 * bedful of offcuts is none of those. Nothing in the modelling screen can act
 * on it, and every panel that reads the document would have to learn to ignore
 * it.
 *
 * NOT the tool store either, though that is where `screen` lives and where the
 * line being drawn lives. The rule there is that it holds how you are WORKING
 * and this holds what you are working ON: which face you are looking at and how
 * much rope the stabiliser has are facts about the sitting, and the pieces on
 * the bed are what you have made.
 *
 * THE PIECES ARE BAKED MESHES, which is the one place this screen parts company
 * with the rest of the app. Everywhere else a cut is stored parametrically and
 * folded in at evaluate time -- see `cut.ts` -- because a plane cut IS
 * describable as "the original, kept on one side of something". A freehand
 * curve is not: there is no pair of opposing half-spaces to keep, so the shape
 * that comes out of the boolean is the shape, and the way back is the history
 * below rather than a list of cuts to re-open. See `laserCut.ts`.
 *
 * IN BLOCK SPACE: every geometry here belongs to a unit cube centred on the
 * origin, and the viewport scales it by the Side. That is what makes resizing
 * free and lossless after a cut -- a cut block resized is not re-cut or
 * rescaled, a number outside the geometry changes -- and it is why the size
 * field is not part of the history.
 */

/**
 * How big the block may be, which is exactly how big a box in a DOCUMENT may
 * be: a millimetre to five metres.
 *
 * Borrowed rather than chosen, because the block is stock for the same app --
 * a piece that could be cut here and not built next door would be a piece the
 * clipboard could not carry across. See `dimensions.ts` for why the range is
 * what it is.
 */
export const BLOCK_MIN = MIN_DIMENSION
export const BLOCK_MAX = MAX_SIZE

/**
 * A ten-centimetre cube, which is one span -- the size every solid in the
 * palette lands at.
 *
 * The same number for the same reason the palette shares it: a block that
 * arrived at some size of its own would be a screen that disagreed with the
 * rest of the app about how big a thing is, and the first piece copied to the
 * clipboard would land next door looking wrong.
 */
export const DEFAULT_BLOCK = DEFAULT_SPAN

/**
 * How many cuts back you can walk. The document's own limit and the lathe's,
 * for the same reason: far more than anybody reaches for in a sitting.
 */
const HISTORY_LIMIT = 50

/**
 * One piece on the bed.
 *
 * The id is what the highlight and the Delete key hold on to. It has to be
 * separate from the geometry because a cut hands back a fresh geometry for
 * every piece it touched, including the ones it merely passed by -- so identity
 * has to be something the store assigns rather than something the boolean
 * preserves.
 */
export type Piece = {
  id: string
  geometry: BufferGeometry
  /** In block-space units, so a piece's share of the whole is `volume` itself.
   *  Measured once at the cut rather than per render: it decides which piece is
   *  the offcut and it never changes afterwards. */
  volume: number
}

let pieceCount = 0
const nextPieceId = () => `piece-${(pieceCount += 1)}`

/**
 * Whether the bed still holds nothing but the block it started as.
 *
 * READ OFF THE VOLUME rather than kept as a flag, because the volume cannot go
 * stale and a flag can: undo, redo, a discard and a fresh block would each have
 * to remember to set it, and the one that forgot would be a screen that lied
 * about what is on the bed. A cut is a KERF -- it burns a slot of real width --
 * so a bed the laser has been through is missing at least that much material
 * and can never measure a full block again. See `BLOCK_VOLUME`.
 *
 * It exists for one caller, and for a good reason: an uncut block copied to the
 * clipboard should arrive next door as a BOX, not as a mesh of twelve
 * triangles that merely looks like one. A box can be resized on its own axes,
 * sketched on face by face and written out as a solid; a mesh of the same shape
 * gets derived anchors and a triangle soup. See `CopyBlockButton`.
 */
export function bedIsUncut(pieces: Piece[]): boolean {
  // Generous, because the block's own volume is exact and a kerf is thousands
  // of times wider than this: there is no middle ground to get wrong.
  return pieces.length === 1 && pieces[0].volume > BLOCK_VOLUME - 1e-6
}

/**
 * What one step of history holds.
 *
 * THE SIZE IS OPTIONAL, AND THAT IS THE WHOLE OF WHY IT IS THERE. Resizing the
 * block is not an act to walk back -- the geometry is untouched, the group
 * around it is scaled, and a Ctrl+Z that snapped the width back to what it was
 * three cuts ago would be undoing something the user can see and change in one
 * field. So an ordinary step carries no size and undo leaves it alone.
 *
 * `resetBlock` is the one act that changes the size ITSELF, and an undo of it
 * that gave back the cuts but not the stock they were made in would be half a
 * way back. So that step, and only that step, carries the size it stepped away
 * from.
 */
type Step = {
  pieces: Piece[]
  offcut: string[]
  choices: string[][]
  dims?: [number, number, number]
}

/**
 * How near two pieces' middles have to land before one is taken for the other's
 * reflection, in block space, and how much their volumes may differ.
 *
 * GENEROUS ON BOTH COUNTS, because the question is not a close one. A mirrored
 * cut is the same line reflected, fired at a block that is itself symmetrical
 * about the very same plane, so the pieces it leaves either side are exact
 * images of each other down to whatever noise the boolean left -- thousandths.
 * What the tolerance has to survive is that noise; what it has to refuse is a
 * DIFFERENT piece, which on any cut worth mirroring is a whole shape away. A
 * hundredth of the block and a fiftieth of the volume sit in the wide gap
 * between the two.
 */
const TWIN_NEAR = 0.01
const TWIN_VOLUME = 0.02

/**
 * The pieces a cut made, gathered into the sets that are one piece of work.
 *
 * A SET RATHER THAN A PIECE is the whole of what symmetry changes about the
 * choice at the end of a cut. Four quarters of a bracket cut with a cross are
 * not four decisions -- they are one decision, made four times over, and a
 * screen that asked for it four times would be one where the cut was symmetric
 * and the tidying up was not. So the piece that is lit lights its images with
 * it, and Discard takes the set.
 *
 * PAIRED BY WHERE THEY SIT, not by anything the cut carried out with it, and
 * that is the only reading available: the boolean does not know it was handed a
 * mirrored line, and the pieces come off it in whatever order the walk found
 * them. What IS known is the mirror, so each piece's middle is reflected in it
 * and the piece nearest that spot -- of about the right size, and at the same
 * depth into the block -- is its twin. See `pieceCentre`.
 *
 * A piece whose image is missing stays a set of one, which is not a failure but
 * the truth: cut a block that earlier cuts have already left lopsided and one
 * side of the mirror really does have something the other has not.
 *
 * With no mirror standing, every set is one piece, which is exactly what this
 * screen did before there was one.
 */
function twinSets(
  made: Piece[],
  face: FaceAxis,
  mirror: MirrorAxis | null
): string[][] {
  if (!mirror) return made.map((piece) => [piece.id])

  const basis = faceBasis(face)
  const spots = made.map((piece) => {
    const centre = pieceCentre(piece.geometry)
    return {
      at: [centre.dot(basis.u), centre.dot(basis.v)] as Pt,
      depth: centre.dot(basis.n),
    }
  })

  const taken = new Set<number>()
  const sets: string[][] = []
  for (let i = 0; i < made.length; i += 1) {
    if (taken.has(i)) continue
    taken.add(i)
    const set = [made[i].id]
    // The images of this piece's middle, the piece itself dropped: one to look
    // for under a mirror, three under a cross.
    for (const want of images(spots[i].at, mirror).slice(1)) {
      let best = -1
      let nearest = TWIN_NEAR
      for (let j = 0; j < made.length; j += 1) {
        if (taken.has(j)) continue
        if (Math.abs(spots[j].depth - spots[i].depth) > TWIN_NEAR) continue
        if (Math.abs(made[j].volume - made[i].volume) > made[i].volume * TWIN_VOLUME) continue
        const off = Math.hypot(spots[j].at[0] - want[0], spots[j].at[1] - want[1])
        if (off < nearest) {
          nearest = off
          best = j
        }
      }
      if (best >= 0) {
        taken.add(best)
        set.push(made[best].id)
      }
    }
    sets.push(set)
  }
  return sets
}

type LaserState = {
  /**
   * The block's three sides in scene units: width across x, height up y, depth
   * back along z.
   *
   * THREE NUMBERS, NOT ONE, and the geometry does not know about any of them.
   * Stock is a sheet, a bar or a cube depending on the job, and a screen that
   * could only cut cubes would be one where every job started by making a cube
   * into a sheet. What keeps that cheap is where the three are applied: the
   * bed's geometry stays the UNIT CUBE it always was and these scale the group
   * it hangs in -- so resizing a block that has been cut moves the cuts with it
   * rather than re-running them, exactly as the single side did before.
   *
   * The one thing that changes shape with it is the kerf, which is a fraction
   * of block space and so is stretched by whichever way the block is: the same
   * bargain the single side already struck, where a five-metre block burns a
   * fifty-times-wider slot than a ten-centimetre one.
   */
  dims: [number, number, number]
  /** Everything on the bed, biggest first within each cut. */
  pieces: Piece[]
  /**
   * The piece marked to be thrown away, or null.
   *
   * ONE PIECE, HIGHLIGHTED, and it is the whole of how a finished cut reads.
   * The two halves stay exactly where the block was -- nothing slides apart --
   * so without this a cut that separated a solid perfectly would look like a
   * button that did nothing. Lit in the colour material-being-taken-away wears
   * everywhere else in the app, it says both things at once: here is where the
   * cut ran, and this is the side that goes.
   *
   * IT USED TO BE THE SMALLEST AND ONLY THE SMALLEST, decided by the cut and
   * not offered for discussion. That is the right GUESS -- most cuts trim
   * something off something -- and it is a wrong answer often enough to matter:
   * a cut that frees the part you actually want from the stock around it makes
   * the KEEPER the small one, and the screen would then be lighting the piece
   * you came for and offering to bin it. So it opens on the smallest and is
   * yours to change. See `choices` and `markOffcut`.
   *
   * It is still not a selection. It is one thing with one verb -- what Delete
   * throws away -- and nothing else on this screen can be picked up or acted
   * on. What changed is who decides which piece wears it.
   *
   * A LIST, BECAUSE A MIRRORED CUT LEAVES ONE PIECE OF WORK IN TWO PLACES. Cut
   * with the Symmetry axis standing and the offcut is the piece AND its images
   * -- two under a mirror, up to four under a cross -- lit together and thrown
   * away together, because they are one decision made twice over rather than
   * two decisions. See `twinSets`. Empty is what `null` used to be, and an
   * ordinary cut fills it with exactly one id, which is the whole of what this
   * screen did before there was a mirror.
   */
  offcut: string[]
  /**
   * The pieces the last cut made: the ones `offcut` may be moved between.
   *
   * BOUNDED TO THE LAST CUT, deliberately, and this is the reason the list is
   * kept rather than reading the bed. The bed is every piece there has ever
   * been, and one of those slivers may have been cut three cuts ago and kept on
   * purpose; a chooser that ranged over all of them would offer to bin work
   * that has nothing to do with the act just performed. What a cut hands you is
   * a decision about the pieces IT made, and this is that set.
   *
   * Empty when there is nothing to choose: before the first cut, after the
   * discard that spends the choice, and after a fresh block. Biggest first, so
   * stepping through them is stepping down in size.
   *
   * A LIST OF SETS rather than of pieces, for the reason `offcut` is a list:
   * under a mirror the thing being chosen between is a piece and its images
   * taken together. Without one every set holds one piece and this reads
   * exactly as it always did.
   */
  choices: string[][]
  past: Step[]
  future: Step[]
  /**
   * Resize the block along one axis: 0 for width, 1 for height, 2 for depth.
   * Clamped on the way in, since a panel is what writes it and a field can be
   * typed into as well as dragged.
   */
  setDim: (axis: 0 | 1 | 2, value: number) => void
  /**
   * Run a cut across every piece on the bed.
   *
   * A SET OF LINES, ALL BURNED AS ONE ACT. A plain cut hands in one line and a
   * mirrored one hands in the two or four the axis makes of it -- see
   * `mirrorLines`, which is what both the preview and Apply go through. They
   * arrive together because they happened together: one press, one bed, one
   * step of history, so Ctrl+Z gives back the whole symmetrical cut rather than
   * half of it.
   *
   * `mirror` is the axis they were made with, or null, and it is here for the
   * choice at the end rather than for the burning: it is what lets the pieces
   * be paired with their own images so that the set can be lit and thrown away
   * as one. See `twinSets`.
   *
   * Answers how many pieces came apart, so the tool can tell a cut from a line
   * that missed. Nothing changes on a miss -- not the pieces, not the history
   * -- because an undo entry for an act that did nothing is an undo press that
   * appears to do nothing too.
   */
  cut: (lines: Pt[][], face: FaceAxis, mirror?: MirrorAxis | null) => number
  /**
   * Mark the set one of the pieces the last cut made belongs to as the one to
   * throw away.
   *
   * Ignores an id that is not among `choices`, which is what makes a press on
   * some piece from an older cut do nothing rather than something surprising.
   * A press on any piece of a mirrored set lights the whole set: they are one
   * thing, so which of them was under the pointer cannot matter.
   */
  markOffcut: (id: string) => void
  /**
   * Move the mark to the next piece the cut made, wrapping at the end.
   *
   * THE SAME CHOICE WITHOUT LETTING GO OF THE TOOL. Clicking a piece is the
   * direct way to say which one goes, and it is only available with empty hands
   * -- with a cutter in hand a press on the block draws. This is the way that
   * is always open, and it is a step rather than a pick because a panel button
   * cannot point at a piece.
   *
   * Inert with fewer than two to step between.
   */
  nextOffcut: () => void
  /** Throw the marked piece -- and its images, under a mirror -- away. Inert
   *  when there is none. */
  discardOffcut: () => void
  /** Take everything off the bed and start from a fresh block of the same size. */
  freshStock: () => void
  /**
   * The whole block back to how it arrived: uncut, and ten centimetres on
   * every side.
   *
   * THE DIFFERENCE FROM `freshStock` IS THE SIZE, and it is the difference
   * between "start this piece again" and "start again". The panel's button is
   * this one because that is what Reset means to the hand that presses it: not
   * the app's idea of a cut in the user's idea of a block, but the screen as it
   * was found. Somebody who wants their 5 mm stock back after a mess wants
   * `freshStock`, and types the 5 back in.
   *
   * Remembered, and remembered WITH the size -- see `Step`. It is the most
   * destructive button on the screen, so Ctrl+Z has to give back everything it
   * took, the stock included.
   */
  resetBlock: () => void
  /** Step one cut back, or forward again. Inert with nothing to step. */
  undo: () => void
  redo: () => void
}

const clamp = (v: number) => Math.min(BLOCK_MAX, Math.max(BLOCK_MIN, v))

/** A bed holding one uncut block. */
function freshPieces(): Piece[] {
  const geometry = freshBlock()
  return [{ id: nextPieceId(), geometry, volume: pieceVolume(geometry) }]
}

/**
 * Remember the bed as it stands, and drop whatever was undone.
 *
 * The half of every history that is easy to forget: taking a new act after an
 * undo has to throw the redo stack away, because the branch it described no
 * longer leads anywhere from here. `latheStore` does the same, written once.
 *
 * The entries hold the very `Piece` objects that were on the bed, not copies.
 * A piece is immutable once cut -- nothing ever edits a geometry in place here
 * -- so sharing them is safe, and it is what keeps a step to a few pointers
 * rather than a copy of every mesh. It is also why nothing in this file
 * disposes a geometry: the bed is not the only thing holding one.
 */
const remember = (s: LaserState) => ({
  past: [...s.past, { pieces: s.pieces, offcut: s.offcut, choices: s.choices }].slice(-HISTORY_LIMIT),
  future: [],
})

export const useLaser = create<LaserState>((set, get) => ({
  dims: [DEFAULT_BLOCK, DEFAULT_BLOCK, DEFAULT_BLOCK],
  pieces: freshPieces(),
  offcut: [],
  choices: [],
  past: [],
  future: [],
  // Handing back the very state we hold when nothing changes, the way the lathe
  // does with a base it is already on: a clamped value that lands where it
  // already was must not redraw the scene.
  setDim: (axis, value) =>
    set((s) => {
      const next = clamp(value)
      if (next === s.dims[axis]) return s
      const dims: [number, number, number] = [...s.dims]
      dims[axis] = next
      return { dims }
    }),

  cut: (lines, face, mirror = null) => {
    const s = get()
    const result = cutPieces(
      s.pieces.map((p) => p.geometry),
      lines,
      face
    )
    if (result.split === 0) return 0

    const pieces = result.pieces.map((geometry) => ({
      id: nextPieceId(),
      geometry,
      volume: pieceVolume(geometry),
    }))
    // Gathered into sets before anything is sorted, because a set is what is
    // being sorted: under a mirror the four quarters of one shape are one entry
    // in the list rather than four, and the size they are ranked by is the size
    // of the whole set.
    const sets = twinSets(
      result.made.map((i) => pieces[i]),
      face,
      mirror
    )
    const sizeOf = (set: string[]) =>
      set.reduce((sum, id) => sum + (pieces.find((p) => p.id === id)?.volume ?? 0), 0)
    // Biggest first, which is the order the cut already hands them back in
    // within each piece it split -- sorted here as well because a cut that came
    // apart in two places contributes two runs, and stepping through them
    // should still be stepping down in size.
    const choices = [...sets].sort((a, b) => sizeOf(b) - sizeOf(a))
    set({
      pieces,
      choices,
      // OPENS ON THE SMALLEST, which is the guess the cut used to make on its
      // own and is right far more often than not: most cuts trim something off
      // something. It is now a starting point rather than a verdict.
      offcut: choices.length === 0 ? [] : choices[choices.length - 1],
      ...remember(s),
    })
    return result.split
  },

  markOffcut: (id) =>
    set((s) => {
      // Any piece of a set names the set: they are one thing, so which of the
      // images was under the pointer cannot matter.
      const set = s.choices.find((choice) => choice.includes(id))
      if (!set || set.includes(s.offcut[0])) return s
      return { offcut: set }
    }),

  nextOffcut: () =>
    set((s) => {
      if (s.choices.length < 2) return s
      // FOUND BY WHAT IS IN IT rather than by which array it is. The two are
      // the same object today and would go on being the same object right up
      // until a step of history handed back a copy, which is the kind of
      // sameness that breaks silently and in one place only.
      const at = s.choices.findIndex((choice) => choice.includes(s.offcut[0]))
      return { offcut: s.choices[(at + 1) % s.choices.length] }
    }),

  // NOT REMEMBERED, either of them, and that is the one thing about the choice
  // worth stating out loud: changing your mind about which piece goes is not an
  // act to walk back. Nothing has been destroyed -- both pieces are still on the
  // bed -- and a Ctrl+Z that stepped through every time the mark moved would
  // bury the cut it belongs to under half a dozen presses.

  discardOffcut: () =>
    set((s) => {
      if (s.offcut.length === 0) return s
      const kept = s.pieces.filter((p) => !s.offcut.includes(p.id))
      // The last piece on the bed is not an offcut, whatever its size: throwing
      // it away would leave the screen empty with a Reset the only way back,
      // which is a bigger act than the key that did it. It is the whole SET
      // that is weighed against that now -- four quarters of a mirrored cut
      // that are the only things on the bed go nowhere.
      if (kept.length === 0) return s
      // And the choice is spent with it: the pair it was a choice between is
      // broken, and what is left is one piece rather than an offer.
      return { pieces: kept, offcut: [], choices: [], ...remember(s) }
    }),

  // The size is kept and the cutting is not: this is "start again", not "start
  // again from the app's idea of a block". Somebody who has set a 5 mm block and
  // made a mess of it wants the 5 mm block back. The same bargain `centreFresh`
  // strikes on the lathe, and remembered for the same reason -- it is the one
  // button on this screen that throws work away wholesale.
  freshStock: () =>
    set((s) => ({ pieces: freshPieces(), offcut: [], choices: [], ...remember(s) })),

  // Inert when the screen is already as it was found, so the button above it
  // can be dead rather than pushing a step that changes nothing -- and so that
  // a second press cannot bury the cuts the first one put in the history.
  resetBlock: () =>
    set((s) => {
      if (isDefaultBlock(s)) return s
      return {
        pieces: freshPieces(),
        offcut: [],
        choices: [],
        dims: [DEFAULT_BLOCK, DEFAULT_BLOCK, DEFAULT_BLOCK],
        // Its own step rather than `remember`'s, because this is the one act
        // that has a size to give back. See `Step`.
        past: [...s.past, { pieces: s.pieces, offcut: s.offcut, choices: s.choices, dims: s.dims }].slice(
          -HISTORY_LIMIT
        ),
        future: [],
      }
    }),

  // A STEP THAT CARRIES A SIZE PUTS IT BACK, and hands the size it is leaving
  // to the entry going the other way, so the pair walks the stock between them
  // as many times as it is stepped over. A step with no size leaves the field
  // alone, which is every step but a reset -- see `Step`.
  undo: () =>
    set((s) => {
      if (s.past.length === 0) return s
      const step = s.past[s.past.length - 1]
      return {
        pieces: step.pieces,
        offcut: step.offcut,
        choices: step.choices,
        ...(step.dims ? { dims: step.dims } : {}),
        past: s.past.slice(0, -1),
        future: [
          {
            pieces: s.pieces,
            offcut: s.offcut,
            choices: s.choices,
            ...(step.dims ? { dims: s.dims } : {}),
          },
          ...s.future,
        ].slice(0, HISTORY_LIMIT),
      }
    }),

  redo: () =>
    set((s) => {
      if (s.future.length === 0) return s
      const step = s.future[0]
      return {
        pieces: step.pieces,
        offcut: step.offcut,
        choices: step.choices,
        ...(step.dims ? { dims: step.dims } : {}),
        past: [
          ...s.past,
          {
            pieces: s.pieces,
            offcut: s.offcut,
            choices: s.choices,
            ...(step.dims ? { dims: s.dims } : {}),
          },
        ].slice(-HISTORY_LIMIT),
        future: s.future.slice(1),
      }
    }),
}))

/**
 * Whether the screen is exactly as it was found: one uncut block, ten
 * centimetres on every side.
 *
 * UNCUT IS `bedIsUncut`'S ANSWER, not a second opinion. Whether the laser has
 * been through the bed is a question with one right way to ask it -- the
 * volume, which cannot go stale the way a flag can -- and it is already asked
 * there for the Clipboard's sake. What this adds is the only other half of
 * "as it was found": the stock is still the size it arrived at.
 *
 * NOT `past.length`, which gets both of the interesting cases wrong: a bed cut
 * and then walked all the way back IS uncut again, and a bed reset once has a
 * step behind it and nothing left to reset.
 *
 * Exported and pure, so the button that is dead when this is true and the
 * action that refuses when it is true are one claim rather than two.
 */
export function isDefaultBlock(s: {
  pieces: Piece[]
  dims: [number, number, number]
}): boolean {
  return bedIsUncut(s.pieces) && s.dims.every((side) => side === DEFAULT_BLOCK)
}
