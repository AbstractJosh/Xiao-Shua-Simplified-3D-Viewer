import { ClipboardPanel } from './ClipboardPanel'
import { ColorPanel } from './ColorPanel'
import { SceneTree } from './SceneTree'
import { ShapePalette } from './ShapePalette'
import { SolidPalette } from './SolidPalette'

/**
 * The console on the right: one column, and everything in it is true of the
 * scene whatever is selected.
 *
 * What you saved, what you can drop in, and what the scene now contains. Every
 * one of those is usable with nothing selected at all, which is also the state
 * the app opens in.
 *
 * Colour is the one panel here that ends in an act on the selection, and it
 * still belongs on this side: it is a thing you pick up and aim, like the two
 * palettes above it, rather than a field describing whatever is selected. Only
 * its Apply button needs a selection, and it says so when it has none.
 *
 * IT USED TO BE TWO TABS. The other one, Edit, held the three panels that only
 * mean anything once something IS selected -- where it sits, how big it is,
 * and what its sketches do -- and those have moved to the bottom-right of the
 * viewport, where the thing they describe can be watched while they are
 * dragged. The tab strip went with them: what remains is one list, all of it
 * live at all times, and a strip whose second tab is gone is a control with
 * nothing to switch between.
 *
 * The split was worth having while it lasted -- seven panels in one column was
 * more than a screen of them, and the tree lived below the fold behind a
 * scroll. Five is not.
 */
export function Console() {
  return (
    <aside className="console">
      {/* Above the fixed catalogue below it: what you saved is yours and
          specific to this scene, so it is the first thing to reach for rather
          than something to scroll past ten primitives to find. */}
      <ClipboardPanel />
      <SolidPalette />
      <ShapePalette />
      {/* Below the two palettes because it is the panel you reach for AFTER
          something is in the scene, and above the tree because it is still a
          thing you pick up and use rather than a readout of what the document
          holds. */}
      <ColorPanel />
      <SceneTree />
    </aside>
  )
}
