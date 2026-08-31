import { useEffect, useState } from 'react'
import { useLathe } from '../store/latheStore'
import { useTools } from '../store/toolStore'
import { sculptLine, sculptReady, useSculptDraft } from './sculptDraft'

/**
 * Apply and Reset for Point Sculpt: the panel that cuts the wall to the drawn
 * line, standing in the corner of the lathe for as long as the tool is in hand.
 *
 * WHY IT IS NOT IN THE TOOL'S OWN PANEL, which is where every other control on
 * this screen lives. An island panel closes on any pointerdown that is not
 * inside the island -- see the outside-press listener in `NavBar`, which is
 * what makes every flyout in the app dismiss by clicking away. Placing a point
 * is a pointerdown on the drawing. So the button that applies the line would be
 * shut by the very act of drawing the line: take up Point Sculpt, open the
 * panel, place a point, and the button you were about to press has gone.
 *
 * A TOOL YOU AIM BY DRAWING CANNOT KEEP ITS ACTIONS IN A FLYOUT. That is the
 * whole of the reasoning, and it is the same sentence `CutPanel` opens with,
 * because the Laser Cutter learned it first and the lesson was never about
 * blocks. It is about the gesture: a panel that has to outlive a press on the
 * canvas has to be chrome that stands on its own.
 *
 * BOTTOM LEFT, ABOVE THE STOCK PANEL, in the column the cutting bench already
 * uses. The two stack in the order they are used -- the lump set once at the
 * start, the profile cut over and over -- and it leaves the middle of the
 * window, where the piece is, completely clear.
 *
 * IT COMES AND GOES WITH THE TOOL. With a brush in hand or with empty hands
 * there is no line to apply and nothing here to say, so the corner goes back to
 * being the stock panel on its own.
 *
 * IT WEARS `.cut-panel` ON PURPOSE, laser-sounding name and all, and that is
 * load-bearing rather than lazy. `NavBar` keeps a list of the places a press
 * does NOT dismiss an open flyout -- the bar, the island, the help card, and
 * that class -- so sharing it is what stops a press on Apply shutting the
 * tool's own caret behind it. Two classes would mean two entries on that list,
 * and the day somebody added a third panel with a fresh name it would be the
 * one that quietly closed the flyout. The surface is genuinely the same one:
 * see the rule in `styles.css`, which already described it as one shelf.
 */

/** How long a refused press stays on screen before clearing itself. The cut's
 *  own, so a refusal reads the same wherever it is fired. */
const RECEIPT_MS = 8000

export function SculptPanel() {
  const tool = useTools((s) => s.latheTool)
  const fit = useTools((s) => s.sculptFit)

  const points = useSculptDraft((s) => s.points)
  const handles = useSculptDraft((s) => s.handles)
  const clear = useSculptDraft((s) => s.clear)

  /**
   * The one outcome the drawing cannot show by itself.
   *
   * A press that works needs no receipt: the wall moves, the line is thrown
   * away, and the piece under it is the whole report. What needs saying is the
   * press where NOTHING happened -- a line drawn exactly where the wall already
   * stands, or one placed entirely off the piece -- because the screen looks
   * identical either way and the button looks broken.
   *
   * Keyed to the drawing, so a refusal about one line goes the moment the line
   * changes rather than sitting over a shape the user has since moved. Same
   * arrangement as `CutPanel`, and for the same reason.
   */
  const [status, setStatus] = useState<{ text: string; key: string } | null>(null)

  const drawnKey = `${points.length}|${handles.filter((h) => h !== null).length}|${fit}`
  const showing = status !== null && status.key === drawnKey

  useEffect(() => {
    if (!showing) return
    const timer = setTimeout(() => setStatus(null), RECEIPT_MS)
    return () => clearTimeout(timer)
  }, [showing, status])

  const fire = () => {
    const drafted = useSculptDraft.getState()
    const line = sculptLine(drafted, useTools.getState().sculptFit)
    const before = useLathe.getState().clay
    useLathe.getState().applySculpt(line)
    if (useLathe.getState().clay === before) {
      // The wall did not move, so the drawing is KEPT: it is the thing that
      // needs adjusting, and throwing it away would make the user redraw it to
      // find out what was wrong with it.
      setStatus({
        text: 'The line leaves the wall where it already stands',
        key: drawnKey,
      })
      return
    }
    // On a hit the drawing goes: the wall IS the line now, and one left lying
    // over the profile it already cut reads as still pending.
    clear()
  }

  // The three brushes are in the same field as this tool -- taking one up puts
  // this one down -- so the tool is named rather than tested for "something in
  // hand": with Push held there is no line and nothing to apply.
  if (tool !== 'points') return null

  const ready = sculptReady({ points, handles }, fit)

  /**
   * The one line of prose in the corner, and what it says depends on how far
   * along the drawing is.
   *
   * Two points is the whole requirement and an untouched lump gives no clue
   * that placing one is even the gesture, so while there is no line the panel
   * that is asking says what it is asking for. Once there IS a line the thing
   * worth saying is where the handles went: they are on the newest point alone
   * -- see `selected` in `sculptDraft` -- and somebody who aimed a tangent
   * three points ago has no way of guessing that pressing its knot brings the
   * grips back. Nothing to say at all with the curve off, where there are no
   * tangents to find.
   *
   * ALWAYS EXACTLY ONE LINE OR NONE, so the panel does not change height under
   * the buttons as the drawing grows.
   */
  const hint =
    points.length === 0
      ? 'Click beside the piece to place a point.'
      : points.length === 1
        ? 'One more point.'
        : fit
          ? 'Handles follow the newest point. Click another to adjust it.'
          : null

  return (
    <div className="cut-panel">
      {/* Named the way the panel below it is named, because the two are one
          shelf: the lump, and the profile you are cutting into it. */}
      <div className="stock-head">The profile</div>

      <div className="tool-group cut-actions">
        <button
          type="button"
          className="nav-action nav-action-primary"
          disabled={!ready}
          onClick={fire}
        >
          Apply profile
        </button>
        <button
          type="button"
          className="nav-action"
          disabled={points.length === 0}
          onClick={clear}
        >
          Reset line
        </button>

        {hint && (
          <p className="cut-status" role="status">
            {hint}
          </p>
        )}

        {showing && status && (
          <p className="cut-status cut-status-bad" role="status">
            {status.text}
          </p>
        )}
      </div>
    </div>
  )
}
