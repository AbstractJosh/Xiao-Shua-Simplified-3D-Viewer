import { useEffect, useState } from 'react'
import { useLaser } from '../store/laserStore'
import { mirrorOn, useTools } from '../store/toolStore'
import { draftCut, draftReady, useCutDraft } from './cutDraft'

/**
 * Apply, Reset, and what happened: the panel that burns the line, standing in
 * the bottom-left corner of the laser cutter for as long as a cutter is in
 * hand.
 *
 * WHY IT IS NOT IN THE TOOL'S OWN PANEL ANY MORE, which is where it lived and
 * where it looks like it belongs. An island panel closes on any pointerdown
 * that is not inside the island -- see the outside-press listener in `NavBar`,
 * which is what makes every flyout in the app dismiss by clicking away. Drawing
 * a cut is a pointerdown on the canvas. So the button that applies the line was
 * shut by the very act of drawing the line: take up Freehand, open the panel,
 * draw, and the panel you were about to press has gone. You had to re-open it
 * every single time, and nothing on screen said why it kept vanishing.
 *
 * A TOOL YOU AIM BY DRAWING CANNOT KEEP ITS ACTIONS IN A FLYOUT. That is the
 * whole of the reasoning, and it is about the gesture rather than about these
 * two buttons: the panel has to outlive the stroke, so it has to be chrome that
 * stands on its own rather than something hanging off a button.
 *
 * BOTTOM LEFT, above the block. That corner is already this screen's shelf for
 * "facts about the job rather than the scene" -- the stock is there, and the
 * two stack in the order they are used, the block set once at the start and the
 * cut fired over and over. It is also the corner furthest from the compass and
 * the copy button, and it leaves the middle of the window, where the face being
 * drawn on is, completely clear. See `.laser-corner`.
 *
 * IT COMES AND GOES WITH THE TOOL, which is what makes it a popup rather than a
 * fourth permanent panel. With empty hands there is no line to apply and
 * nothing here to say, so the corner goes back to being scene.
 *
 * ONE PANEL FOR BOTH CUTTERS, because the act is identical: whatever drew the
 * line, the line is a line and burning it is one call. Two copies would be two
 * receipts that drifted apart, and the receipt is the part that matters most --
 * a cut that missed looks exactly like a broken button unless the tool says so
 * out loud, which is the lesson `CutActions` already learned next door.
 *
 * THE OFFCUT ROW IS PART OF THE SAME STORY and appears only after a cut that
 * left something to decide about. Delete does the discarding from the keyboard
 * -- see `LaserViewport` -- and both are here rather than one being here: the
 * key is what a hand already on the model reaches for, and the button is what
 * somebody who has never pressed Delete in this app can find.
 *
 * IT IS TWO PRESSES, WHICH PIECE AND THEN THROW IT AWAY, because the cut no
 * longer decides which piece was waste. It still GUESSES -- the smallest, which
 * is right for most cuts -- but a cut that frees the part you want from the
 * stock around it makes the keeper the small one, and the screen would then be
 * lighting the piece you came for and offering to bin it. See `choices` in
 * `laserStore` for what may be stepped between, and `PIECES` in `LaserViewport`
 * for the click that says it directly.
 */

/** How long a refused cut stays on screen before clearing itself. The modelling
 *  cut's own, so a refusal reads the same wherever it is fired. */
const RECEIPT_MS = 8000

