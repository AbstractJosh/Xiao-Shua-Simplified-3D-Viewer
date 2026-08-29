import { useEffect } from 'react'
import { APP_NAME } from '../appInfo'
import { useDoc } from '../store/docStore'
import { useEvalStatus } from '../store/evalStore'
import { useTools } from '../store/toolStore'
import { ExportTools } from './ExportTools'
import { ImportTools } from './ImportTools'
import { HelpTool, SettingsTool, SnapTool } from './NavTools'
import { ScreenTabs } from './ScreenTabs'
import { onDocument } from '../store/toolStore'

/**
 * Object count belongs next to the triangle count, not in the scene tree: it is
 * the other half of "how big is what I am looking at", and it is the number
 * that explains a sudden jump in triangles or evaluation time.
 */
function Stats() {
  const objects = useDoc((s) => s.doc.objects.length)
  const triangles = useEvalStatus((s) => s.triangles)
  const millis = useEvalStatus((s) => s.millis)
  // Dimmed with the controls beside it on a screen that draws no document: it
  // is a readout of the same scene they act on, and a live count of solids
  // nobody can see reads as a bug rather than as a fact about elsewhere.
  const live = useTools(onDocument)
  return (
    <span className={`stats${live ? '' : ' stats-idle'}`}>
      {objects} {objects === 1 ? 'object' : 'objects'} · {triangles.toLocaleString()} tris ·{' '}
      {millis.toFixed(1)} ms
    </span>
  )
}

/**
 * A vertical hairline between two groups in the bar, in one of two heights.
 *
 * `major` runs the full height of the bar and is used once, between the app's
 * name and the screen tabs: everything to the right of that line belongs to
 * whichever screen is chosen to the left of it, which is a bigger break than
 * any between two groups of tools. The plain one crosses the middle. A third,
 * smaller still, divides one tab from the next and belongs to `ScreenTabs` --
 * see `.topbar-rule` for the whole ladder.
 *
 * Inert, and hidden from the reader, for the reason `.island-rule` is: it
 * separates nothing that is not already two groups in the markup, and a screen
 * reader announcing a separator between every pair of buttons would be reading
 * out the layout.
 */
function Rule({ major = false }: { major?: boolean }) {
  return <span className={`topbar-rule${major ? ' topbar-rule-major' : ''}`} aria-hidden />
}

/**
 * The top bar: identity, which screen you are on, what comes in and what goes
 * out, and the state of the document.
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
  // Undo and redo act on the document, so they stand down with everything else
  // that does when the screen on show has none. Dimmed rather than removed --
  // see `SCREEN_HAS_DOCUMENT`.
  const live = useTools(onDocument)

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
      <div className="topbar-left">
        <span className="brand-mark">{APP_NAME}</span>
        {/* The full-height one, which is the biggest break in the bar:
            everything to the right of it belongs to whichever screen is chosen
            to the left of it. See `.topbar-rule`. */}
        <Rule major />
        {/* The bar's biggest decision, so it sits where the eye starts. What
            is off to the right acts on whatever is on screen; this chooses
            what is on screen at all. */}
        <ScreenTabs />
      </div>

      <div className="topbar-right">
        {/* Import beside Export, which is where it belongs now that there is
            something else claiming the left of the bar. The two are one act in
            opposite directions -- Open and Save under other names, reading and
            writing exactly the same four formats -- and a pair of doors is
            easier to find as a pair than as two controls at opposite ends of
            the window. It also puts the file controls with undo and redo, which
            are the other three things here that act on the whole document
            rather than on a selection. */}
        <ImportTools />
        <ExportTools />
        <Rule />
        {/* Snap. Snapping is not a mode aimed at the solid under the pointer --
            it draws nothing, it changes no handle, and it has no gesture of its
            own: it is a rule EVERY drag in the app obeys, whichever gizmo is
            up. It also stops the island reading as a list of unrelated things:
            what is left there is the gizmo, and the tools that put something
            new in the scene. */}
        <SnapTool />
        <Rule />
        <div className="seg">
          <button
            type="button"
            className="seg-btn"
            disabled={!live || !canUndo}
            onClick={undo}
            title="Undo (Ctrl+Z)"
          >
            Undo
          </button>
          <button
            type="button"
            className="seg-btn"
            disabled={!live || !canRedo}
            onClick={redo}
            title="Redo (Ctrl+Shift+Z)"
          >
            Redo
          </button>
        </div>
        <Rule />
        <HelpTool />
        {/* Last, and the two that survive every screen: Import, Export, Snap,
            undo and redo all act on a document, and Lathe has none to act on.
            Help explains the app and the cog holds what stays true of the next
            document you open, so both are as live on one screen as on another.
            The unit selector moved into the cog from its own button beside
            Export -- it never touched the document either, which is the whole
            argument for the panel it now shares with the theme. */}
        <SettingsTool />
        <Stats />
      </div>
    </header>
  )
}
