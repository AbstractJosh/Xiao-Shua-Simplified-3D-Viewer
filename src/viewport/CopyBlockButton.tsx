import { useEffect, useState } from 'react'
import { fitToEnvelope } from '../geometry/importers'
import { bedGeometry } from '../geometry/laserCut'
import { registerMesh } from '../geometry/meshLibrary'
import { makeObject } from '../geometry/types'
import type { BaseSolid, Vec3 } from '../geometry/types'
import { bedIsUncut, useLaser } from '../store/laserStore'
import { useLibrary } from '../store/libraryStore'
import { useTools } from '../store/toolStore'
import { formatSize } from '../units'

/**
 * The way off the laser cutter: take what is on the bed and put it on the
 * clipboard.
 *
 * THE SAME DOOR THE LATHE USES, and deliberately the same button in the same
 * words -- see `CopyPieceButton` for why the clipboard is the door rather than
 * "add to the scene". Every argument there holds here: the clipboard is the one
 * thing in this app that belongs to the USER rather than to a document, it
 * survives the scene being replaced, and it is the panel this screen's console
 * already carries. A third screen reaching into a document it cannot see would
 * land a solid somewhere nobody was looking.
 *
 * WHAT COMES ACROSS IS THE BED, and nothing else. Everything on it, as one
 * solid, at the size the block is set to. The pieces live in block space -- a
 * unit cube the viewport scales -- so this is the one place the three sides are
 * baked into the geometry, because the document next door has no Side field to
 * read them from. See `bedGeometry`.
 *
 * WHAT DOES NOT COME ACROSS IS THE REFERENCES. The pictures laid on the block
 * are decals over the faces -- their own store, their own layer, drawn on top
 * of the pieces rather than part of them -- so they are left behind by
 * construction rather than by a filter that could be forgotten. That is the
 * right answer and not merely the easy one: a reference is a thing to cut TO,
 * the way a pencil line on stock is, and a photograph welded to a face would be
 * the one part of the piece that could never be machined off.
 *
 * AN UNCUT BLOCK ARRIVES AS A BOX, not as a mesh that looks like one. It is
 * worth the branch. A `box` base can be resized on its own three axes, sketched
 * on face by face with real anchors, and written out as a solid; the same shape
 * as twelve triangles gets derived anchors and a triangle soup. Nobody would
 * thank us for handing them the worse of two identical-looking cubes. The
 * moment a cut lands there is no box to hand over any more, and the mesh is the
 * honest answer. See `bedIsUncut`.
 *
 * It is a SNAPSHOT, the same word the lathe's button earns: the copy does not
 * change when the bed does. Press it again after another cut and a second,
 * later piece takes the clipboard's slot.
 */

/** How long the receipt stays up. The lathe's own eight seconds -- the two
 *  buttons are one control on two screens and must not linger differently. */
const NOTED_MS = 8000

/** What an uncut block is called on the shelf. Not "Cube": the block has three
 *  independent sides and is usually not one. */
export const BLOCK_NAME = 'Laser block'

/**
 * And what a cut bed is called, which depends on how much is left on it.
 *
 * The shelf names entries by counting -- `Custom 3` -- which is why this button
 * names its own: a row of tiles that all say Custom is a row nobody can read.
 * The count is in the name because it is the one thing a thumbnail cannot show.
 * Two pieces lying apart and one piece with a slot through it make very nearly
 * the same picture from the front, and they are not the same object.
 */
export function bedName(pieces: number, uncut: boolean): string {
  if (uncut) return BLOCK_NAME
  return pieces === 1 ? 'Cut piece' : `Cut pieces (${pieces})`
}