export function CutPanel() {
  const tool = useTools((s) => s.laserTool)
  const fit = useTools((s) => s.fitCurve)

  const face = useCutDraft((s) => s.face)
  const stroke = useCutDraft((s) => s.stroke)
  const points = useCutDraft((s) => s.points)
  const handles = useCutDraft((s) => s.handles)
  const closed = useCutDraft((s) => s.closed)
  const clear = useCutDraft((s) => s.clear)

  const offcut = useLaser((s) => s.offcut)
  const choices = useLaser((s) => s.choices)
  /* The mirror on the face being drawn on, or null. What decides whether Apply
     burns one line or four, and whether an empty result means the line missed
     the block or was clipped away by the axis. */
  const mirror = useTools(face ? mirrorOn(face) : () => null)
  const nextOffcut = useLaser((s) => s.nextOffcut)
  const discardOffcut = useLaser((s) => s.discardOffcut)

  /**
   * WHY A CUT THAT WORKED SAYS NOTHING. It used to report "Cut 1 piece in two",
   * and a receipt for the thing that plainly just happened is noise: the block
   * comes apart on screen, the kerf opens as a hairline, and one of the pieces
   * lights up as the offcut. Three things already say it, and the line of text
   * arrived under the button the eye had just left. What is left here is the
   * case the scene CANNOT show -- a line that missed, where nothing moves and
   * the button looks broken.
   *
   * So the status is always a refusal now, and there is no flag for which kind
   * it is. `cut-status-bad` is worn unconditionally rather than kept as a
   * boolean that only ever holds one value.
   *
   * THE KEY IS STILL PART OF IT. A refusal describes one line in one place, so
   * it has to go the moment the drawing changes rather than sit over a line the
   * user has since moved.
   */
  const [status, setStatus] = useState<{ text: string; key: string } | null>(null)

  // `closed` is part of the key because bridging the loop is a change to the
  // line, and a refusal describes one line: "does not cross the block" is
  // exactly the message a loop drawn clear of the block has just fixed or
  // earned, and it must not be left standing over the other one.
  const drawnKey = `${stroke.length}|${points.length}|${closed}|${fit}`
  const showing = status !== null && status.key === drawnKey

  // And it goes on its own even if nothing is drawn after it: it stands over
  // the bed the line was aimed at.
  useEffect(() => {
    if (!showing) return
    const timer = setTimeout(() => setStatus(null), RECEIPT_MS)
    return () => clearTimeout(timer)
  }, [showing, status])

  /** The key the drawing has RIGHT NOW, read back from the store rather than
   *  taken from this render's `drawnKey`. The two agree on the path that uses
   *  it -- a miss changes nothing -- and reading it back is what keeps that
   *  true if the refusal ever starts touching the draft. */
  const keyNow = () => {
    const d = useCutDraft.getState()
    return `${d.stroke.length}|${d.points.length}|${d.closed}|${useTools.getState().fitCurve}`
  }

  const fire = () => {
    const drafted = useCutDraft.getState()
    if (drafted.face === null) return
    // WHAT THE MIRROR MAKES OF THE DRAWING, not the drawing: with an axis
    // standing this is two lines or four, and they are handed to the cut
    // together so that the whole symmetrical act is one step of history. The
    // preview came through the very same call -- see `draftCut` -- so what
    // burns is what was on screen.
    const mirror = mirrorOn(drafted.face)(useTools.getState())
    const lines = draftCut(drafted, useTools.getState().fitCurve, mirror)
    const split = useLaser.getState().cut(lines, drafted.face, mirror)
    if (split === 0) {
      // The line missed, so the drawing is KEPT: it is the thing that needs
      // moving, and throwing it away would make the user redraw it to find out
      // what was wrong with it. This is the one outcome the scene cannot show
      // by itself -- nothing moved -- so it is the one that says anything.
      //
      // A MIRROR GIVES THE REFUSAL A SECOND THING TO SAY, and they are worth
      // telling apart: a line drawn wholly in a dimmed part of the face has not
      // missed the block at all, it has been clipped away to nothing, and being
      // told it "does not cross the block" would send the user off measuring
      // the wrong thing.
      setStatus({
        text:
          lines.length === 0 && mirror
            ? 'Draw in the lit part of the face'
            : 'The line does not cross the block',
        key: keyNow(),
      })
      return
    }
    // On a hit the drawing goes: the line has been burned, and one left lying
    // over the cut it already made reads as still pending. Nothing is said --
    // the block coming apart says it -- and clearing the draft moves the key on
    // from any refusal still standing, so the last miss goes with it.
    clear()
  }

  // MOVE IS NOT A CUTTER. It is in the same field as the two that are -- taking
  // it up puts a cutter down -- so it has to be named rather than tested for
  // "something in hand": with Move held there is no line and nothing to apply.
  if (tool !== 'freehand' && tool !== 'points') return null

  const draft = {
    kind: tool === 'freehand' ? ('freehand' as const) : ('points' as const),
    stroke,
    points,
    handles,
    closed,
  }
  const ready = face !== null && draftReady(draft, fit, mirror)

  return (
    <div className="cut-panel">
      {/* Named the way its neighbour below is named, because the two are one
          shelf: the block, and the cut you are taking out of it. */}
      <div className="stock-head">The cut</div>

      <div className="tool-group cut-actions">
        <button
          type="button"
          className="nav-action nav-action-primary"
          disabled={!ready}
          title="Burns the line all the way through the block."
          onClick={fire}
        >
          Apply cut
        </button>
        <button
          type="button"
          className="nav-action"
          disabled={!ready}
          title="Throw the drawing away and start the line again."
          onClick={clear}
        >
          Reset line
        </button>

        {/* WHICH PIECE, AND THEN THROW IT AWAY -- in that order, because that
            is the order the decision is made in.

            Only after a cut that left something to decide about. The highlight
            over the scene is the thing this pair is about, and somebody looking
            at a lit piece wants to know what to do about it without crossing
            the window -- which is why the press says which key does the same.

            THE STEP IS HERE BECAUSE THE CLICK CANNOT ALWAYS BE. Clicking the
            piece you want gone is the direct way to say it and is the one worth
            reaching for, but a press on the block DRAWS while a cutter is in
            hand, so it is only open with the tool put down. This button is open
            for as long as the tool is, which is exactly when the click is not.
            See `nextOffcut`.

            It goes when there is nothing to step between, rather than sitting
            there dimmed: a cut that came apart in one place makes two pieces
            and two is worth stepping, and a piece that was merely passed by is
            not part of the offer at all. */}
        {choices.length > 1 && (
          <button
            type="button"
            className="nav-action"
            title="Lights the next piece this cut made. Clicking a piece does the same, with no tool in hand."
            onClick={nextOffcut}
          >
            Other piece
          </button>
        )}

        {offcut.length > 0 && (
          <button
            type="button"
            className="nav-action"
            title="Delete does the same, with the pointer anywhere over the bed."
            onClick={discardOffcut}
          >
            {/* Named for how many it takes, because under a mirror it takes
                every image of the piece at once and a button reading "Discard
                piece" would be understating what one press does. */}
            {offcut.length > 1 ? 'Discard pieces' : 'Discard piece'}
          </button>
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
