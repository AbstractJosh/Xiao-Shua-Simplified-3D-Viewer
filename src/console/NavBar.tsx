import { useEffect } from 'react'
import { APP_NAME, APP_TAGLINE } from '../appInfo'
import { useDoc } from '../store/docStore'
import { useEvalStatus } from '../store/evalStore'
import { useTools } from '../store/toolStore'
import { ExportTools } from './ExportTools'
import { HelpTool, UnitsTool } from './NavTools'

/**
 * Object count belongs next to the triangle count, not in the scene tree: it is
 * the other half of "how big is what I am looking at", and it is the number
 * that explains a sudden jump in triangles or evaluation time.
 */
function Stats() {
  const objects = useDoc((s) => s.doc.objects.length)
  const triangles = useEvalStatus((s) => s.triangles)
  const millis = useEvalStatus((s) => s.millis)
  return (
    <span className="stats">
      {objects} {objects === 1 ? 'object' : 'objects'} · {triangles.toLocaleString()} tris ·{' '}
      {millis.toFixed(1)} ms
    </span>
  )
}

/**
 * The top bar: identity, what leaves the app, and the state of the document.
 * What you build stays in the console on the right.
 *
 * What is left here is what is aimed at the WHOLE DOCUMENT -- export, the unit
 * every length is read in, undo, redo, the counts -- plus the gesture list.
 * Snap, Ruler and Cut went the other way, out of the bar and onto the scene
 * itself (see `ToolIsland`): they are modes aimed at a solid you are looking
 * at, and reaching them at the top edge of the window meant the hand and the
 * eye in two different places.
 */
export function NavBar() {
  const undo = useDoc((s) => s.undo)
  const redo = useDoc((s) => s.redo)
  const canUndo = useDoc((s) => s.past.length > 0)
  const canRedo = useDoc((s) => s.future.length > 0)

  const openPanel = useTools((s) => s.openPanel)
  const setOpenPanel = useTools((s) => s.setOpenPanel)

  // Escape and click-outside for EVERY tool panel, mounted once here because
  // `openPanel` is one field for all of them. The bar is not the only thing
  // they hang off any more -- Snap's opens from the island over the scene -- so
  // what counts as "inside" is named by container rather than held as a ref to
  // this element. A ref would have closed the snap panel on the first click
  // landing in the panel itself.
  useEffect(() => {
    if (openPanel === null) return

    // Capture phase, and the event stops here: the viewport also listens for
    // Escape and would deselect the object at the same time, so a single press
    // would both close the panel and throw away the selection it was aimed at.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpenPanel(null)
    }

    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest?.('.topbar, .tool-island')) return
      setOpenPanel(null)
    }

    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [openPanel, setOpenPanel])

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">{APP_NAME}</span>
        <span className="brand-sub">{APP_TAGLINE}</span>
      </div>

      <div className="topbar-right">
        {/* With undo and redo rather than with the tools on the island: Snap
            and Cut are modes aimed at whatever is selected, while these three
            are acts on the whole document -- and the two that step through its
            history are the ones an export belongs beside. */}
        <ExportTools />
        {/* Beside Export because the two answer the same question -- what are
            these numbers in -- one on screen and one in the file. It came off
            the island for the same reason the rest of this cluster is here:
            it is not a mode aimed at a solid, it is a reading of every length
            in the app at once. */}
        <UnitsTool />
        <div className="seg">
          <button
            type="button"
            className="seg-btn"
            disabled={!canUndo}
            onClick={undo}
            title="Undo (Ctrl+Z)"
          >
            Undo
          </button>
          <button
            type="button"
            className="seg-btn"
            disabled={!canRedo}
            onClick={redo}
            title="Redo (Ctrl+Shift+Z)"
          >
            Redo
          </button>
        </div>
        <HelpTool />
        <Stats />
      </div>
    </header>
  )
}
