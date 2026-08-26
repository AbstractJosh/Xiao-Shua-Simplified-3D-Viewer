import { useDoc } from '../store/docStore'
import { useTools } from '../store/toolStore'
import type { ConsoleTab } from '../store/toolStore'
import { ClipboardPanel } from './ClipboardPanel'
import { ColorPanel } from './ColorPanel'
import { Inspector } from './Inspector'
import { ObjectPanel } from './ObjectPanel'
import { PlacementPanel } from './PlacementPanel'
import { SceneTree } from './SceneTree'
import { ShapePalette } from './ShapePalette'
import { SolidPalette } from './SolidPalette'

/**
 * The console on the right, in two tabs.
 *
 * It used to be all seven panels stacked in one column, which was more than a
 * screen of them: the Inspector and the scene tree lived below the fold behind
 * a scroll, and the panels that were open were rarely the ones being used. The
 * split is by what a panel is FOR rather than by what it holds.
 *
 * **View** is everything that is true of the scene whatever is selected -- what
 * you saved, what you can drop in, and what the scene now contains. Every one
 * of those is usable with nothing selected at all, which is also the state the
 * app opens in.
 *
 * Colour is the one panel here that ends in an act on the selection, and it
 * still belongs on this side: it is a thing you pick up and aim, like the two
 * palettes above it, rather than a field describing whatever is selected. Only
 * its Apply button needs a selection, and it says so when it has none.
 *
 * **Edit** is the controls that only mean anything once something IS selected:
 * where it sits, how big it is, and what its sketches do. All three already
 * render an empty state saying so, and now they do it in one place instead of
 * three-sevenths of a column.
 *
 * The tab strip is sticky rather than scrolling away with the panels, because
 * the console is a scroll container and a switch you have to scroll back up to
 * find is a switch that gets used once.
 */
const TABS: { id: ConsoleTab; label: string }[] = [
  { id: 'view', label: 'View' },
  { id: 'edit', label: 'Edit' },
]

export function ConsoleTabs() {
  const tab = useTools((s) => s.consoleTab)
  const setTab = useTools((s) => s.setConsoleTab)
  // Selecting an object fills the Edit tab and changes nothing on this one, so
  // without a mark the console simply looks inert to the click. A dot rather
  // than an automatic switch: a user placing five solids in a row would have
  // the palette pulled out from under them four times.
  const selected = useDoc((s) => s.selectedObjectIds.length > 0)

  return (
    <div className="console-tabs" role="tablist" aria-label="Console">
      {TABS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          className={`console-tab${tab === id ? ' console-tab-active' : ''}`}
          onClick={() => setTab(id)}
        >
          {label}
          {id === 'edit' && selected && <span className="console-tab-dot" aria-hidden />}
        </button>
      ))}
    </div>
  )
}

export function Console() {
  const tab = useTools((s) => s.consoleTab)

  return (
    <aside className="console">
      <ConsoleTabs />
      {tab === 'view' ? (
        <>
          {/* Above the fixed catalogue below it: what you saved is yours and
              specific to this scene, so it is the first thing to reach for
              rather than something to scroll past ten primitives to find. */}
          <ClipboardPanel />
          <SolidPalette />
          <ShapePalette />
          {/* Below the two palettes because it is the panel you reach for
              AFTER something is in the scene, and above the tree because it is
              still a thing you pick up and use rather than a readout of what
              the document holds. */}
          <ColorPanel />
          <SceneTree />
        </>
      ) : (
        <>
          <PlacementPanel />
          <ObjectPanel />
          <Inspector />
        </>
      )}
    </aside>
  )
}