export function CopyBlockButton() {
  const copyObject = useLibrary((s) => s.copyObject)
  const saveCustom = useLibrary((s) => s.saveCustom)
  const renameCustom = useLibrary((s) => s.renameCustom)
  const displayUnit = useTools((s) => s.displayUnit)
  const [noted, setNoted] = useState<string | null>(null)

  useEffect(() => {
    if (noted === null) return
    const timer = setTimeout(() => setNoted(null), NOTED_MS)
    return () => clearTimeout(timer)
  }, [noted])

  const copy = () => {
    // Read at the moment of the press rather than subscribed to, the way the
    // lathe's button reads its clay: nothing here needs to re-render while a
    // line is being drawn.
    const { dims, pieces } = useLaser.getState()
    if (pieces.length === 0) return

    const uncut = bedIsUncut(pieces)
    const name = bedName(pieces.length, uncut)

    // An uncut block is a box and says so. `dims` is already in scene units and
    // already inside the envelope -- `BLOCK_MIN`/`BLOCK_MAX` are the document's
    // own limits, borrowed for exactly this moment -- so there is nothing to
    // fit and nothing to normalise.
    let base: BaseSolid
    let size: Vec3
    let tris = 0
    if (uncut) {
      size = [dims[0], dims[1], dims[2]]
      base = { kind: 'box', size }
    } else {
      // `registerMesh` consumes the geometry: it normalises it in place and
      // keeps it, which is what this is built for and why it is built here
      // rather than held anywhere.
      const entry = registerMesh(
        bedGeometry(
          pieces.map((p) => p.geometry),
          dims
        ),
        name
      )
      // Through the same gate an import goes through. Nothing cut here can be
      // outside the app's envelope today, since the block is bounded by the
      // same limits every box is -- but the day those bounds move, a piece that
      // could not exist in the scene must not be handed to it.
      size = fitToEnvelope(entry.natural).size
      base = { kind: 'mesh', meshId: entry.id, label: entry.label, size }
      tris = entry.triangles
    }

    // Standing on the ground, because a box and a mesh base are both centred on
    // their own origin and everything else in this app lands resting on the
    // grid. The paste sets it down clear of whatever is already there, so where
    // it is now only decides how it looks in the thumbnail.
    //
    // NAMED OVER `makeObject`'s own answer, which for the box case would be the
    // shape's name -- "Box" -- and would lose the one thing worth saying about
    // it. The lathe's piece arrives in the scene tree called what it is because
    // a mesh carries its label; a box has a name of its own and would otherwise
    // shed its provenance on the way across. One name, so the tile, the
    // thumbnail's label and the row in the tree all agree.
    const solid = { ...makeObject(base, [0, size[1] / 2, 0]), name }
    // BOTH HALVES OF "COPY", for the reason the lathe's button spells out: the
    // panel called Clipboard is the SHELF, while Ctrl+V pastes the transient
    // buffer. A press that did one of them would either put the piece somewhere
    // invisible or leave the obvious keystroke doing nothing.
    copyObject(solid)
    renameCustom(saveCustom(solid), name)

    // An uncut block has nothing to say about triangles -- it is a box, and the
    // three sides ARE the thing that was copied. A cut bed has nothing useful
    // to say about its sides, since its extent is whatever the cuts left, so it
    // reports what it actually is: how many pieces, and how heavy.
    //
    // ONE UNIT FOR THE TRIPLE, resolved off the longest side, rather than three
    // calls to `formatLength`. That helper picks a unit per value, so in auto a
    // 20 cm side beside a 5 mm one would print two different units in one size
    // -- and even where they agreed, the suffix would be said three times. The
    // rule lives in `units.ts` now, because the scene tree wanted the same
    // sentence for a rectangle's two sides. See `formatSize`.
    setNoted(
      uncut
        ? `Copied · ${formatSize(size, displayUnit)}`
        : `Copied · ${pieces.length} piece${pieces.length === 1 ? '' : 's'}` +
            ` · ${tris.toLocaleString()} tris`
    )
  }

  return (
    <div className="copy-piece copy-piece-aside">
      <button type="button" className="btn copy-piece-btn" onClick={copy}>
        Copy to clipboard
      </button>
      {/* What went on the shelf, said out loud, and then taken away again. The
          thumbnail appearing in the console is the other half of the answer,
          and it is the half a user looking at the bed rather than at the
          console will miss entirely. Nothing is said before the first press --
          the corner is scene until there is something to report. */}
      {noted && (
        <p className="copy-piece-note" role="status">
          {noted}
        </p>
      )}
    </div>
  )
}
