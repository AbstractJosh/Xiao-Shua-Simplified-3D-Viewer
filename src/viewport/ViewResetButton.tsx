import { useTools } from '../store/toolStore'

/**
 * Put the lathe's view back: the zoom the screen opens at, over the middle of
 * the lathe.
 *
 * IT IS THE THIRD RESET IN THIS CORNER and it is deliberately at the top of
 * them, because the three undo three different kinds of thing and only one of
 * them throws work away. This one costs nothing -- a view is not a piece --
 * `Reset line` costs the points you have placed, and `Reset` under the lump
 * costs the shaping, which on a screen with no undo is the most expensive
 * button in the app. Stacking them cheapest-first means the hand reaching for
 * "put it back" meets the harmless one on the way.
 *
 * WHY IT IS NEEDED AT ALL, given the zoom control has a Fit a corner away. Fit
 * answers "show me the piece"; this answers "show me what I started with". They
 * part company the moment the view can be slid: a piece dragged off the edge at
 * 1600% is found by either, but somebody who has spent a minute wheeling and
 * dragging and no longer trusts what they are looking at wants the view they
 * know, not the best view of what happens to be there.
 *
 * A BUTTON WEARING ITS OWN PANEL, rather than a row inside one of the two
 * below. It belongs to neither: the profile panel is Point Sculpt's and comes
 * and goes with the tool, and the lump panel is the stock, which a view has
 * nothing to do with. Standing on its own it is also always there, which the
 * profile panel is not.
 *
 * DEAD WHEN THE VIEW IS ALREADY AT REST, which is the rule both its neighbours
 * follow and the zoom control follows too -- see `ZoomControl` and
 * `stock-fresh`. A control that appears the first time you need it is one
 * nobody knows is there for the one press they will want it for.
 */
export function ViewResetButton() {
  const zoom = useTools((s) => s.latheZoom)
  const pan = useTools((s) => s.lathePan)
  const resetLatheView = useTools((s) => s.resetLatheView)

  const atRest = zoom === 1 && pan.x === 0 && pan.y === 0

  return (
    <div className="view-reset">
      <button
        type="button"
        className="btn view-reset-btn"
        disabled={atRest}
        onClick={resetLatheView}
        title={
          atRest
            ? 'The view is already where it started'
            : 'Back to 100%, over the middle of the lathe'
        }
      >
        Reset camera
      </button>
    </div>
  )
}
