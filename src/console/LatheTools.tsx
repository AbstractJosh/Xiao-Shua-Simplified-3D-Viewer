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
import { PullIcon, PushIcon, SmoothIcon } from './navIcons'

/**
 * The Lathe screen's three tools: the pair that shapes the piece, and the one
 * that tidies up after them.
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
 * WHAT IS NOT HERE is the stock the piece is turned from. It was a `NavTool`,
 * in the bar, and it is now a panel standing open in the corner of the viewport
 * -- see `StockPanel`. The line is the one the island already draws: these are
 * things you PICK UP, and the size of the lump is not.
 *
 * AND A RULE UNDER THE PAIR. Push and Pull sit above it and everything else
 * below, because those two are the ones that MOVE MATERIAL -- one behaviour
 * with a sign in front of it, the whole of what shaping a piece is. Smooth
 * neither adds nor takes away: it fairs what the pair left, which is why it
 * reads as the thing you reach for after them rather than as a third of them.
 * Hollow, below it, is not aimed at all. See `LatheViewport`, which lays them
 * out.
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
const ICONS = {
  push: <PushIcon />,
  pull: <PullIcon />,
  smooth: <SmoothIcon />,
}

/** What each dial does, in the tool's own terms. The size means the same thing
 *  three times over; the strength does not, so it says so three times. */
const STRENGTH_TIP = {
  push: 'How fast the wall travels to the pointer. It never gets past it.',
  pull: 'How fast the wall travels to the pointer. It never gets past it.',
  smooth: 'How fast the wobble comes out. Hold longer for a fairer curve.',
}

const SIZE_TIP = {
  push: 'How much of the wall the tool covers, up and down from where you hold it.',
  pull: 'How much of the wall the tool covers, up and down from where you hold it.',
  smooth: 'How much of the wall the rib fairs at once, up and down from where you hold it.',
}

function PushPullTool({ tool, label }: { tool: NonNullable<LatheTool>; label: string }) {
  const armed = useTools((s) => s.latheTool === tool)
  const setLatheTool = useTools((s) => s.setLatheTool)

  // Each tool keeps its own pair -- see `pushReach` in the tool store for why
  // sharing them would have the user re-dialling one size all session. Picked
  // by name rather than by a chain of ternaries, which is what the third tool
  // turned the old pair of them into.
  const reach = useTools((s) =>
    tool === 'push' ? s.pushReach : tool === 'pull' ? s.pullReach : s.smoothReach
  )
  const setReach = useTools((s) =>
    tool === 'push' ? s.setPushReach : tool === 'pull' ? s.setPullReach : s.setSmoothReach
  )
  const sizeUnit = useTools((s) =>
    tool === 'push' ? s.pushSizeUnit : tool === 'pull' ? s.pullSizeUnit : s.smoothSizeUnit
  )
  const setSizeUnit = useTools((s) =>
    tool === 'push'
      ? s.setPushSizeUnit
      : tool === 'pull'
        ? s.setPullSizeUnit
        : s.setSmoothSizeUnit
  )
  const strength = useTools((s) =>
    tool === 'push' ? s.pushStrength : tool === 'pull' ? s.pullStrength : s.smoothStrength
  )
  const setStrength = useTools((s) =>
    tool === 'push'
      ? s.setPushStrength
      : tool === 'pull'
        ? s.setPullStrength
        : s.setSmoothStrength
  )

  return (
    <NavTool
      id={tool}
      label={label}
      icon={ICONS[tool]}
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
          resetTo={tool === 'smooth' ? DEFAULT_LATHE_REACH * 1.5 : DEFAULT_LATHE_REACH}
          onChange={setReach}
          tip={SIZE_TIP[tool]}
        />
        <NumberField
          label="Strength"
          value={strength}
          min={0.05}
          max={1}
          step={0.05}
          resetTo={DEFAULT_LATHE_STRENGTH}
          onChange={setStrength}
          tip={STRENGTH_TIP[tool]}
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

/**
 * Takes neither away nor adds: the rib, which fairs what the other two left.
 *
 * The same button and the same two dials, because from the hand's point of view
 * it IS the same tool -- take it up, hold it against the wall, watch the clay
 * come to it. What is different is what it is aiming at, and the answer is
 * nothing: only the height it is held at matters, and how far from the axis you
 * hold it changes nothing at all. That is worth knowing and it is in the tip
 * rather than in a control, because there is no control to put it in.
 *
 * A THIRD TOOL AT ALL, on a screen whose whole argument was that it is the easy
 * one with two: it is the second half of the two that are already here. Every
 * dab relaxes the window it moved -- see `RELAX` -- so this is that pass with
 * the displacement taken off, which is a branch in `mold` rather than a
 * pipeline. And it is the tool the other two make necessary: a wall worked hard
 * with a narrow push carries the marks of it, and the way to take them out was
 * to push and pull the same stretch until it happened to come fair.
 */
export function SmoothTool() {
  return <PushPullTool tool="smooth" label="Smooth" />
}
