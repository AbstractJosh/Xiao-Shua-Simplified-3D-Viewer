import { BLOCK_HALF } from '../geometry/laserCut'
import type { FaceAxis, Pt } from '../geometry/laserCut'
import type { Face, Placement } from '../store/referenceStore'
import { clampCentre, faceFrame } from './decalPlacement'
import type { BlockDims } from './decalPlacement'

/**
 * WHERE THE WORK IS on the face being cut: the one point that says which piece
 * of a cut block is the part and which are the offcuts.
 *
 * THE PIECE HOLDING THIS POINT IS THE KEEPER, and every other piece on the bed
 * is waste -- see `keeperSet` in `laserStore`. So this file answers the only
 * question that rule needs answering, and it is a question about the way this
 * screen is actually used rather than about geometry: a reference picture is
 * dropped on a face, it lands in the middle of it, and the line is drawn ROUND
 * the picture. The part is therefore under the picture, and the middle of the
 * picture is the surest single point inside it.
 *
 * PURE, AND ITS OWN FILE, for the reason `decalPlacement` is: this is
 * arithmetic that can be wrong in a way the eye cannot catch -- an anchor a
 * face-width out lights the wrong pieces, and the screen looks exactly as
 * convincing either way -- so it is written where a headless check can hold it
 * to account.
 *
 * It is also the seam between two stores that must not read each other. The
 * laser store holds the bed and the reference store holds the pictures; this
 * takes the pictures as an argument and hands back a number, and `CutPanel`
 * carries it across, exactly as it already carries the mirror across.
 */

/**
 * The same face, named the way references name it.
 *
 * Two vocabularies for six faces, and this is the one place they meet. The
 * laser cuts on a `FaceAxis` -- an axis and an end of it, which is what the
 * compass settles on and what the kerf wall is built along -- and a decal is
 * stuck to a `Face`, a string, which is what a table of placements is keyed by.
 * Neither is the wrong shape for its own job, so the join is written once here
 * rather than either side being made to carry the other's.
 */
export function faceNameOf(face: FaceAxis): Face {
  const axis = face.axis === 0 ? 'x' : face.axis === 1 ? 'y' : 'z'
  return `${face.sign > 0 ? '+' : '-'}${axis}` as Face
}

/**
 * Where the drawing sits on this face, in the face's own (u, v) in BLOCK space.
 *
 * Block space, not scene units, because that is what everything downstream of
 * it is in: the bed is a unit cube and the sides are a scale on the group that
 * holds it, so an anchor in millimetres would move relative to the pieces every
 * time the block was resized. The placement is stored in scene units for the
 * opposite reason and just as rightly -- see `Placement` -- so the division by
 * the face's own spans is the whole of the conversion.
 *
 * NO PICTURE MEANS THE MIDDLE, which is not a fallback so much as the same
 * answer arrived at without evidence: a block cut with no reference on it is
 * being cut round something in the middle of it, because the middle is where
 * anybody centres a shape they are cutting out. It is also what makes the rule
 * describable without mentioning references at all.
 *
 * SEVERAL PICTURES ON ONE FACE, and the middle-most wins. The screen allows a
 * handful per face and there is no way to ask which one is the subject, so the
 * tie is broken the same way the no-picture case is answered: by the middle.
 * Anything else would need the user to nominate a picture, which is a control
 * this screen does not have and should not grow.
 *
 * The centre is CLAMPED first, exactly as `placementRect` clamps it, so the
 * anchor is where the picture is drawn rather than where it was last dropped: a
 * picture that hung off the edge is pulled back on before it is shown, and an
 * anchor taken from the unclamped offset would point somewhere no picture is.
 */
export function cutAnchor(face: FaceAxis, dims: BlockDims, placements: Placement[]): Pt {
  const name = faceNameOf(face)
  const frame = faceFrame(name, dims)
  let best: Pt = [0, 0]
  let nearest = Infinity
  for (const placement of placements) {
    if (placement.face !== name) continue
    const { u, v } = clampCentre(
      placement.u,
      placement.v,
      placement.w,
      placement.h,
      name,
      dims
    )
    // Guarded rather than trusted: a face of a block collapsed to nothing would
    // otherwise hand back an infinity, and every piece would fail to hold it.
    const at: Pt = [
      frame.uSpan > 0 ? u / frame.uSpan : 0,
      frame.vSpan > 0 ? v / frame.vSpan : 0,
    ]
    const off = Math.hypot(at[0], at[1])
    if (off < nearest) {
      nearest = off
      best = at
    }
  }
  // Never off the face itself. A picture is kept on its face by `clampCentre`,
  // so this cannot bite today -- it is here because the anchor is handed
  // straight to a point-in-face test, and a point outside the square would be
  // held by no piece at all and quietly turn every cut into the fallback.
  return [
    Math.min(BLOCK_HALF, Math.max(-BLOCK_HALF, best[0])),
    Math.min(BLOCK_HALF, Math.max(-BLOCK_HALF, best[1])),
  ]
}
