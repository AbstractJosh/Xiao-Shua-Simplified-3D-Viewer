import { useRef, useState } from 'react'
import { sceneBounds } from '../geometry/assembly'
import { IMPORT_ACCEPT, fitToEnvelope, importModel } from '../geometry/importers'
import { registerMesh } from '../geometry/meshLibrary'
import type { BaseSolid, Doc, Vec3 } from '../geometry/types'
import { useDoc } from '../store/docStore'
import { formatLength } from '../units'
import { useTools } from '../store/toolStore'
import { ImportIcon } from './navIcons'
import { ReceiptFlyout, useReceipt } from './Receipt'

/** Clear air between an imported model and whatever is already in the scene. */
const IMPORT_GAP = 0.2

/**
 * Where to set a model of this size down.
 *
 * On the ground, and clear of everything already there -- to the right of the
 * whole scene, the way a pasted copy lands beside its original. Dropped at the
 * origin instead, an import into a scene that already has something at the
 * origin arrives INSIDE it, and the user's first act is to work out which of
 * the two shapes they have hold of.
 *
 * The lift is half the height because every solid in this app is centred on its
 * own local origin, imports included: `registerMesh` centres the triangles as
 * it normalises them.
 */
export function dropPosition(doc: Doc, size: Vec3): Vec3 {
  const scene = sceneBounds(doc)
  const y = size[1] / 2
  if (scene.isEmpty()) return [0, y, 0]
  return [scene.max.x + IMPORT_GAP + size[0] / 2, y, 0]
}

/**
 * Import, sitting in the bar beside the app's name.
 *
 * It is there because of what it is: the way a document GETS INTO the app,
 * which makes it a sibling of the name rather than one more tool in the cluster
 * at the right. That cluster is what you do to a document you already have --
 * export it, undo, redo, read its units -- and every one of those is meaningless
 * on the empty scene the app opens in. This is the one control that is not.
 *
 * The tagline used to sit here. It said "drop a shape, push or pull it", which
 * was true and which the palette on the right says better by being a palette.
 *
 * WHAT IT ACCEPTS is exactly what Export writes -- see `importers.ts`. That
 * symmetry is the point of it: the pair together are Save and Open under other
 * names, and a format the app would hand you but refuse to take back would be a
 * door that only opens outwards.
 */
export function ImportTools() {
  const addObject = useDoc((s) => s.addObject)
  const setOpenPanel = useTools((s) => s.setOpenPanel)
  // The receipt reads its size in whatever unit the rest of the app is reading
  // in, so "20.0 cm across" is the same 20.0 the Width field will show.
  const displayUnit = useTools((s) => s.displayUnit)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const receipt = useReceipt()

  const run = async (files: File[]) => {
    setBusy(true)
    try {
      const landed: string[] = []
      let note: string | undefined

      // One at a time, and in the order they were chosen: each one's position
      // is worked out from the scene the one before it landed in, so a
      // multi-file import lines up instead of stacking in the same spot.
      for (const file of files) {
        const model = await importModel(await file.arrayBuffer(), file.name)
        const entry = registerMesh(model.geometry, model.label)
        const { size, factor } = fitToEnvelope(entry.natural)
        const base: BaseSolid = {
          kind: 'mesh',
          meshId: entry.id,
          label: entry.label,
          size,
        }
        // Read fresh each time round rather than from a hook: the object added
        // on the previous pass is in the document but not yet in this render's
        // props, and a second file dropped on the stale one would land inside it.
        addObject(base, dropPosition(useDoc.getState().doc, size))
        landed.push(model.label)
        note =
          model.detail ??
          (factor !== 1
            ? `scaled to fit · ${formatLength(Math.max(...size), displayUnit)} across`
            : `${formatLength(Math.max(...size), displayUnit)} across`)
      }

      const what =
        landed.length === 1 ? landed[0] : `${landed.length} models`
      receipt.report(`${what}${note ? ` · ${note}` : ''}`)
    } catch (err) {
      receipt.fail(err, 'Import failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="nav-import">
      {/* Off screen rather than `display: none`: a hidden input is still the
          thing that opens the file dialog, and some browsers will not open one
          from an element that is not laid out. */}
      <input
        ref={input}
        type="file"
        className="visually-hidden"
        accept={IMPORT_ACCEPT}
        multiple
        tabIndex={-1}
        onChange={(e) => {
          // COPIED OUT FIRST, and that order is the whole of it. `e.target.files`
          // is a LIVE view of the input's selection rather than a snapshot of
          // it, so clearing the value empties the very list being read -- the
          // length goes to zero between one line and the next, and the import
          // silently never runs. An array is a copy and survives the reset.
          const files = Array.from(e.target.files ?? [])
          // Cleared at all because re-picking the SAME file fires no change
          // event while its name is still in the input, and picking a file a
          // second time is exactly what happens after one fails.
          e.target.value = ''
          if (files.length > 0) void run(files)
        }}
      />

      <div className="nav-group">
        <button
          type="button"
          className="nav-btn"
          disabled={busy}
          title="Import a model: GLB, OBJ, STL or STEP. It lands as one solid you can size, move, cut and merge."
          onClick={() => {
            // Any tool panel hanging off the bar is pointing at the document
            // that is about to change under it.
            setOpenPanel(null)
            input.current?.click()
          }}
        >
          <span className="nav-icon" aria-hidden>
            <ImportIcon />
          </span>
          <span className="nav-label">{busy ? 'Reading…' : 'Import'}</span>
        </button>
      </div>

      <ReceiptFlyout receipt={receipt} />
    </div>
  )
}
