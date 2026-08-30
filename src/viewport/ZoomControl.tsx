import { fitZoom, ZOOM_MAX, ZOOM_MIN } from './latheView'
import { useLathe } from '../store/latheStore'
import { useTools } from '../store/toolStore'

/**
 * How far the view is zoomed, and the three ways to change it.
 *
 * IT EXISTS BECAUSE THE VIEW STOPPED MOVING ON ITS OWN. The lathe's frame used
 * to fit itself to the stock, which meant it was never wrong about how much of
 * the piece you could see and never right about anything else -- it undid the
 * growth the Height field was asking for, and it rescaled the whole picture
 * mid-drag to do it. Taking that out leaves one thing owing: a lump bigger than
 * the frame now runs off the edge of it, so there has to be a way to go and
 * look. This is that way, and it is the only thing on this screen that moves the
 * view.
 *
 * FIT IS THE ONE THAT MATTERS and the other two are for the last inch. Somebody
 * who has just typed a 40 cm lump into a frame drawn for 24 does not want to
 * count wheel notches; they want the piece on the screen, which is one press.
 * It is placed between the two steppers rather than off to one side because
 * that is where the hand already is once it has pressed either of them and found
 * the answer still off screen.
 *
 * IT IS DEAD RATHER THAN HIDDEN when the piece already fits, which is the rule
 * the stock panel's `Reset` follows a corner away and for the same reason: a control
 * that appears the first time you need it is one nobody knows is there for the
 * one press they will want it for. Dead, it is a label saying "this is where
 * that lives".
 *
 * BOTTOM-RIGHT, stacked over the readout, because the readout is the other
 * thing in this corner that says how big something is -- one line for the piece,
 * one for the view. It is the corner an editor keeps for exactly this.
 */

/** What one press of the steppers is worth. The square root of two, so two
 *  presses is a clean halving or doubling and a single one is still a visible
 *  change rather than a nudge. */
const STEP = Math.SQRT2

/** How far the zoom has to be off the fitted one before Fit is worth offering.
 *  Inside this the button would move the picture by less than the press is
 *  worth, and a control that does nothing visible reads as a broken one. */
const FIT_SLOP = 0.02

export function ZoomControl() {
  const clay = useLathe((s) => s.clay)
  const zoom = useTools((s) => s.latheZoom)
  const zoomLathe = useTools((s) => s.zoomLathe)
  const setLatheZoom = useTools((s) => s.setLatheZoom)

  const fitted = fitZoom(clay)
  // Compared as a RATIO rather than a difference, because zoom is geometric:
  // a hundredth apart means something quite different at 4% and at 6400%.
  const fits = Math.abs(fitted / zoom - 1) < FIT_SLOP

  return (
    <div className="lathe-zoom" role="group" aria-label="Zoom">
      <button
        type="button"
        className="btn lathe-zoom-step"
        onClick={() => zoomLathe(1 / STEP)}
        disabled={zoom <= ZOOM_MIN}
        title="Zoom out"
        aria-label="Zoom out"
      >
        &minus;
      </button>
      {/* The number and the fit, in one control. Reading it and correcting it
          are the same act, so they are the same button: it says where the view
          is, and pressing it puts the view where the piece is. */}
      <button
        type="button"
        className="btn lathe-zoom-fit"
        onClick={() => setLatheZoom(fitted)}
        disabled={fits}
        title={fits ? 'The piece already fits the frame' : 'Fit the piece to the frame'}
      >
        {formatZoom(zoom)}
      </button>
      <button
        type="button"
        className="btn lathe-zoom-step"
        onClick={() => zoomLathe(STEP)}
        disabled={zoom >= ZOOM_MAX}
        title="Zoom in"
        aria-label="Zoom in"
      >
        +
      </button>
    </div>
  )
}

/**
 * The zoom as a percentage, at a precision that suits how far out it is.
 *
 * Whole percents while there is a whole percent to show, and a decimal below
 * ten, because the far end of the range is under two percent -- rounded to
 * whole numbers, three of the wheel's own steps down there would all read "2%"
 * and the readout would look stuck to somebody who had just moved the view.
 */
function formatZoom(zoom: number): string {
  const pct = zoom * 100
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`
}
