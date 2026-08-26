import { ExportPanel } from './console/ExportPanel'
import { Section } from './console/Field'
import { Inspector } from './console/Inspector'
import { ObjectPanel } from './console/ObjectPanel'
import { SceneTree } from './console/SceneTree'
import { ShapePalette } from './console/ShapePalette'
import { SolidPalette } from './console/SolidPalette'
import { ToolsPanel } from './console/ToolsPanel'
import { useDoc } from './store/docStore'
import { useEvalStatus } from './store/evalStore'
import { Viewport } from './viewport/Viewport'
import { APP_NAME, APP_TAGLINE } from './appInfo'

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

export default function App() {
  const undo = useDoc((s) => s.undo)
  const redo = useDoc((s) => s.redo)
  const canUndo = useDoc((s) => s.past.length > 0)
  const canRedo = useDoc((s) => s.future.length > 0)

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">{APP_NAME}</span>
          <span className="brand-sub">{APP_TAGLINE}</span>
        </div>
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
          <Stats />
        </div>
      </header>

      <main className="main">
        <Viewport />
        <aside className="console">
          <SolidPalette />
          <ShapePalette />
          <ToolsPanel />
          <ObjectPanel />
          <Inspector />
          <SceneTree />
          <ExportPanel />
          <Section title="Controls">
            <ul className="keys">
              <li><b>Drag</b> a solid from Solids into the scene to add it</li>
              <li><b>Drag</b> a 2D shape from Shapes onto any object</li>
              <li><b>Click</b> an object to select it, then <b>drag</b> it to move it</li>
              <li><b>Shift</b> while moving an object lifts it instead</li>
              <li><b>Drag</b> a sketch to slide it across its own surface</li>
              <li><b>Drag</b> the highlighted end face of an extrusion to lean it</li>
              <li><b>Snap</b> and <b>Cut</b> live in Tools</li>
              <li><b>Orbit</b> with left-drag on empty space, zoom to scroll</li>
              <li><b>Delete</b> removes the selected sketch, or the object</li>
            </ul>
          </Section>
        </aside>
      </main>
    </div>
  )
}
