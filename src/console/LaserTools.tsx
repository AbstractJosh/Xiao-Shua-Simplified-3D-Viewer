import { MAX_ROPE, useTools } from '../store/toolStore'
import { useCutDraft } from '../viewport/cutDraft'
import { useReference } from '../store/referenceStore'
import { NumberField } from './Field'
import { NavTool } from './NavTool'
import { FreehandIcon, MoveIcon, PointCutIcon } from './navIcons'
import { Tip } from './Tip'

/**
 * The Laser Cutter's tools: two ways of putting one line on one face, and the
 * one tool here that cuts nothing.
 *
 * Their own file rather than two more entries in `NavTools`, the same split
 * `LatheTools` makes and for the same reason: these exist because there is a
 * block on a bed, and neither means anything on a screen without one.
 *
 * THE TWO CUTTERS ARE ONE TOOL WEARING TWO GESTURES, which is worth saying
 * because the panels look alike. Everything after the line exists is shared --
 * how it is carried to the border, how it is swept into a kerf, what a cut
 * leaves behind, which piece of it goes, what Apply says when it misses. What
 * differs is entirely how the line gets there: a hand dragging it, or a series
 * of points placed and then adjusted. So each panel here holds only its own
 * gesture's dial, and the shared half is one panel over the scene.
 *
 * WHICH IS WHY APPLY IS NOT IN EITHER OF THESE. It was, and it could not stay:
 * an island panel closes on any pointerdown outside the island, and drawing a
 * cut is exactly that -- so the button that burns the line was shut by the act
 * of drawing the line. It lives in `CutPanel` now, in the bottom-left corner,
 * for as long as a cutter is in hand.
 *
 * MOVE STANDS FIRST ON THE ISLAND, and it is not one of that pair at all: it
 * burns nothing, it has no panel, and what it takes hold of is a REFERENCE
 * rather than the block. It leads because it is what a hand reaches for
 * between cuts -- the references go down before the lines that follow them --
 * and the island's rule stands under it. It is on this island and in the same
 * field as the cutters because it claims the same gesture they do -- see
 * `MoveRefTool` at the foot of the file for what it replaced.
 *
 * NONE OF THE THREE CARRIES A HOVER BUBBLE, which is the bargain Snap and Cut
 * already strike on the modelling island: these are the buttons a hand crosses
 * constantly on this screen -- there are only three of them and every one is
 * reached for over and over -- and a paragraph that appears every time the
 * pointer passes is noise rather than help. What each does is in Help, under
 * Reference images and Cutting the block, and the two that need saying while
 * you are working are said by the viewport's own hint instead, where they are
 * out of the way of the button.
 *
 * WHAT IS NOT HERE is the block itself. It is a corner panel standing open over
 * the bed -- see `BlockPanel` -- on the line the island already draws: these
 * are things you PICK UP, and the size of the stock is not.
 */

/**
 * The switch, in the app's own words for a yes-or-no.
 *
 * BOTH STATES NAMED rather than a lone tickbox, which is the idiom Outlines and
 * the hollow ends already use here: `On | Off` with one lit says what the
 * alternative IS, where an empty square leaves you to infer it. It also keeps
 * the panel one kind of control -- this row and the smoothing dial next door
 * read as two answers to the same shape of question rather than as a menu with
 * a gadget bolted on.
 */
const FIT_CHOICES = [
  {
    on: false,
    label: 'Off',
    title: 'Joins the points with straight segments. What you placed is what is cut.',
  },
  {
    on: true,
    label: 'On',
    title:
      'Runs a smooth curve through every point, with a handle on each to aim it. A handle you aim is kept; the rest go on being fitted.',
  },
] as const

const FIT_TIP =
  'Off, the points are joined with straight segments and what you placed is what is cut. On, a smooth curve runs through every one of them and each grows a handle you may aim -- the two ends of a handle stay opposite, so the line never kinks. The points survive the switch either way, and so does any handle you have already aimed.'

/**
 * Freehand: draw the cut with the pointer, on a rope.
 *
 * ONE DIAL, and it is the one thing this tool has that the other does not. The
 * stabiliser is a length of rope between the pointer and the tool -- see
 * `ropeFollow` -- so the dial is how much wobble is absorbed before the line
 * moves at all, rather than how hard a filter is applied afterwards. That
 * distinction is the whole reason the line on screen is the line that gets cut:
 * what is recorded is where the tool went, not where the hand went.
 */
export function FreehandTool() {
  const armed = useTools((s) => s.laserTool === 'freehand')
  const setLaserTool = useTools((s) => s.setLaserTool)
  const smoothing = useTools((s) => s.freehandSmoothing)
  const setSmoothing = useTools((s) => s.setFreehandSmoothing)

  return (
    <NavTool
      id="freehand"
      label="Freehand"
      icon={<FreehandIcon />}
      active={armed}
      // Taking one up puts the other down, and nothing here enforces it: the
      // store holds ONE tool. Pressing the lit button leaves the hands empty,
      // which is how you get a press on the block to turn nothing into a line.
      onToggle={(on) => setLaserTool(on ? 'freehand' : null)}
      panelTitle="Freehand"
    >
      <NumberField
        label="Smoothing"
        value={smoothing}
        min={0}
        max={1}
        step={0.05}
        onChange={setSmoothing}
        tip={`The line follows the pointer on a rope. At full it lags by an eighth of the block (${Math.round(
          MAX_ROPE * 1000
        ) / 10}% of the side), which takes a hand's tremor out; at zero it is exactly where you point.`}
      />
    </NavTool>
  )
}

