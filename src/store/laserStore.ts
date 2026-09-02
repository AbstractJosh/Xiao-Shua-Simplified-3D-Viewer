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
  touchesFacePoint,
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
 * Pushes the counter past a bed that came back off the disk.
 *
 * The same hazard `seedIds` answers for a document, and here it is worse rather
 * than milder: a piece's id is what `offcut` holds and what a click adds to it,
 * so two pieces sharing one id are two pieces that are lit together, binned
 * together, and impossible to tell apart from the bed. Forward only, so opening
 * a lightly cut project after a heavily cut one cannot wind the numbers back
 * onto ids still sitting in the other one's history.
 */
export function seedPieceIds(ids: string[]): void {
  for (const id of ids) {
    if (!id.startsWith('piece-')) continue
    const n = Number(id.slice('piece-'.length))
    if (Number.isInteger(n) && n > pieceCount) pieceCount = n
  }
}

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
 *
 * IT ASKS FOR VOLUMES AND NOT FOR PIECES, which is the least it needs and the
 * reason a project can ask the same question of a bed that is on a disk rather
 * than on the bench: a stored piece has no geometry hanging off it until
 * somebody opens it, and "has this block been cut" should not require one.
 */
export function bedIsUncut(pieces: readonly { volume: number }[]): boolean {
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
 * The middle of the face, which is where the drawing is unless something says
 * otherwise.
 *
 * THE DEFAULT ANCHOR, and it is a default rather than the rule because a
 * reference can be slid off centre and the piece under it moves with it. What
 * makes the middle the right guess is the way this screen is used: a picture is
 * dropped on a face, it lands centred, and the line is drawn round it -- so
 * the middle of the face is the middle of the work. See `cutAnchor`, which is
 * what looks for a picture before falling back to this.
 */
export const FACE_MIDDLE: Pt = [0, 0]

/**
 * Which set holds the work, and so which pieces are waste.
 *
 * THE PIECE UNDER THE MIDDLE OF THE DRAWING IS THE KEEPER, and everything else
 * this bed holds is offcut. That is the whole rule, and it replaces a guess
 * that could only ever be right about a bed with two pieces on it: the cut used
 * to keep the biggest and light the smallest, which says nothing at all when a
 * stroke wanders off the face and back and leaves THREE, and which is exactly
 * backwards when the line is drawn round the part you came for.
 *
 * The reference sits in the middle by design -- it is dropped centred and the
 * line is drawn round it -- so "the piece the drawing is on" and "the piece
 * holding the middle of the face" are the same piece, and the second is a
 * question a flat square can answer. See `touchesFacePoint`.
 *
 * NOBODY HOLDING IT IS AN ANSWER TOO, and a common one: draw the line straight
 * through the middle and the middle lands in the kerf, where neither piece has
 * material; cut from one face and then turn to another and the material at
 * that face's middle may have gone with the first cut. So the fallback is the
 * BIGGEST piece, which is the old guess kept for exactly the case the new rule
 * cannot see -- and it is never nothing, so the bed always has a keeper and
 * Discard can never empty it.
 *
 * A SET rather than a piece, because under a mirror a piece and its images are
 * one thing: keeping one and binning its reflection is not a decision anybody
 * makes on purpose. See `twinSets`.
 */
function keeperSet(pieces: Piece[], sets: string[][], face: FaceAxis, anchor: Pt): string[] {
  const holder =
    pieces.find((piece) => touchesFacePoint(piece.geometry, face, anchor)) ??
    pieces.reduce((big, piece) => (piece.volume > big.volume ? piece : big))
  return sets.find((set) => set.includes(holder.id)) ?? [holder.id]
}

/**
 * The pieces on the bed, gathered into the sets that are one piece of work.
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
   * not offered for discussion. That is the right GUESS about a bed with two
   * pieces on it -- most cuts trim something off something -- and a bed does
   * not always have two pieces on it. A stroke that wanders off the face and
   * back cuts THREE, and a rule that lights one of them leaves the third
   * sitting there with nothing that can be said about it: not lit, not
   * clickable, not something Delete would take.
   *
   * SO IT IS EVERYTHING THAT IS NOT THE WORK. The piece holding the middle of
   * the face is the keeper -- the reference sits there by design and the line
   * is drawn round it -- and every other piece on the bed is waste, lit
   * together and binned together. Three pieces, or five, are as ordinary as
   * two. See `keeperSet`.
   *
   * It is still not a selection. It is one set with one verb -- what Delete
   * throws away -- and nothing else on this screen can be picked up or acted
   * on. What changed is that the set can be any size, and that a click adds to
   * it and takes from it rather than moving it. See `markOffcut`.
   *
   * AND A MIRRORED CUT MOVES A PIECE AND ITS IMAGES AS ONE. Cut with the
   * Symmetry axis standing and a piece's reflections go wherever it goes --
   * two under a mirror, up to four under a cross -- because they are one
   * decision made twice over rather than two decisions. See `twinSets`.
   */
  offcut: string[]
  /**
   * Every piece on the bed, in the sets a click moves as one: what `offcut` is
   * made of and what may be added to it or taken out of it.
   *
   * THE WHOLE BED, and that is a change from being bounded to the pieces the
   * last cut made. The old bound was there to protect a sliver cut three cuts
   * ago and kept on purpose -- a chooser ranging over everything would offer to
   * bin work that had nothing to do with the act just performed. What broke it
   * is the rule above: the keeper is the piece under the drawing, and that
   * question has an answer for every piece on the bed, not just the ones the
   * last boolean touched. A ring left lying beside the work two cuts ago is
   * waste by the same test that says so about the one made a second ago, and a
   * bed that could only ever be half-judged is how offcuts pile up.
   *
   * What protects a sliver kept on purpose now is the click: it is lit rather
   * than binned, and one press takes it back out of the offcut.
   *
   * Empty when there is nothing to choose: before the first cut, after the
   * discard that spends the choice, and after a fresh block. Biggest first, so
   * the list reads down in size.
   *
   * A LIST OF SETS rather than of pieces, for the reason `offcut` is a list:
   * under a mirror the thing being chosen is a piece and its images taken
   * together. Without one every set holds one piece and this reads exactly as
   * it always did.
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
   * `anchor` is where the work is on that face, in the face's own (u, v) in
   * block space -- the middle of the reference picture, or the middle of the
   * face when there is none. The piece holding it is the one this cut KEEPS,
   * and everything else on the bed is lit as waste. It is handed in rather
   * than read here for the reason `mirror` is: where the pictures are is the
   * reference store's business, and this store does not read other stores. See
   * `cutAnchor`, and `keeperSet` for what is done with it.
   *
   * Answers how many pieces came apart, so the tool can tell a cut from a line
   * that missed. Nothing changes on a miss -- not the pieces, not the history
   * -- because an undo entry for an act that did nothing is an undo press that
   * appears to do nothing too.
   */
  cut: (lines: Pt[][], face: FaceAxis, mirror?: MirrorAxis | null, anchor?: Pt) => number
  /**
   * Turn one piece's light on or off: add its set to the offcut, or take it
   * back out.
   *
   * A TOGGLE RATHER THAN A MOVE, and that is what the rule above forces. When
   * the lit thing was one piece, a click could only mean "this one instead" --
   * there was one light and it had to be somewhere. Now the cut lights every
   * piece that is not the work, so a click has two jobs to do: rescue a piece
   * the rule called waste, and condemn one it kept. The same press does both,
   * because the piece under the pointer says which is meant.
   *
   * Ignores an id that is not among `choices` -- nothing there but pieces, so
   * this is only ever a press on empty space -- and a press on any piece of a
   * mirrored set moves the whole set, since they are one thing.
   *
   * IT WILL NOT LIGHT THE LAST KEPT PIECE. A bed with everything lit is a bed
   * one press from empty, and Delete refuses that anyway -- so the refusal is
   * made here, where the piece is still on screen to be looked at, rather than
   * two presses later where it looks like a broken key.
   */
  markOffcut: (id: string) => void
  /**
   * Swap the lit pieces for the unlit ones: keep what was waste, bin what was
   * kept.
   *
   * THE OTHER ANSWER, IN ONE PRESS. The rule keeps the piece under the drawing,
   * which is what you want when the line is cut round the part -- and exactly
   * wrong when it is cut round the HOLE. Encircle a window in a plate and the
   * plug in the middle is the piece holding the anchor, so the plate lights up
   * as waste; this is the press that says no, the plug goes.
   *
   * IT IS HERE BECAUSE THE CLICK CANNOT ALWAYS BE. Clicking a piece is the
   * direct way to say which ones go, and it is only open with empty hands --
   * with a cutter in hand a press on the block draws a line. This is the way
   * that stays open, and it is a swap rather than a step because a panel button
   * cannot point at a piece and the interesting other answer is always the
   * whole of the other side.
   *
   * Inert with nothing lit and with nothing to swap to, which is the same
   * guarantee `markOffcut` makes: the bed is never left without a keeper.
   */
  invertOffcut: () => void
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
/** An uncut block, as the bed holds it. Exported so that opening a project can
 *  put an untouched bench back without reaching for the store's own actions,
 *  which all carry history entries this is deliberately clearing. */
export function freshPieces(): Piece[] {
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

  cut: (lines, face, mirror = null, anchor = FACE_MIDDLE) => {
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
    // EVERY PIECE ON THE BED, not the ones this cut happened to make. The
    // keeper is the piece under the drawing and everything else is waste, and
    // that test has an answer for a ring left lying beside the work two cuts
    // ago just as much as for the one made a moment ago -- see `choices`. It
    // is why `result.made` is not read here any more.
    //
    // Gathered into sets before anything is sorted, because a set is what is
    // being sorted: under a mirror the four quarters of one shape are one entry
    // in the list rather than four, and the size they are ranked by is the size
    // of the whole set.
    const sets = twinSets(pieces, face, mirror)
    const sizeOf = (set: string[]) =>
      set.reduce((sum, id) => sum + (pieces.find((p) => p.id === id)?.volume ?? 0), 0)
    // Biggest first, so the list reads down in size wherever it is shown.
    const choices = [...sets].sort((a, b) => sizeOf(b) - sizeOf(a))
    const keeper = keeperSet(pieces, choices, face, anchor)
    set({
      pieces,
      choices,
      // THE WHOLE BED BUT THE WORK. `keeperSet` never comes back empty, so
      // this never lights everything and the bed always has something left
      // after a Discard.
      offcut: pieces.filter((p) => !keeper.includes(p.id)).map((p) => p.id),
      ...remember(s),
    })
    return result.split
  },

  markOffcut: (id) =>
    set((s) => {
      // Any piece of a set names the set: they are one thing, so which of the
      // images was under the pointer cannot matter.
      const chosen = s.choices.find((choice) => choice.includes(id))
      if (!chosen) return s
      // Lit if ANY of the set is, which is the only reading that cannot get
      // stuck: a set half lit -- which nothing here makes, but a future cut's
      // sets are found by geometry and could -- goes out on one press rather
      // than needing one press per image.
      if (chosen.some((pid) => s.offcut.includes(pid))) {
        return { offcut: s.offcut.filter((pid) => !chosen.includes(pid)) }
      }
      // The last kept piece stays kept. See `markOffcut` above for why the
      // refusal is here rather than at the Delete that would follow it.
      if (s.pieces.every((p) => s.offcut.includes(p.id) || chosen.includes(p.id))) return s
      return { offcut: [...s.offcut, ...chosen] }
    }),

  invertOffcut: () =>
    set((s) => {
      // Nothing lit and there is nothing to swap FROM; everything lit cannot
      // happen, since neither the cut nor a click will leave the bed without a
      // keeper -- but the guard is cheap and says so.
      if (s.offcut.length === 0) return s
      const flipped = s.pieces.filter((p) => !s.offcut.includes(p.id)).map((p) => p.id)
      if (flipped.length === 0) return s
      return { offcut: flipped }
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
      // The bed is never emptied, whatever is lit: a screen wiped clean with a
      // Reset the only way back is a bigger act than the key that did it.
      //
      // BELT AND BRACES NOW RATHER THAN THE RULE IT WAS. Neither the cut nor a
      // click will leave the bed without a keeper -- `keeperSet` always names
      // one and `markOffcut` refuses to light the last -- so this cannot fire.
      // It stays because it is the claim itself, and the one place it would be
      // caught if some later way of lighting a piece forgot to make it.
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
