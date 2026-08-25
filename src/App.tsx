import { FeatureList } from './console/FeatureList'
import { Inspector } from './console/Inspector'
import { ShapePalette } from './console/ShapePalette'
import { ExportPanel } from './console/ExportPanel'
import { Section } from './console/Field'
import { useDoc } from './store/docStore'
import { useEvalStatus } from './store/evalStore'
import { Viewport } from './viewport/Viewport'

function BaseSwitcher() {
  const base = useDoc((s) => s.doc.base)
  const setBase = useDoc((s) => s.setBase)
  const featureCount = useDoc((s) => s.doc.features.length)

  const change = (next: 'box' | 'sphere') => {
    if (next === base.kind) return
    if (
      featureCount > 0 &&
      !window.confirm('Changing the base object clears its sketches. Continue?')
    ) {
      return
    }
    setBase(next === 'box' ? { kind: 'box', size: [2, 2, 2] } : { kind: 'sphere', radius: 1.2 })
  }

  return (
    <div className="seg">
      <button
        type="button"
        className={`seg-btn${base.kind === 'box' ? ' seg-active' : ''}`}
        onClick={() => change('box')}
      >
        Cube
      </button>
      <button
        type="button"
        className={`seg-btn${base.kind === 'sphere' ? ' seg-active' : ''}`}
        onClick={() => change('sphere')}
      >
        Sphere
      </button>
    </div>
  )
}

function Stats() {
  const triangles = useEvalStatus((s) => s.triangles)
  const millis = useEvalStatus((s) => s.millis)
  return (
    <span className="stats">
      {triangles.toLocaleString()} tris · {millis.toFixed(1)} ms
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
          <span className="brand-mark">EZ3D</span>
          <span className="brand-sub">drop a shape, push or pull it</span>
        </div>
        <div className="topbar-right">
          <BaseSwitcher />
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
          <ShapePalette />
          <Inspector />
          <FeatureList />
          <ExportPanel />
          <Section title="Controls">
            <ul className="keys">
              <li><b>Drag</b> a shape from Shapes onto the object</li>
              <li><b>Drag</b> a sketch to slide it across the surface</li>
              <li><b>Orbit</b> with left-drag on empty space, zoom to scroll</li>
              <li><b>Delete</b> removes the selected sketch</li>
            </ul>
          </Section>
        </aside>
      </main>
    </div>
  )
}
