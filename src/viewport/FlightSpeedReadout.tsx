import { useEffect, useRef, useState } from 'react'
import { formatLength } from '../units'
import { flyingHere, useTools } from '../store/toolStore'

/**
 * How long the speed stays up after it was last changed.
 *
 * Long enough to read a number you were not looking at -- the hand is on the
 * wheel, and the eye is on the model -- and short enough that a run of notches
 * reads as one readout being revised rather than a label that has taken up
 * residence in the middle of the scene. It restarts on every change, so
 * spinning the wheel holds it open for the whole spin.
 */
const LINGER_MS = 1400

/**
 * What the camera's speed is, said out loud for a moment when it changes.
 *
 * IT EXISTS BECAUSE THE WHEEL STOPPED BEING VISIBLE. With game controls on the
 * wheel no longer moves the camera, it sets how fast the camera moves -- and
 * that is a change with no picture: the scene does not budge, so a user who
 * spins the wheel expecting to zoom sees nothing happen at all and concludes
 * the wheel is broken. One line saying "50.0 cm/s" turns a dead control into an
 * obvious one, and it is the whole of the feedback the gesture has.
 *
 * SHOWN ON A CHANGE rather than always, and that includes the change from not
 * being in this mode at all: switching Game Controls on flashes the speed once,
 * which is how anyone finds out there is a speed to set. A label parked
 * permanently over the scene would be chrome for a number that is right nearly
 * all of the time.
 *
 * TOP-MIDDLE. Every other overlay in this viewport has taken a corner or an
 * edge -- the island top-left, the compass top-right, the selection panel and
 * the drag hint along the bottom -- and the middle of the top edge is what is
 * left. It suits the thing anyway: this is momentary and it is about the
 * camera rather than about anything in the scene, so it belongs where the eye
 * already is rather than out where the controls live.
 *
 * IT IS NOT A CONTROL and takes no pointer events -- see `.flight-speed`. It
 * sits over the middle of the canvas, which is exactly where a model usually
 * is, and a readout that swallowed the click meant for the solid behind it
 * would be a worse bug than the one it was added to fix.
 */
export function FlightSpeedReadout() {
  const game = useTools(flyingHere)
  const speed = useTools((s) => s.flightSpeed)
  const unit = useTools((s) => s.displayUnit)
  const [shown, setShown] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    if (!game) return
    setShown(true)
    // Restarted rather than left to run: a second notch inside the linger
    // would otherwise be swallowed by the first one's countdown and the label
    // would vanish mid-spin.
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setShown(false), LINGER_MS)
    return () => clearTimeout(timer.current)
  }, [game, speed])

  if (!game) return null

  return (
    // A status rather than an alert: it reports a value that has changed and
    // asks nothing of anybody, so a screen reader should mention it when it is
    // free rather than interrupt for it.
    <div className={`flight-speed${shown ? ' flight-speed-shown' : ''}`} role="status">
      {/* Per SECOND, and the suffix says so, because the number on its own is a
          length and would read as one -- the same 50 cm this app writes on a
          ruler. Formatted through `formatLength` like every other length in the
          app, so the unit follows the one chosen in Settings. */}
      {formatLength(speed, unit)}/s
    </div>
  )
}
