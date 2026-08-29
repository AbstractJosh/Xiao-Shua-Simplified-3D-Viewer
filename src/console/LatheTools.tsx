import {
  BRUSH_RADIUS_MAX,
  BRUSH_RADIUS_MIN,
  DEFAULT_LATHE_REACH,
  DEFAULT_LATHE_STRENGTH,
  useTools,
} from '../store/toolStore'
import type { LatheTool } from '../store/toolStore'
import { NumberField } from './Field'
import { NavTool } from './NavTool'
import { PullIcon, PushIcon } from './navIcons'

/**
 * The Lathe screen's two tools: the pair that shapes the piece, and nothing
 * else.
 *
 * Their own file rather than two more entries in `NavTools`, which is already
 * the longest file in the console. The split is by SCREEN and it is the same
 * one `LatheConsole` makes: these exist because there is a lathe, and neither
 * means anything on a screen with no clay on it.
 *
 * They are `NavTool`s all the same -- the same button, the same caret, the same
 * panel hanging under it -- because a tool is a tool wherever it is mounted.
 * Both go on the island over the piece, where the hand already is.
 *
 * WHAT IS NOT HERE is the stock the piece is turned from. It was a third
 * `NavTool`, in the bar, and it is now a panel standing open in the corner of
 * the viewport -- see `StockPanel`. The line is the one the island already
 * draws: these two are things you PICK UP, and the size of the lump is not.
 */

/**
 * One tool: the button that takes it up, and the two dials it is set with.
 *
 * WRITTEN ONCE AND USED TWICE, the way `ModeTool` is, because push and pull
 * differ by a word and a sign. Everything a user learns about Size and Strength
 * on one of them is true of the other, and a second copy of this panel would be
 * two chances to teach the same thing differently.
 *
 * TWO DIALS, NOT THREE. The modelling brushes carry Smoothing as well, and it
 * is a real control there: their surface is a mesh that can crease, and how
 * much a dab flows against how much it sinks is a choice with two good answers.
 * Here the wall is a row of radii that is relaxed by a fixed amount after every
 * dab -- see `RELAX` in `clay.ts` -- because a turned piece is smooth by
 * definition. There is no crease to allow and so no dial to expose, and the
 * whole screen is two tools with two numbers each, which is what makes it the
 * easy one.
 */
function PushPullTool({ tool, label }: { tool: NonNullable<LatheTool>; label: string }) {
  const armed = useTools((s) => s.latheTool === tool)
  const setLatheTool = useTools((s) => s.setLatheTool)
  const push = tool === 'push'

  // Each tool keeps its own pair -- see `pushReach` in the tool store for why
  // sharing them would have the user re-dialling one size all session.
  const reach = useTools((s) => (push ? s.pushReach : s.pullReach))
  const setReach = useTools((s) => (push ? s.setPushReach : s.setPullReach))
  const sizeUnit = useTools((s) => (push ? s.pushSizeUnit : s.pullSizeUnit))
  const setSizeUnit = useTools((s) => (push ? s.setPushSizeUnit : s.setPullSizeUnit))
  const strength = useTools((s) => (push ? s.pushStrength : s.pullStrength))
  const setStrength = useTools((s) => (push ? s.setPushStrength : s.setPullStrength))

  return (
    <NavTool
      id={tool}
      label={label}
      icon={push ? <PushIcon /> : <PullIcon />}
      active={armed}
      // Arming one disarms the other, and nothing here enforces it: the store
      // holds ONE tool. Pressing the lit button puts it down and leaves the
      // hands empty, which is how you get a press on the clay to do nothing.
      onToggle={(on) => setLatheTool(on ? tool : null)}
      panelTitle={label}
    >
      <div className="tool-group">
        {/* Pinned to its own unit, as the modelling brushes' sizes are: this
            control SETS a length rather than reporting one, and `auto`
            renumbers the scale mid-drag. See `erodeSizeUnit`. */}
        <NumberField
          ownUnit={{ unit: sizeUnit, onChange: setSizeUnit }}
          label="Tool size"
          value={reach}
          min={BRUSH_RADIUS_MIN}
          max={BRUSH_RADIUS_MAX}
          step={0.01}
          resetTo={DEFAULT_LATHE_REACH}
          onChange={setReach}
          tip="How much of the wall the tool covers, up and down from where you hold it."
        />
        <NumberField
          label="Strength"
          value={strength}
          min={0.05}
          max={1}
          step={0.05}
          resetTo={DEFAULT_LATHE_STRENGTH}
          onChange={setStrength}
          tip="How fast the wall travels to the pointer. It never gets past it."
        />
      </div>
    </NavTool>
  )
}

/** Takes material away: the wall goes in, as far as the pointer and no further. */
export function PushTool() {
  return <PushPullTool tool="push" label="Push" />
}

/** Adds it: the same tool, the same numbers, the wall going the other way. */
export function PullTool() {
  return <PushPullTool tool="pull" label="Pull" />
}
