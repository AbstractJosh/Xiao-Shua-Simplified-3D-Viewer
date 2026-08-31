import { useEffect, useState } from 'react'
import { pieceHeight } from '../geometry/clay'
import { fitToEnvelope } from '../geometry/importers'
import { registerMesh } from '../geometry/meshLibrary'
import { revolveClay } from '../geometry/revolve'
import { makeObject, polygonPrefix } from '../geometry/types'
import type { BaseSolid } from '../geometry/types'
import { useLathe } from '../store/latheStore'
import { useLibrary } from '../store/libraryStore'
import { useTools } from '../store/toolStore'
import { formatLength } from '../units'

/**
 * The way off the lathe: turn the piece into a solid and put it on the
 * clipboard.
 *
 * THE ONE DOOR BETWEEN THE TWO SCREENS, and the reason the clipboard is the
 * door rather than "add to the scene" is that the clipboard is already the one
 * thing in this app that belongs to the USER rather than to a document -- it
 * survives the scene being replaced, it lives outside `Doc`, and it is the one
 * panel the lathe's console carries. A button here that reached into the
 * modelling document would be this screen editing a scene it cannot see, and
 * would land a solid somewhere the user was not looking. On the clipboard it
 * waits, with a live thumbnail of itself in the console beside it, until
 * somebody drags it onto the grid or pastes it where they want it.
 *
 * IT DOES BOTH HALVES OF "COPY", because the panel called Clipboard is the
 * SHELF -- `saveCustom` -- while Ctrl+V pastes the transient buffer that
 * `copyObject` fills, and a button that did only one of them would either put
 * the piece somewhere invisible or leave the obvious keystroke doing nothing.
 * They are one act from where the user is standing: this piece, on my
 * clipboard. The shelf entry is what appears in the console and can be dragged
 * into the scene; the buffer is what the next Ctrl+V drops.
 *
 * WHAT IS COPIED is a mesh, not a lathe recipe. The wall is swept a full turn
 * and capped -- see `revolveClay` -- and the triangles go on the shelf
 * `registerMesh` keeps for imported models, which is exactly what this is from
 * the document's point of view: a shape no formula in `dimensions.ts`
 * describes. That buys the whole of the modelling screen for free. The piece
 * arrives selectable, sizeable, cuttable, mirrorable, exportable, and it can be
 * melted with the torch like anything else, because it is the same kind of
 * object an STL becomes.
 *
 * It is a SNAPSHOT, and that is the honest word for it: the copy does not
 * change when the clay does. Press it again after another minute of shaping and
 * a second, later piece takes the clipboard's slot -- the same way copying an
 * object in the scene twice does.
 *
 * TOP-RIGHT, the corner the modelling screen gives its compass. There is no
 * compass here -- nothing to orbit -- so it is the free corner furthest from
 * the tools, which is where a button you press at the END of a sitting belongs.
 */

/** How long the receipt stays up. The same eight seconds Import and Export use;
 *  see `RECEIPT_MS`, which is not imported because a viewport corner has no
 *  business depending on the console's flyout. */
const NOTED_MS = 8000

/** What the piece is called on the shelf and in the scene. One name, so the
 *  tile, the thumbnail's label and the object that lands from a paste all agree. */
export const PIECE_NAME = 'Turned piece'

/**
 * And the same name with the base said out loud, for a piece that has one.
 *
 * The shelf names entries by counting, which is why this button names its own
 * -- see the rename below -- and the same argument runs one step further the
 * moment the lathe can make more than one kind of thing. A shelf of tiles that
 * all say "Turned piece" is a shelf nobody can read, and the section is the one
 * difference between two pieces that a thumbnail may not show: seen from the
 * front, a hexagonal piece and the round one it was copied from are the same
 * picture.
 *
 * `polygonPrefix` rather than a word of its own, so a piece turned on a hexagon
 * and a hexagonal prism dropped from the palette are called the same thing.
 */
export function pieceName(sides: number | null): string {
  return sides === null ? PIECE_NAME : `${polygonPrefix(sides)} turned piece`
}

export function CopyPieceButton() {
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
    // Read at the moment of the press rather than subscribed to: this button
    // is one of the few things on the screen that does not have to re-render
    // sixty times a second while a stroke is going on.
    const { clay } = useLathe.getState()

    // `registerMesh` consumes the geometry -- it normalises it in place and
    // keeps it -- which is exactly what this is built for and why it is built
    // here rather than held anywhere. The sweep reads the base off the clay: a
    // round piece gets its 64 facets, a hexagonal one gets six flats. See
    // `revolveClay`.
    const name = pieceName(clay.sides)
    const entry = registerMesh(revolveClay(clay), name)
    // Through the same gate an import goes through. Nothing the lathe can make
    // is outside the app's envelope today, since the stock is bounded by the
    // same `dimensions.ts` limits every cylinder is -- but the day those bounds
    // move, a piece that could not exist in the scene must not be handed to it.
    const { size } = fitToEnvelope(entry.natural)
    const base: BaseSolid = { kind: 'mesh', meshId: entry.id, label: entry.label, size }
    // Standing on the ground, because a mesh base is centred on its own origin
    // and everything else in this app lands resting on the grid. The paste sets
    // it down clear of whatever is already there, so where it is now only
    // decides how it looks in the thumbnail.
    const piece = makeObject(base, [0, size[1] / 2, 0])
    copyObject(piece)
    // Named for what it is rather than left as `Custom 3`. The shelf names
    // entries by counting because it has nothing better to go on; this one
    // knows exactly what it put there, and a row of tiles that all say Custom
    // is a row nobody can read. It stays editable in place, like every other.
    renameCustom(saveCustom(piece), name)

    setNoted(
      // The PIECE's height, the same one the readout in the other corner shows
      // -- see `pieceHeight`. A receipt for a piece whose top has been rounded
      // off must not quote the stock it was cut from.
      `Copied · ${formatLength(pieceHeight(clay), displayUnit)} tall` +
        ` · ${entry.triangles.toLocaleString()} tris`
    )
  }

  return (
    <div className="copy-piece">
      <button type="button" className="btn copy-piece-btn" onClick={copy}>
        Copy to clipboard
      </button>
      {/* What went on the shelf, said out loud, and then taken away again.
          The thumbnail appearing in the console is the other half of the
          answer, and it is the half a user looking at the piece rather than at
          the console will miss entirely. Nothing is said before the first press
          -- the corner is scene until there is something to report, and how big
          the piece is already stands in the readout opposite. */}
      {noted && (
        <p className="copy-piece-note" role="status">
          {noted}
        </p>
      )}
    </div>
  )
}
