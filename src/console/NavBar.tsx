import { useEffect } from 'react'
import { APP_NAME } from '../appInfo'
import { useDoc } from '../store/docStore'
import { useEvalStatus } from '../store/evalStore'
import { useTools } from '../store/toolStore'
import { ExportTools } from './ExportTools'
import { ImportTools } from './ImportTools'
import { HelpTool, SettingsTool, SnapTool } from './NavTools'

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
 * The top bar: identity, what comes in and what goes out, and the state of the
 * document.
 * What you build stays in the console on the right.
 *
 * What is left here is what applies to the WHOLE DOCUMENT -- export, the unit
 * every length is read in, the snap rule every drag obeys, undo, redo, the
 * counts -- plus the gesture list. The gizmo tools, Ruler and Cut went the
 * other way, out of the bar and onto the scene itself (see `ToolIsland`): they
 * are aimed at a solid you are looking at, and reaching them at the top edge of
 * the window meant the hand and the eye in two different places.
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
      // `.help-screen` is the CARD, deliberately not the backdrop behind it:
      // a press on the dark surround finds no card above it, falls through to
      // this, and closes the screen -- which is what a modal surround is for.
      if (target?.closest?.('.topbar, .tool-island, .help-screen')) return
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
        {/* Beside the name rather than in the cluster on the right, because it
            is the one control here that is about the document ARRIVING. Export,
            Units, Undo and Redo are all things you do to a document you already
            have, and every one of them is inert on the empty scene the app
            opens in; this is what fills that scene. The tagline used to sit in
            this spot and said less. */}
        <ImportTools />
      </div>

      <div className="topbar-right">
        {/* With undo and redo rather than with the tools on the island: Snap
            and Cut are modes aimed at whatever is selected, while these three
            are acts on the whole document -- and the two that step through its
            history are the ones an export belongs beside. */}
        <ExportTools />
        {/* Snap, for the same reason and one more. Snapping is
            not a mode aimed at the solid under the pointer -- it draws nothing,
            it changes no handle, and it has no gesture of its own: it is a rule
            EVERY drag in the app obeys, whichever gizmo is up, which is what
            these three switches on the right have in common. It also stops the
            island reading as a list of unrelated things: what is left there is
            the gizmo, and the two tools that put something new in the scene. */}
        <SnapTool />
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
        {/* Last, because it is the only thing in the bar that is not about this
            document. Export, Undo, Redo and Snap all act on what is open; Help
            explains it; the cog holds what stays true of the next one you open.
            The unit selector moved in here from its own button beside Export --
            it never touched the document either, which is the whole argument
            for the panel it now shares with the theme. */}
        <SettingsTool />
        <Stats />
      </div>
    </header>
  )
}
