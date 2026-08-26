import { ClipboardPanel } from './console/ClipboardPanel'
import { Inspector } from './console/Inspector'
import { NavBar } from './console/NavBar'
import { ObjectPanel } from './console/ObjectPanel'
import { PlacementPanel } from './console/PlacementPanel'
import { SceneTree } from './console/SceneTree'
import { ShapePalette } from './console/ShapePalette'
import { SolidPalette } from './console/SolidPalette'
import { Viewport } from './viewport/Viewport'

/**
 * Two halves, split by what they are about. The bar across the top holds the
 * tools -- how you work, and what leaves the app. The console on the right holds
 * the document: what you can drop in, what is selected, and what the scene now
 * contains. Nothing appears in both.
 */
export default function App() {
  return (
    <div className="app">
      <NavBar />

      <main className="main">
        <Viewport />
        <aside className="console">
          {/* Top of the console, above the fixed catalogue below it: what you
              saved is yours and specific to this scene, so it is the first
              thing to reach for rather than something to scroll past ten
              primitives to find. */}
          <ClipboardPanel />
          <SolidPalette />
          <ShapePalette />
          <PlacementPanel />
          <ObjectPanel />
          <Inspector />
          <SceneTree />
        </aside>
      </main>
    </div>
  )
}