/**
 * Point Cut: place the cut a point at a time, and decide afterwards whether the
 * line through them bends.
 *
 * IT IS A CHOICE ABOUT A LINE THAT ALREADY EXISTS, which is why it is a reading
 * of one set of points rather than a second tool. The points survive it, so
 * turning the curve on and off again loses nothing, and it does not jump when
 * thrown: an unaimed curve is exactly the fit through the points that were
 * already there. See `fittedHandles`.
 *
 * IT WAS THREE MODES AND IS NOW ONE SWITCH. Straight, Fit to line and Manual --
 * and the third was not a third way of joining points at all. Manual was the
 * fitted curve with its tangents handed over to be aimed, so it differed from
 * Fit by WHO OWNED THE HANDLES and not by what the line was. The cost of
 * bundling that into the mode was the trap this switch undoes: the one mode
 * named for hand-editing was the one you could not reach from a straight line,
 * so a user who wanted to nudge a point of a straight cut had to pick "Manual"
 * and watch their line bend.
 *
 * So the two questions are apart now. This says whether the line bends. Editing
 * by hand is not a mode either way -- points are dragged in both, and with the
 * curve on each point carries a handle. Aiming one keeps it; the rest go on
 * being fitted, which is a thing none of the three modes could say. See
 * `fitCurve` and `handles` in `cutDraft`.
 */
export function PointCutTool() {
  const armed = useTools((s) => s.laserTool === 'points')
  const setLaserTool = useTools((s) => s.setLaserTool)
  const fit = useTools((s) => s.fitCurve)
  const setFit = useTools((s) => s.setFitCurve)
  const points = useCutDraft((s) => s.points.length)

  return (
    <NavTool
      id="points"
      label="Point Cut"
      icon={<PointCutIcon />}
      active={armed}
      onToggle={(on) => setLaserTool(on ? 'points' : null)}
      panelTitle="Point Cut"
      // UNDER THE BUTTON rather than out beside it, which is what every other
      // panel on an island does. Point Cut is the last tool in the column, so
      // there is nothing below to cover -- the one reason island panels open
      // sideways at all -- and this is the deeper of the two cut panels: opened
      // across the scene it stands over the middle of the window, which is the
      // face the tool is about to be used on. See `below` in `NavTool`.
      below
    >
      <div className="field">
        <div className="field-head">
          <span className="field-label">Fit to line</span>
          <Tip>{FIT_TIP}</Tip>
        </div>
        <div className="seg curve-modes" role="group" aria-label="Fit to line">
          {FIT_CHOICES.map((choice) => (
            <button
              key={choice.label}
              type="button"
              className={`seg-btn${fit === choice.on ? ' seg-active' : ''}`}
              aria-pressed={fit === choice.on}
              title={choice.title}
              onClick={() => setFit(choice.on)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>

      {/* What the tool is waiting for, while it is waiting for it. Two points
          is the whole requirement and it is not obvious from an empty face --
          the modelling screen's own hint idiom, in the panel that is asking. */}
      {points < 2 && (
        <p className="empty">
          {points === 0 ? 'Click the face to place the first point.' : 'One more point.'}
        </p>
      )}

    </NavTool>
  )
}

/**
 * Move: the tool that takes hold of a reference rather than of the block.
 *
 * WHY A TOOL AND NOT A PADLOCK. Every decal used to wear one, and pressing it
 * pinned that picture so a cut could be drawn across it without shoving it out
 * of place. That is a per-picture switch for a question that was never about
 * one picture -- the honest question is "am I placing drawings, or cutting to
 * them?", and it has one answer at a time for the whole block. Asking it once,
 * as a tool, means three references need one press between them instead of
 * three, and there is no such thing as the reference you forgot to pin.
 *
 * IT IS IN THE SAME FIELD AS THE CUTTERS, so taking it up puts the cutter down
 * and vice versa -- see `LaserTool`. That is what makes the guarantee mutual:
 * with a cutter in hand no drawing can be shifted, and with this in hand no
 * face can be cut.
 *
 * NO PANEL, and it is the only tool on this island without one. There is
 * nothing to aim: the handles are on the pictures, and everything you can say
 * to it you say by dragging one. A caret over an empty panel would be the lid
 * with nothing under it.
 *
 * DIMMED WITH NOTHING ON THE BLOCK, rather than hidden. The button is what
 * tells you the gesture exists, and a tool that vanished until you had already
 * worked out how to place a reference would only ever be found by somebody who
 * no longer needed it.
 *
 * WHAT IT DOES NOT SAY IS WHICH PICTURE. The panel says that: a lit slot is the
 * drawing with handles on it, and this is the hand that moves it -- so a block
 * wearing three references wears one set of grips rather than three. See
 * `highlightId`. Taking up a cutter puts the light out along with the handles,
 * which is the same mutual guarantee written once more.
 */
export function MoveRefTool() {
  const armed = useTools((s) => s.laserTool === 'move')
  const setLaserTool = useTools((s) => s.setLaserTool)
  const placements = useReference((s) => s.placements)
  const activeId = useReference((s) => s.activePresetId)
  const onBlock = placements.some((p) => p.presetId === activeId)

  return (
    <NavTool
      label="Move"
      icon={<MoveIcon />}
      active={armed}
      disabled={!onBlock && !armed}
      onToggle={(on) => setLaserTool(on ? 'move' : null)}
    />
  )
}
