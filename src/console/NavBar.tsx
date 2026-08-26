import { useEffect, useRef } from 'react'
import { APP_NAME, APP_TAGLINE } from '../appInfo'
import { useDoc } from '../store/docStore'
import { useEvalStatus } from '../store/evalStore'
import { useTools } from '../store/toolStore'
import { ExportTools } from './ExportTools'
import { CutActions, CutTool, HelpTool, SnapTool } from './NavTools'

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
 * The top bar: identity, the tools you work *with*, and the state of the
 * document. What you build stays in the console on the right.
 *
 * Snap, Cut and Export moved up here because none of them describe the scene.
 * They are modes and actions that apply to whatever is selected, and while they
 * lived in the console they pushed the panels that do describe the scene -- the
 * object, its sketch, the tree -- below the fold on a laptop.
 */
export function NavBar() {
  const undo = useDoc((s) => s.undo)
  const redo = useDoc((s) => s.redo)
  const canUndo = useDoc((s) => s.past.length > 0)
  const canRedo = useDoc((s) => s.future.length > 0)

  const openPanel = useTools((s) => s.openPanel)
  const setOpenPanel = useTools((s) => s.setOpenPanel)

  const barRef = useRef<HTMLElement>(null)

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
      if (barRef.current?.contains(e.target as Node)) return
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
    <header className="topbar" ref={barRef}>
      <div className="brand">
        <span className="brand-mark">{APP_NAME}</span>
        <span className="brand-sub">{APP_TAGLINE}</span>
      </div>

      <nav className="navbar" aria-label="Tools">
        <SnapTool />
        <CutTool />
        {/* Only on screen while the plane is armed, so the bar is no wider than
            before for anyone not cutting. */}
        <CutActions />
        <span className="nav-sep" aria-hidden />
        <ExportTools />
      </nav>

      <div className="topbar-right">
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
