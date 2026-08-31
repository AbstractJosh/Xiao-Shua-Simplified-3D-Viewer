import { create } from 'zustand'
import { Euler, Vector3 } from 'three'
import type { ClayTool } from '../geometry/clay'
import { BRUSH_SMOOTH_MIN, ROUND_MIN } from '../geometry/erode'
import { DEFAULT_SNAP_DISTANCE } from '../geometry/snap'
import { DEFAULT_LASER_SNAP, LASER_SNAP_MAX, LASER_SNAP_MIN } from '../viewport/pointSnap'
import { fromDisplay } from '../units'
import { DEFAULT_HELP_SECTION } from '../helpTopics'
import type { HelpSectionId } from '../helpTopics'
import { DEFAULT_SCREEN, SCREEN_HAS_DOCUMENT, SCREEN_SNAPS } from '../screens'
import type { ScreenId } from '../screens'
import { DEFAULT_THEME } from '../theme'
import type { Theme } from '../theme'
import { clampZoom } from '../viewport/latheView'
import type { Unit, UnitMode } from '../units'
import type { Axis } from '../geometry/dimensions'
import type { Vec3 } from '../geometry/types'

/**
 * Tool state is deliberately OUTSIDE the doc. Snapping and the cut gizmo are
 * how you are working, not what you have built, so toggling snap or nudging the
 * cut plane must never land in undo history -- otherwise a user hunting for the
 * edit they want to reverse has to walk back through their own tool fiddling.
 */

/**
 * Which tool panel is open, if any.
 *
 * Chrome rather than geometry, but it lives here so the tools stay a pure
 * function of store state and a headless render can drive them exactly the way
 * a click does. One field for all of them although they now hang off two
 * containers -- the island over the scene and the bar across the top -- because
 * the rule has not changed: they overlap the same viewport, so one at a time.
 * The cut plane's NUMBERS are still not one of these, and for the reason they
 * never were: they are in the console, because a popover hanging off the
 * toolbar covered the only thing a plane can be aimed against. What `cut` holds
 * is the two ACTIONS -- fire it, or put the blade back -- which describe no
 * part of the scene and so cover nothing worth seeing. See `CutActions`.
 */
export type NavPanel =
  | 'snap'
  | 'settings'
  | 'ruler'
  | 'cut'
  | 'export'
  | 'erode'
  | 'sculpt'
  // The Smoother's, and NOT `smooth`: that is the Lathe's rib, on a different
  // screen with a different panel behind it. One id for two panels would have
  // opened whichever happened to be mounted.
  | 'smoother'
  | 'help'
  // The Lathe screen's two tools. One field still, and still for the same
  // reason -- a panel is a panel wherever its button is, and two of them open
  // at once would overlap whichever viewport is up. The lathe's STOCK is not in
  // here: it is a corner panel standing open over the piece rather than a lid
  // on a button, so it has nothing to take turns with. See `StockPanel`.
  | 'push'
  | 'pull'
  | 'smooth'
  // Not a tool that is aimed, and the only lid on this island that is not: it
  // is a setting for the whole piece with a panel to hold it. See `HollowTool`.
  | 'hollow'
  // The Laser Cutter's two, which are the same tool wearing two ways of putting
  // a line on a face. See `LaserTools`.
  | 'freehand'
  | 'points'
  | null

/**
 * The panels that hang off buttons INSIDE the tool island, which go off screen
 * with it when it is collapsed.
 *
 * It is the CONTAINER that decides which rather than the screen: the ruler
 * list, the three modelling brushes' numbers and the two lathe tools' are the
 * panels that hang off buttons over a viewport. Only one island is ever
 * mounted, so the modelling four and the lathe two can share this list
 * without ever being on screen together. The unit selector went to the bar
 * first and `snap` followed it, and neither collapses with anything now -- the
 * bar is always there. (The units menu has since become one group inside
 * `settings`, which is a bar panel too, and so is `clay`.)
 *
 * A panel left off this list is one the island cannot shut: its button goes off
 * screen with the body and `openPanel` still names it, so the panel springs
 * back open the next time the island does, from a click nobody made. That is
 * exactly what the erode panel did between arriving in the island and being
 * added here.
 */
export const ISLAND_PANELS: NavPanel[] = [
  'ruler',
  'cut',
  'erode',
  'sculpt',
  'smoother',
  'push',
  'pull',
  'smooth',
  'hollow',
  'freehand',
  'points',
]

/** Every bound in this file is applied with it, so a value written by a panel
 *  and one dragged by a gizmo cannot disagree about the limit. */
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/** Position + Euler XYZ rotation of the cut gizmo, and its visual extent. */
export type CutPlaneState = { position: Vec3; rotation: Vec3; size: number }

/**
 * Which way the cut plane faces, in world space.
 *
 * It lives with the state rather than with either consumer because the gizmo
 * that draws the plane and the panel that fires the cut have to agree to the
 * last bit: the quad is a plane turned so its face normal is local +Y, read
 * through Euler XYZ. Derive it any other way -- a different Euler order, or the
 * unturned +Z of a raw PlaneGeometry -- and the cut lands on a plane nobody
 * ever saw on screen, with nothing to explain the discrepancy.
 */
export function cutPlaneNormal([rx, ry, rz]: Vec3): Vector3 {
  return new Vector3(0, 1, 0).applyEuler(new Euler(rx, ry, rz, 'XYZ'))
}

/**
 * The least flow a dab may have. Re-exported rather than redefined: the reason
 * for it is geometry -- see the note in `erode.ts` -- and the panel and the
 * brush must not be able to disagree about where the control bottoms out.
 */
export { BRUSH_SMOOTH_MIN }

/**
 * The tightest round the Smoother will make, as a share of its brush.
 * Re-exported rather than redefined for the reason BRUSH_SMOOTH_MIN is: the
 * reason for it is geometry -- see the note in `erode.ts` -- and the panel and
 * the brush must not be able to disagree about where the control bottoms out.
 */
export { ROUND_MIN }

/**
 * Which brush is in the user's hand, if any.
 *
 * ONE FIELD RATHER THAN THREE SWITCHES, and that is not a tidiness argument.
 * The blowtorch, the Smoother and the sculpt tool all claim the same gesture --
 * a plain left press on a solid, dragged -- so "two armed" is not a state any
 * of them could act on; one would silently win, decided by whichever branch a
 * press happened to reach first. Held as a mode, the question cannot be asked:
 * arming one is choosing against the others, and no code has to enforce it. It
 * is the bargain `transformMode` already strikes for the three gizmos.
 *
 * The other tools stay independent booleans, because they genuinely are: a
 * ruler and an armed cut plane both being up is a scene with a measurement and
 * a blade in it, and neither takes the press off a solid.
 */
export type StrokeBrush = 'torch' | 'sculpt' | 'smoother'
export type BrushTool = StrokeBrush | null

/**
 * Which tool is against the piece, if either. The Lathe screen's whole toolset.
 *
 * ONE FIELD, for the reason `BrushTool` is one: push and pull claim the same
 * gesture -- a left press on the clay, held -- so "both armed" is a state
 * neither could act on. Arming one is choosing against the other, and nothing
 * has to enforce it.
 *
 * A SEPARATE field from `BrushTool` rather than two more values on it, though
 * the two pairs are cousins. They are aimed at different things on different
 * screens: `brushTool` is pointed at a solid in a document Lathe does not
 * draw, and this is pointed at a lump of clay the modelling screen has never
 * heard of. Folding them together would let a screen arm a tool that its own
 * viewport cannot use, and every reader of either field would have to ask which
 * screen it was on before trusting it.
 */
/**
 * The three that shape the wall, plus empty hands.
 *
 * `ClayTool` in `clay.ts` is this without the null: the geometry has no notion
 * of putting a tool down, and this store has no notion of what a dab does.
 */
export type LatheTool = ClayTool | null

/**
 * Which tool is in hand on the Laser Cutter, if any.
 *
 * ONE FIELD, and a separate one from `latheTool` and `brushTool`, for the two
 * reasons those are separate from each other: they all claim the same gesture
 * -- a left press on the block -- so "both armed" is a state neither could act
 * on, and they are pointed at a block the other two screens have never heard
 * of. See `LatheTool`, which sets out the whole argument.
 *
 * TWO OF THEM CUT AND ONE DOES NOT, which is the odd one out and worth saying
 * why. `move` puts no line on the block at all: it is the tool that takes hold
 * of a REFERENCE, to slide it about its face or pull a corner. It is in this
 * field rather than in a flag of its own because it claims the same left press
 * the cutters do -- a press on a picture cannot both start a line and pick the
 * picture up, and one field is the only way to say that once. It is also what
 * replaced the padlock: a reference used to be pinned so a cut could be drawn
 * across it, and a tool you have to be HOLDING to move anything makes the pin
 * redundant -- with a cutter in hand nothing on the face can be shifted, which
 * is what the padlock was for.
 *
 * EMPTY-HANDED ON ARRIVAL, unlike the lathe, and the difference is what a press
 * costs. On the lathe a press with a tool in hand moves some clay and the next
 * press moves it back, so arriving armed saves everyone a click. Here a press
 * starts a line that has to be finished, aimed and applied; arriving armed
 * would mean the first press meant to turn the compass left a stroke on the
 * face instead.
 */
export type LaserTool = 'freehand' | 'points' | 'move' | null

/** The two that draw a line. `move` is the third, and it draws nothing. */
export const isCutTool = (tool: LaserTool): tool is 'freehand' | 'points' =>
  tool === 'freehand' || tool === 'points'

/* HOW A POINT CUT'S POINTS ARE JOINED UP was three named modes here --
   Straight, Fit to line, Manual -- and it is one switch now: `fitCurve`. See
   it below for why, and `cutDraft` for what took the third mode's place. */

/**
 * How much rope the freehand stabiliser has, at full smoothing, as a fraction
 * of the block's side.
 *
 * An eighth. The tool is dragged along behind the pointer on a rope this long
 * -- see `ropeFollow` -- so the slack is also the radius of the wobble it
 * absorbs completely, and an eighth of the block is a generous hand tremor at
 * any zoom. Past that the line stops feeling attached to the pointer at all.
 */
export const MAX_ROPE = 0.125

/**
 * Where the smoothing dial rests.
 *
 * A THIRD ON RATHER THAN OFF. The tool this screen is for is a cutter, and a
 * cut line that wobbles is a part that does not fit -- so the useful default is
 * some help rather than none. A third of the rope is enough to take a hand's
 * tremor out and short enough that the line still arrives where the pointer is
 * rather than trailing visibly behind it.
 */
export const DEFAULT_ROPE = 1 / 3

/**
 * What either tool may be sized to, and where the two of them start.
 *
 * The BOUNDS are the modelling brushes', re-used deliberately: how wide a tool
 * held against a surface can get is a fact about this app's world -- a
 * millimetre at the fine end, a quarter of the envelope at the coarse -- and
 * not about which screen the surface is on.
 *
 * The DEFAULT is this screen's own. A piece is turned 15 cm tall, and a tool a
 * third of a span wide -- the modelling default -- would cover a fifth of it in
 * one dab: every stroke would be a whole-piece gesture and there would be no way
 * to put a lip on anything. Two and a half centimetres is a thumb, which is
 * what the hand doing this is meant to be.
 */
export const DEFAULT_LATHE_REACH = 0.25

/**
 * How hard a tool is leant on: how fast the wall travels toward the pointer.
 *
 * Higher than the modelling brushes' half force, because the two dials are
 * measuring different things. Heat is how deep ONE dab bites, and the wall
 * under a tool is not being bitten -- it is being carried to where the pointer
 * is holding, and cannot pass it however long you hold. See `mold`. So the dial
 * is a speed rather than a depth, and the speed people reach for first is one
 * where the clay plainly follows the hand.
 */
export const DEFAULT_LATHE_STRENGTH = 0.6

/**
 * What any of the brushes may be sized to.
 *
 * The floor is a millimetre, which is the smallest feature this app can draw at
 * all; the ceiling is a quarter of the five-metre envelope, past which the
 * brush stops being a brush and becomes a way of deleting an object slowly.
 *
 * Shared, and so are the defaults below, because these are facts about the
 * BRUSH -- the sphere, the mesh under it, the range this app's solids live in
 * -- rather than about any one tool. What is not shared is where each tool's
 * dials happen to be sitting: see `sculptRadius`.
 */
export const BRUSH_RADIUS_MIN = 0.01
export const BRUSH_RADIUS_MAX = 12.5

/**
 * How far the pointer travels between one dab and the next, as a fraction of
 * the brush radius.
 *
 * All three are brushes, so a stroke is a RUN of overlapping dabs rather than
 * one swept shape -- and this is the overlap. A third of a radius means
 * consecutive dabs share most of their area, which is what makes a drag read as
 * one continuous groove or bead rather than a row of dents. Closer would only
 * make the stroke cost more and bite harder for the same gesture, which is what
 * Heat and Strength are for and should not also be a side effect of drawing
 * slowly.
 */
export const DAB_SPACING = 0.34

/** A brush a third of the span a fresh solid lands at: big enough to see what
 *  it does on a palette cube, small enough to aim at a corner of one. */
export const DEFAULT_BRUSH_RADIUS = 0.3

/**
 * Where the SMOOTHER's brush starts: a centimetre, a third of the other two.
 *
 * It does not share `DEFAULT_BRUSH_RADIUS` because the three brushes are not
 * reached for at the same moment. The torch and the sculpt tool are how a shape
 * is arrived at, so they open wide enough to move a face; the Smoother is
 * aimed at an edge that is already where it should be, and an edge is a thin
 * thing. At 3 cm the first press on a palette cube took a bite out of a corner
 * you can see across the viewport, which reads as a mistake rather than as a
 * finish.
 *
 * A centimetre is also the honest scale for the number beside it. Strength is a
 * share of this -- see `smootherStrength` -- so the brush is the ceiling on the
 * round, and 1 cm puts the whole dial over the range a chamfer actually lives
 * in: about 2.5 mm at the floor to a centimetre wide open.
 *
 * And it is the cheap end of the tool. A rounding dab refines the region it
 * covers to suit the round it is making, so cost goes with the brush -- see
 * ROUND_MIN. Starting fine means the first stroke anybody draws is the fast
 * one, and going wider is a deliberate act with a visible price.
 */
export const DEFAULT_SMOOTHER_RADIUS = 0.1
/** Half force, so one pass is plainly a mark and a second pass plainly deepens
 *  it -- the rate is the thing that has to feel right, not the single dab. */
export const DEFAULT_BRUSH_FORCE = 0.5
/** Well over half, because the flow is the whole point of both tools: at low
 *  smoothing the torch sandblasts rather than melting, and the sculpt tool
 *  lays down a ridge with the facets still on it rather than a bead. */
export const DEFAULT_BRUSH_SMOOTH = 0.7
/** Half the brush, so the round the Smoother leaves is plainly a round and
 *  plainly smaller than the sphere that made it -- the two facts a first press
 *  has to teach. See `smootherStrength`. */
export const DEFAULT_BRUSH_ROUND = 0.5

/**
 * Bounds on the plane, shared by the panel that types them and the gizmo that
 * drags them. The position limit used to be the Position slider's range and
 * nothing else; now that the slider is gone and the gizmo is the only way to
 * place the plane, it is the one thing keeping a blade from being dragged out
 * past the scene and lost off screen.
 */
export const CUT_POSITION_LIMIT = 50
export const CUT_SIZE_MIN = 0.05
export const CUT_SIZE_MAX = 80

/**
 * The blade with nothing to aim it at: the middle of the scene, level.
 *
 * Twice the span a fresh solid lands at, so it overhangs the thing it is about
 * to sever rather than ending somewhere inside it. Exported because it is also
 * the FLOOR the spawn grows from -- a blade sized to a 5 mm screw would be a
 * guide you could not see, and this is a size already chosen to be usable.
 */
export const DEFAULT_CUT_PLANE: CutPlaneState = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  size: 2,
}

/**
 * Where the tool island sits over the viewport: an offset from ONE edge on each
 * axis, rather than a left/top pair.
 *
 * Which edge is not decoration. An island dragged to the right of the scene and
 * remembered as "980px from the left" walks off the window the moment it
 * narrows, and one dropped along the bottom rides up over the middle of the
 * model instead of staying where it was put. Measured from whichever edge it
 * was left nearest, a docked island stays docked and a floating one keeps the
 * gap it was given.
 *
 * It is also what the panels read to decide which way to open, since the near
 * edge is the one there is no room on.
 */
export type IslandPlacement = {
  hx: 'left' | 'right'
  hy: 'top' | 'bottom'
  /** Distance from `hx`, in CSS pixels. */
  x: number
  /** Distance from `hy`. */
  y: number
}

/**
 * The inset a docked island keeps, shared with the compass and the selection
 * panels: every widget over the scene stands the same distance off the glass.
 */
export const ISLAND_MARGIN = 12

/**
 * How near an edge counts as going to it -- measured from the DOCKED position,
 * not from the edge itself, so the catch is symmetric about where the island
 * will land.
 *
 * Wide enough that flush against an edge is what you get by aiming roughly at
 * one, which is the whole point of a snap; narrow enough that the middle of the
 * scene is still reachable, since an island that cannot be parked between two
 * edges is a docking widget wearing a drag handle.
 */
export const ISLAND_SNAP = 24

const DEFAULT_ISLAND: IslandPlacement = {
  hx: 'left',
  hy: 'top',
  x: ISLAND_MARGIN,
  y: ISLAND_MARGIN,
}

/**
 * One axis of the solve: turn a free offset from the near edge into a distance
 * from whichever edge the island ended up closest to, snapping to the docked
 * inset at either end.
 *
 * `span` is the room the island has to move in on this axis -- the viewport
 * less the island itself -- so `pos` and `span - pos` are the two gaps, and the
 * smaller one names the edge the offset is measured from.
 */
function dockAxis(pos: number, span: number): { offset: number; far: boolean } {
  const near = Math.min(Math.max(pos, 0), Math.max(span, 0))
  const gaps = { start: near, end: Math.max(span, 0) - near }
  const far = gaps.end < gaps.start
  const gap = far ? gaps.end : gaps.start
  // Never past the far edge on a viewport too small to hold the inset: a snap
  // that pushes the island out of the window is worse than no snap.
  const docked = Math.min(ISLAND_MARGIN, Math.max(span, 0))
  return { offset: gap <= ISLAND_MARGIN + ISLAND_SNAP ? docked : gap, far }
}

/**
 * Where an island dragged to `left`/`top` inside the viewport actually lands.
 *
 * Pure, and given every measurement it needs, because this is the whole of what
 * a drag decides: the component that calls it does nothing but read the pointer
 * and hand the answer to the store. Corners are not a case of their own -- they
 * are both axes snapping at once, which is the reason edges and corners feel
 * like one behaviour rather than two.
 */
export function dockIsland(
  left: number,
  top: number,
  size: { width: number; height: number },
  bounds: { width: number; height: number }
): IslandPlacement {
  const h = dockAxis(left, bounds.width - size.width)
  const v = dockAxis(top, bounds.height - size.height)
  return {
    hx: h.far ? 'right' : 'left',
    x: h.offset,
    hy: v.far ? 'bottom' : 'top',
    y: v.offset,
  }
}

/**
 * How many colours the picker remembers, and so how many slots its grid holds.
 *
 * Eight, in a single row: enough that a scene built from a handful of colours
 * keeps all of them within reach, and few enough that the shelf stays a thing
 * you recognise at a glance rather than a list you read. The slots are drawn
 * whether or not there is a colour in them, so the panel does not change height
 * as the shelf fills -- a control that grows under the pointer is a control you
 * miss.
 *
 * Eight is also as many as the row holds. It was two rows of four, and the
 * second row set the height of the whole panel; laid out across instead, the
 * same eight cost nothing. Raising this number now needs the slots to shrink or
 * the row to wrap, and a wrap puts the second row back.
 */
export const RECENT_COLOR_SLOTS = 8

/** Which objects a confirmed eraser takes material out of. */
export type EraseScope = 'all' | 'selected'

/**
 * What a brush is allowed to touch.
 *
 * The same two words the eraser uses, and deliberately so: they are the same
 * question -- does this thing reach whatever it meets, or only what I have
 * picked -- and answering it with two different vocabularies would be two
 * things for a user to learn where there is only one idea.
 *
 * ONE SETTING FOR ALL THREE BRUSHES, for the same reason. "Which solids am I
 * working on" is a fact about the job rather than about the tool in your hand,
 * and having to re-narrow it every time you swapped the torch for the sculpt
 * tool would be a way of melting the wrong object.
 *
 * Unlike the eraser's, this one is answered while the tool is live rather than
 * before a single confirming press, so it is on screen the whole time a brush
 * is armed. A brush is aimed by pointing it, and pointing it at the wrong solid
 * is a mistake you make in the same instant you make the stroke -- so the scope
 * has to be readable without going and opening a panel to check.
 */
export type BrushScope = 'all' | 'selected'

// --- Rulers -----------------------------------------------------------------

/**
 * A measurement laid across the scene: two points, and the distance between
 * them.
 *
 * Here rather than in the document for the reason the cut plane is: a ruler
 * measures what you have built, it is not part of it. Nothing it does changes a
 * solid, nothing about it is exported, and dropping one across two faces must
 * not land in undo history -- otherwise a user hunting for the edit they want
 * to reverse has to walk back through their own measuring first.
 *
 * The ends are a TUPLE rather than two named fields, so the end being dragged
 * is an index the gesture can carry and the store can write back without a
 * branch per end. Which of the two is which carries no meaning: a ruler is the
 * segment between them, and reversing it measures the same length.
 */
export type Ruler = { id: string; ends: [Vec3, Vec3] }

/** Which end of a ruler. See `Ruler.ends`. */
export type RulerEnd = 0 | 1

/**
 * The ruler being worked on, and which of its ends holds the gizmo.
 *
 * ONE end at a time, deliberately. Two sets of arrows a few centimetres apart
 * -- often overlapping, since a short ruler is shorter than the gizmo drawn at
 * either end of it -- is two sets of arrows to tell apart mid-drag, which is
 * the same reason an armed cut plane takes the gizmo away from the selected
 * object. The other end stays a knob you can press, so swapping ends is one
 * click rather than a mode.
 */
export type RulerSelection = { id: string; end: RulerEnd } | null

/**
 * What a fresh ruler measures: 50 mm, which is `0.5` of a scene unit.
 *
 * Written as the conversion rather than as `0.5` so the number in the source
 * is the number in the spec; see `units.ts` for why one unit is ten
 * centimetres.
 */
export const RULER_LENGTH = fromDisplay(50, 'mm')

/**
 * How far apart consecutive rulers are laid down.
 *
 * Spawning every ruler on the same line would make the second one look like it
 * never appeared -- it would be hidden, exactly, by the first. A step across
 * puts each new one beside its predecessor where it can be seen and grabbed.
 */
const RULER_SPACING = fromDisplay(15, 'mm')

/** How many are laid out before the spacing starts again from the first line.
 *  Without a wrap the tenth ruler spawns a metre from the origin, off screen at
 *  the zoom anyone measuring a part is working at. */
const RULER_LANES = 8

/**
 * Ids climb forever, and never restart, so a ruler deleted while its own drag
 * was in flight cannot have the gesture land on whatever took its place.
 * Separate from the document's counters for the same reason those are separate
 * from each other.
 */
let rulerCounter = 0

/**
 * Where a ruler is laid down, and which way it lies: a point, the direction it
 * runs, and the direction consecutive ones step in.
 *
 * A frame rather than a point because a ruler seen END-ON is a ruler that
 * spawned invisible -- world X is a dot on screen the moment the camera comes
 * round to look down it -- and because two rulers stepped apart along an axis
 * the camera happens to be looking down are two rulers on top of each other.
 * Both directions are unit vectors, and `step` must be perpendicular to the
 * view for the second reason above; `rulerFrame` in `NavTools` is what builds
 * one that satisfies both, out of the camera.
 */
export type RulerFrame = { anchor: Vec3; along: Vec3; step: Vec3 }

/**
 * The frame a ruler lands in when nobody has said otherwise: along world X
 * through the origin, stepping +Z.
 *
 * Exactly where rulers landed before there was a camera to consult, which is
 * what makes it the right answer for a caller that has none -- a check suite,
 * or any code that reaches `addRuler` without a view in front of it.
 */
export const WORLD_SPAWN: RulerFrame = {
  anchor: [0, 0, 0],
  along: [1, 0, 0],
  step: [0, 0, 1],
}

/**
 * Where the next ruler goes: centred on the frame's anchor, along its axis,
 * stepped off it by the lane.
 *
 * The frame is the whole of what "near the selected object, facing the user"
 * means to this function -- it takes three vectors and knows nothing about what
 * put them there; see `rulerFrame` in `NavTools`, which is the half that reads
 * the document and the camera. That split is what keeps the tool store free of
 * both, the way `dropPosition` keeps the placement rule out of `addObject`.
 *
 * The step runs one way rather than either side of the anchor, so a lane never
 * walks back over the anchor -- which is chosen to sit clear of the solid being
 * measured, and is the one place a ruler must not be.
 *
 * Pure and exported so `ui-check` can state the rule rather than transcribe one
 * result. The lane comes from the id counter rather than from how many rulers
 * currently exist, so deleting one does not drop the next one on top of a
 * survivor.
 */
export function rulerSpawn(lane: number, frame: RulerFrame = WORLD_SPAWN): [Vec3, Vec3] {
  const [x, y, z] = frame.anchor
  const [ax, ay, az] = frame.along
  const [sx, sy, sz] = frame.step
  const half = RULER_LENGTH / 2
  const off = (lane % RULER_LANES) * RULER_SPACING
  return [
    [x - ax * half + sx * off, y - ay * half + sy * off, z - az * half + sz * off],
    [x + ax * half + sx * off, y + ay * half + sy * off, z + az * half + sz * off],
  ]
}

/** What a ruler reads: the straight-line distance between its two ends. */
export function rulerLength(ruler: Ruler): number {
  const [a, b] = ruler.ends
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
}

function makeRuler(frame?: RulerFrame): Ruler {
  rulerCounter += 1
  return { id: `r${rulerCounter}`, ends: rulerSpawn(rulerCounter - 1, frame) }
}

/**
 * What the gizmo is FOR right now: sliding the target, turning it, or sizing
 * it.
 *
 * One at a time, and one for the whole app -- the object's gizmo, a sketch's
 * and the cut plane's all read this one field -- because the question it
 * answers is "what will my next drag do", and an answer that differed by what
 * happened to be selected would have to be learnt again per selection.
 *
 * `move` is the resting state rather than a fourth "no tool": every target has
 * somewhere to be moved to, and a gizmo with no mode would be a gizmo with no
 * handles. Turning the active tool off therefore lands here rather than on
 * nothing, which is also what makes the two tools mutually exclusive without a
 * rule saying so -- one field cannot hold both.
 *
 * WHETHER THERE IS A GIZMO AT ALL is a separate question, and it has to be --
 * see `gizmoHidden`. A fourth `none` here would have answered it in the wrong
 * place: the cut plane's gizmo and a sketch's both read this field for their
 * own mode, so a `none` would have disarmed the very handles the cut tool
 * exists to be aimed with.
 */
export type TransformMode = 'move' | 'rotate' | 'scale'

export type ToolState = {
  /**
   * Which SCREEN is on show: which viewport is mounted, and which console
   * beside it. See `screens.ts`.
   *
   * Here rather than in the document for the reason everything else in this
   * store is: it is where you are working, not what you have built. Switching
   * to Lathe and back must not land in undo history, and a saved document
   * cannot sensibly say which screen its author last had open.
   */
  screen: ScreenId
  /** Which gizmo the viewport is showing. See `TransformMode`. */
  transformMode: TransformMode
  /**
   * The SELECTION wears no handles: no arrows, no rings, nothing over the
   * object at all.
   *
   * Separate from `transformMode` rather than a fourth value of it, because the
   * two are different questions with different audiences. The mode says what a
   * drag would DO, and the cut plane and a selected sketch read it for their own
   * handles; this says whether the thing you have merely SELECTED puts handles
   * on screen. Folding them together would mean turning the object's gizmo off
   * also disarmed the cut plane's, which is the one gizmo you cannot work
   * without while the cut tool is armed.
   *
   * It exists because a gizmo you did not ask for can be in the way. Selecting a
   * solid is how you do almost everything here, and the arrows and plane quads
   * that come with it sit exactly where a brush wants to go -- so there has to
   * be a way to put them down that is not deselecting the object you are working
   * on.
   *
   * A tool preference, not a property of the selection: it survives picking a
   * different object, the way Snap and the display unit do.
   */
  gizmoHidden: boolean
  /**
   * Which of the object's own axes the Mirror tool flips along.
   *
   * A tool setting rather than a document field, and the same kind of thing the
   * cut plane's angle is: a mirror is fired and finished, and what is left
   * behind is a reflected solid rather than a solid that remembers being
   * reflected. What this remembers is only which way you last aimed the tool,
   * so pressing Mirror again does the same thing again.
   *
   * X to start with, which is the one anybody testing the tool reaches for
   * first: it is the axis a person stands facing, and the flip is the one you
   * can see happen without turning the camera.
   */
  mirrorAxis: Axis
  /**
   * Whether drags snap, wherever there is anything to snap to.
   *
   * ONE SWITCH ACROSS THE APP, because it is a way of WORKING rather than a
   * property of what is being worked on -- somebody who wants their drags to
   * catch wants that on the bench and at the cutter both, and having to arm it
   * again on arriving at a screen is how a preference stops feeling like one.
   * What is not shared is how near is near: see `laserSnapDistance`.
   */
  snap: boolean
  /**
   * How near a drag has to come before the modelling screen's snap catches, as
   * a length in the WORLD.
   *
   * The right kind of number there: what it catches is the corner or the middle
   * of a solid, and a corner is somewhere in particular however near the camera
   * happens to stand -- so the tolerance is a distance in the room, and a
   * millimetre stays a millimetre when you lean in.
   */
  snapDistance: number
  /**
   * And how near a Point Cut's knot has to come to another knot's row or column
   * before it takes it, in PIXELS on screen.
   *
   * ITS OWN NUMBER, and this is the one thing about it worth arguing. Sharing
   * `snapDistance` would be sharing a length in the world between two screens
   * that do not mean the same thing by nearness. On the laser cutter there is
   * nothing in a room to catch: the camera is square on to a flat face, the
   * whole act is lining one mark up with another mark on that face, and what
   * makes two marks look aligned is how far apart they are ON SCREEN. It is
   * also the only reading that survives the wheel -- this camera zooms twenty
   * times over, and a fixed world tolerance would swallow every neighbouring
   * point at one end of that range and catch nothing at the other.
   *
   * The same choice the knots, the grips and the grab radius already make in
   * `CutLayer`, for the same reason: these are facts about a hand and a screen.
   * See `DEFAULT_LASER_SNAP` in `pointSnap.ts`, which owns the range as well.
   */
  laserSnapDistance: number
  /** Which unit lengths are SHOWN in. Purely a display choice: nothing in the
   *  document or the geometry changes with it. */
  displayUnit: UnitMode
  /** Which palette the app wears. Display-only in exactly the same sense the
   *  unit is, which is why the two share a panel. */
  theme: Theme
  /**
   * Whether solids wear the thin edge lines around their faces.
   *
   * The third display-only preference, and it sits with the other two for the
   * same reason they sit with each other: an outline is a way of DRAWING the
   * document and never part of it. Nothing in the geometry, the file or an
   * export knows this flag exists.
   *
   * It is worth a switch because the outlines are an argument rather than a
   * fact. They are what makes the scene read as CAD -- every face bounded, every
   * bevel countable -- and that is exactly what is in the way when the scene is
   * being looked at as a MODEL: a rounded solid crossed by its own tessellation
   * lines, or a busy assembly where the lines outweigh the shading. Turning them
   * off is how you see the surface itself, and there was no way to ask for that.
   *
   * Selection survives it. A chosen solid is lit by its own material as well as
   * ringed, so with the lines off the glow is still there to read -- see `Body`
   * in `SceneObjects`. That is what lets this hide the selected object's outline
   * too, rather than carving out an exception nobody asked for.
   */
  showOutlines: boolean
  cutActive: boolean
  cutPlane: CutPlaneState
  openPanel: NavPanel
  /**
   * Which page of the Help screen is open.
   *
   * Here rather than in the component for exactly the reason `openPanel` and
   * `islandCollapsed` are: the screen is eight pages of prose that go stale as
   * the app changes, and the only defence against that is a check that can walk
   * every page and read it. A `useState` inside `HelpScreen` would leave seven
   * of the eight unreachable to `ui-check` -- which is to say untested, which
   * for documentation is the whole ballgame.
   *
   * Chrome, like everything else in this store, so it stays out of undo.
   */
  helpSection: HelpSectionId
  /**
   * Whether the tool island over the scene is shut down to its title strip.
   *
   * Here rather than in the island for the reason `openPanel` is: the tools are
   * driven headlessly in `ui-check`, and a `useState` inside the component is
   * state no test and no other part of the app can reach. It is chrome, so like
   * every other field in this store it stays out of undo.
   */
  islandCollapsed: boolean
  /** Where it sits over the scene. See `IslandPlacement`. */
  islandPlacement: IslandPlacement
  /**
   * Colours the picker has applied, MOST RECENT FIRST, capped at
   * `RECENT_COLOR_SLOTS`.
   *
   * Here rather than in the document for the reason the whole store exists:
   * this is how you have been working, not what you have built. It must not
   * land in undo history -- walking back an edit should not also forget the
   * colour you were using -- and it must outlive the panel, which unmounts
   * whenever the console is rebuilt around it.
   */
  recentColors: string[]

  /**
   * What an eraser takes material out of when it is confirmed.
   *
   * `all` is the eraser as a physical object: whatever it is sitting inside
   * loses the material, which is what a hole through a stack of plates means.
   * `selected` narrows it to the objects picked out alongside the eraser, for
   * the case where two things overlap and only one of them should be drilled.
   *
   * A tool preference rather than a field on the eraser: it describes how you
   * are working, so it stays out of undo and survives the panel unmounting --
   * the same rule the snap distance and the shelf of colours follow.
   */
  eraseScope: EraseScope
  /**
   * Which brush is armed, if either: the ghost follows the pointer and a drag
   * works the surface. See `BrushTool`.
   */
  brushTool: BrushTool
  /** The torch's brush radius in scene units -- the sphere the ghost draws. */
  erodeRadius: number
  /**
   * The unit the brush size is READ AND TYPED in, chosen here and nowhere else.
   *
   * The one length in the app that does not follow `displayUnit`, and the
   * reason is the range: the brush runs from 1 mm to 1.25 m, so under `auto`
   * -- which is the app's default -- a single drag of the size slider crosses
   * both switching points and the number under the pointer goes 9.9, 1.00,
   * 99.9, 1.00 while the hand never changes direction. `auto` reads a length;
   * this control SETS one, and a scale that renumbers itself mid-gesture cannot
   * be aimed.
   *
   * So the field is pinned, and to a unit the user picks rather than one this
   * file asserts. Centimetres to start: the default brush is 3 cm, which is two
   * digits at both ends of the useful range where millimetres is four.
   */
  erodeSizeUnit: Unit
  /** How hard one of the torch's dabs bites, 0..1. */
  erodeHeat: number
  /** How much one of the torch's dabs flows rather than merely sinking, 0..1. */
  erodeSmooth: number

  /**
   * The sculpt tool's three dials, mirroring the torch's above.
   *
   * ITS OWN, rather than the torch's shared between them, although the two are
   * the same brush pointed opposite ways and the bounds and defaults they start
   * from are literally the same numbers. What differs is not what a dial MEANS
   * but where you leave it: the sizes are chosen for the job, and the jobs are
   * different ones. Blocking a shape out is a fat brush and carving a detail
   * into it is a fine one, and a user who alternates between them would spend
   * the session re-dialling a single size back and forth. Every other tool in
   * this file keeps its own settings for the same reason.
   *
   * Strength rather than Heat, because nothing here is hot. It is the same
   * number in the same range doing the same job -- how far one dab moves the
   * surface -- and it is stored on the dab as `heat` either way, since the
   * geometry has one word for it. See `ErodeDab`.
   */
  sculptRadius: number
  sculptSizeUnit: Unit
  sculptStrength: number
  sculptSmooth: number

  /**
   * The Smoother's two dials.
   *
   * TWO, NOT THREE, and the missing one is Smoothing -- which would be this
   * whole tool's own name written on a control inside it. The other two brushes
   * carry it because for them the flow is a SHARE of what a dab does beside
   * sinking or raising; here there is nothing beside it, so the question "how
   * much smoothing" has already been answered by having reached for this tool
   * at all.
   *
   * `smootherStrength` is the one that replaces it, and it is a different KIND
   * of number from the other two brushes' Strength. Theirs is a rate: how far
   * one dab moves the surface, held down for longer and the mark goes deeper.
   * This one is a DESTINATION -- the radius a corner under the brush is driven
   * to, as a share of `smootherRadius` -- so a stroke arrives somewhere and
   * stops, and going over the same corner again leaves it as it is. See
   * `ErodeDab.round`.
   *
   * A share of the brush rather than a length of its own, which is what makes
   * the two dials one gesture instead of two numbers to reconcile: the ghost
   * sphere on screen is the corner you are working, and Strength is how much of
   * it to fill. It also means the pair scales together -- halve the brush to get
   * into a tighter corner and the round it leaves halves with it, which is
   * almost always what was wanted.
   *
   * Its own size rather than the other brushes' shared, for the reason set out
   * on `sculptRadius`: what differs between the three is not what a dial means
   * but where you leave it, and taking an edge off is a different job from
   * blocking a shape out. Here that shows up in the DEFAULT as well as in the
   * drift -- this one starts at a third of the size the other two do. See
   * `DEFAULT_SMOOTHER_RADIUS`.
   */
  smootherRadius: number
  smootherSizeUnit: Unit
  smootherStrength: number

  /** What the armed brush may touch. Shared by all three -- see `BrushScope`. */
  brushScope: BrushScope

  /**
   * Which tool is against the piece on the Lathe screen, if either. See
   * `LatheTool`.
   */
  latheTool: LatheTool
  /** Which cutting tool is in hand on the Laser Cutter. See `LaserTool`. */
  laserTool: LaserTool
  /**
   * How much rope the freehand stabiliser has, 0 to 1, as a share of
   * `MAX_ROPE`.
   *
   * A dial rather than a switch, because "how much help" is a real question
   * with a different answer for a straight edge and for a traced curve -- and
   * because zero is a perfectly good setting that a switch would have made a
   * second control to find. It is the same shape as the modelling brushes'
   * Smoothing, which is the other dial in this app that decides how much of the
   * hand reaches the work.
   */
  freehandSmoothing: number
  /**
   * Whether a Point Cut runs a smooth curve through its points, or joins them
   * with straight segments.
   *
   * IT WAS THREE MODES AND IS TWO STATES, and the third was never a way of
   * reading the points at all. Straight was the polyline; Fit was a curve
   * through every point; Manual was that SAME curve with its tangents exposed
   * as handles to be aimed. So Fit and Manual differed by who owned the
   * handles, not by what the line was -- and picking Manual to adjust something
   * by hand also switched a straight line into a curve, which is the trap: the
   * one mode named for hand-editing was the one you could not reach from a
   * straight line.
   *
   * With one switch the two questions come apart. Off is straight segments, on
   * is a smooth curve, and hand-editing is not a mode either way: points are
   * dragged in both, and with the curve on every point carries a handle you may
   * aim. A handle you have aimed is kept; the rest go on being fitted. Which is
   * strictly more than the three modes could say, because "this point's tangent
   * is mine and that one's is the curve's" had no mode to live in. See
   * `handles` in `cutDraft`.
   *
   * The points survive the switch, because they are what the user placed and
   * this is only how they are read. Off and on again does not lose a curve, and
   * does not lose an aimed handle either.
   *
   * OFF TO START WITH, which is what it has always opened on: a straight line
   * between two points is what anybody reaches for first, and it is the mode
   * where what you placed is exactly what gets cut.
   */
  fitCurve: boolean
  /* AUTO DISCARD USED TO LIVE HERE, one flag shared by both cutting tools: a
     cut threw its own offcut away as it landed, for anyone trimming a block
     down to a shape where every cut ends in the same Delete.

     IT WENT WHEN THE OFFCUT STOPPED BEING A VERDICT. The cut used to decide
     which piece was waste -- the smallest -- so binning it unasked was only
     ever making the press you were going to make anyway. The cut still makes
     that guess, but it hands the choice back now: see `choices` in
     `laserStore`. A switch that throws a piece away before you have looked at
     which one it picked is not a shortcut through that decision, it is a way
     to lose the piece you came for -- and undo is a poor answer to something
     that happens by default. */
  /**
   * Whether the stock panel is open, or shut down to its title strip.
   *
   * Here rather than in the component for the reason `islandCollapsed` and
   * `openPanel` are: the panel is driven headlessly in `ui-check`, and a
   * `useState` inside it is state no check and no other part of the app can
   * reach. Chrome, so like everything else in this store it stays out of undo.
   *
   * Open to start with. It is the only place the size of the stock can be set,
   * and a control that has to be found before it can be used is one nobody
   * finds -- the corner it stands in is empty scene otherwise.
   *
   * ONE FLAG FOR TWO SCREENS, the lathe's lump and the laser cutter's block.
   * They are the same panel in the same corner doing the same job -- see
   * `BlockPanel` -- and only one of them is ever mounted, so what is really
   * being remembered is whether this user works with that corner open. That is
   * the bargain `islandCollapsed` already strikes, and for the same reason: it
   * is a fact about the hand, not about the screen.
   */
  stockOpen: boolean
  /**
   * How far the lathe's view is zoomed, as a factor on the frame at rest.
   *
   * THE ONLY THING THAT MOVES THAT VIEW, and that is the point of it existing
   * at all. The frame used to fit itself to the stock, so it rescaled whenever
   * the lump was resized -- twice wrong, because it cancelled out the growth it
   * was meant to show and because it did it mid-drag. Now nothing re-frames on
   * its own: a lump too big for the frame runs off it and is clipped, and this
   * is the number the user turns to go and look. See `clayFrame`.
   *
   * IN THE TOOL STORE, beside `stockOpen`, not in `latheStore`. The rule there
   * is stated at the top of that file: it holds what you have BUILT, and a zoom
   * is not part of the piece -- copy the piece to the clipboard and the zoom
   * does not go with it. It is chrome, so like everything else here it stays out
   * of undo.
   */
  latheZoom: number
  /**
   * How much of the wall each tool covers, and how hard each is leant on.
   *
   * ONE PAIR EACH, not one pair shared, which is the arrangement the two
   * modelling brushes already keep and it earns its keep faster here. Push and
   * pull are used at different scales in the same minute: a belly is pulled out
   * with a wide tool and the neck above it is pushed in with a narrow one, and a
   * user alternating between them would spend the sitting re-dialling a single
   * size back and forth.
   *
   * The sizes are LENGTHS in scene units, pinned to a unit of their own the way
   * the brushes' are -- see `erodeSizeUnit` for why a control that SETS a
   * length cannot be read in `auto`.
   */
  pushReach: number
  pushSizeUnit: Unit
  pushStrength: number
  pullReach: number
  pullSizeUnit: Unit
  pullStrength: number
  smoothReach: number
  smoothSizeUnit: Unit
  smoothStrength: number
  /**
   * The unit the Hollow panel is read and typed in.
   *
   * Pinned rather than `auto`, like every other control that SETS a length --
   * see `erodeSizeUnit` -- and it starts at MILLIMETRES rather than at the
   * centimetres the tool sizes use, because that is the unit a wall thickness
   * is actually spoken in. Nobody says a pot has a 0.6 cm wall.
   *
   * One unit for the whole panel rather than one per row, which is why it is
   * named for the panel and not for a field: it is chosen from the panel's own
   * header. See `UnitPicker`.
   */
  hollowSizeUnit: Unit

  /**
   * Whether the ruler tool is engaged, and so whether any ruler is drawn.
   *
   * A visibility switch rather than a mode: nothing about how the rest of the
   * app behaves changes with it, and the rulers it hides are still there when
   * it comes back on. That is the difference between this and the cut tool,
   * which resets its plane on the way out -- a plane is aimed for one act and
   * fired, where a measurement is a thing you put down and come back to.
   */
  rulerActive: boolean
  /** Every ruler in the scene, in the order they were laid down. */
  rulers: Ruler[]
  /** The one being worked on, and which end holds the gizmo. */
  selectedRuler: RulerSelection

  /** Show a different screen. Closes any open tool panel with it: every one of
   *  them hangs off a bar or an island that is about to be replaced. */
  setScreen: (screen: ScreenId) => void
  setTransformMode: (mode: TransformMode) => void
  /**
   * PRESS one of the picker's three buttons -- the whole of what a press means,
   * in one place.
   *
   * An action rather than two setters at each call site, because the button and
   * the keyboard shortcut have to agree exactly and there are two of them: a
   * rule split across the island and the key handler is a rule that drifts.
   */
  pressTransformMode: (mode: TransformMode) => void
  setGizmoHidden: (hidden: boolean) => void
  /** Aim the Mirror tool. Which axis it lands on is remembered; the flip
   *  itself is a document edit and belongs to `docStore`. */
  setMirrorAxis: (axis: Axis) => void
  setSnap: (on: boolean) => void
  setSnapDistance: (d: number) => void
  setLaserSnapDistance: (pixels: number) => void
  setDisplayUnit: (unit: UnitMode) => void
  setTheme: (theme: Theme) => void
  setShowOutlines: (on: boolean) => void
  /**
   * Arm or stand down the cut tool.
   *
   * `spawn` is where the blade appears, and it is the caller's to work out --
   * `DEFAULT_CUT_PLANE` when it is left out, which is what a caller with no
   * document in front of it gets. See `cutPlaneSpawn` in `NavTools`, the half
   * that reads the selection; the same split that keeps `rulerSpawn` here and
   * `rulerFrame` there, and for the same reason: this store never reads the doc.
   */
  setCutActive: (on: boolean, spawn?: CutPlaneState) => void
  setCutPlane: (patch: Partial<CutPlaneState>) => void
  /** Put the blade back where arming would drop it now -- which is a question
   *  about the CURRENT selection, so the answer comes in from the caller. */
  resetCutPlane: (spawn?: CutPlaneState) => void
  setOpenPanel: (panel: NavPanel) => void
  setHelpSection: (section: HelpSectionId) => void
  setIslandCollapsed: (collapsed: boolean) => void
  setIslandPlacement: (placement: IslandPlacement) => void
  setEraseScope: (scope: EraseScope) => void
  setBrushTool: (tool: BrushTool) => void
  setErodeRadius: (radius: number) => void
  setErodeSizeUnit: (unit: Unit) => void
  setErodeHeat: (heat: number) => void
  setErodeSmooth: (smooth: number) => void
  setSculptRadius: (radius: number) => void
  setSculptSizeUnit: (unit: Unit) => void
  setSculptStrength: (strength: number) => void
  setSculptSmooth: (smooth: number) => void
  setSmootherRadius: (radius: number) => void
  setSmootherSizeUnit: (unit: Unit) => void
  setSmootherStrength: (strength: number) => void
  setBrushScope: (scope: BrushScope) => void
  /** Take up a tool, or put the one in your hand down. */
  setLatheTool: (tool: LatheTool) => void
  /** Take up a cutting tool, or put the one in hand down. */
  setLaserTool: (tool: LaserTool) => void
  setFreehandSmoothing: (smoothing: number) => void
  setFitCurve: (fit: boolean) => void
  setStockOpen: (open: boolean) => void
  /**
   * Zoom the lathe's view, by a FACTOR rather than to a value.
   *
   * A factor because every gesture that drives it is a relative one -- a wheel
   * notch, a press of a button -- and because zoom is felt geometrically: a step
   * that is a fifth of the frame when you are close should be a fifth of it when
   * you are far off, not a fixed number of scene units. `setLatheZoom` is the
   * absolute one, for the single caller that has an absolute answer: Fit.
   */
  zoomLathe: (factor: number) => void
  setLatheZoom: (zoom: number) => void
  setPushReach: (reach: number) => void
  setPushSizeUnit: (unit: Unit) => void
  setPushStrength: (strength: number) => void
  setPullReach: (reach: number) => void
  setPullSizeUnit: (unit: Unit) => void
  setPullStrength: (strength: number) => void
  setSmoothReach: (reach: number) => void
  setSmoothSizeUnit: (unit: Unit) => void
  setSmoothStrength: (strength: number) => void
  setHollowSizeUnit: (unit: Unit) => void
  /**
   * Engage the tool, laying down a first ruler if there are none.
   *
   * `frame` is where that first one lands and which way it lies -- `WORLD_SPAWN`
   * when it is left out, which is what a caller with no document and no camera
   * in front of it wants.
   */
  setRulerActive: (on: boolean, frame?: RulerFrame) => void
  /** Lay down another in `frame` and take it as the selection. */
  addRuler: (frame?: RulerFrame) => void
  removeRuler: (id: string) => void
  selectRuler: (selection: RulerSelection) => void
  /** Write one end's position, from its gizmo or from anywhere else. */
  setRulerEnd: (id: string, end: RulerEnd, position: Vec3) => void
  /** Record a colour as just used, moving it to the front if it is already
   *  there rather than letting the shelf fill with one repeated swatch. */
  noteRecentColor: (color: string) => void
}

export const useTools = create<ToolState>((set) => ({
  // The general editor, which is the only screen there was.
  screen: DEFAULT_SCREEN,
  // Move: the arrows and the plane quads, which is the gizmo this app had
  // before there was a choice to make.
  transformMode: 'move',
  // Handles ON. Selecting a solid and finding it wearing arrows is the app's
  // oldest behaviour, and it is the right default: the gizmo is how most people
  // do most things, and the ones who want it gone now have a way to say so.
  gizmoHidden: false,
  // See `mirrorAxis`: the axis you can watch a flip happen along without
  // moving the camera.
  mirrorAxis: 0,
  snap: true,
  snapDistance: DEFAULT_SNAP_DISTANCE,
  laserSnapDistance: DEFAULT_LASER_SNAP,
  // `auto` by default: it reads correctly for a 2 mm boss and a 4 m wall alike,
  // which a fixed unit cannot do across the range the app now allows.
  displayUnit: 'auto',
  theme: DEFAULT_THEME,
  // On, which is how the app has always drawn and what a modelling tool is
  // expected to look like: the lines are how you count a chamfer or see where
  // one solid stops and the next starts. Off is the deliberate act, for the
  // moment the drawing gets in the way of the shape.
  showOutlines: true,
  cutActive: false,
  cutPlane: DEFAULT_CUT_PLANE,
  openPanel: null,
  // The first page, always -- see DEFAULT_HELP_SECTION. Help is opened by
  // somebody who has just arrived, so it opens at the beginning rather than
  // wherever the last reader left off.
  helpSection: DEFAULT_HELP_SECTION,
  // Open, because these are the two switches the app is worked through and a
  // palette that has to be opened before it can be used costs a click on every
  // use of it. Collapsing is for the person framing a shot, not the default.
  islandCollapsed: false,
  // Top-left: the corner the compass, the selection panels and the drag hint
  // all leave alone.
  islandPlacement: DEFAULT_ISLAND,
  // Every object, because an eraser you have positioned inside something is an
  // eraser you meant to cut that something with. Narrowing is the deliberate
  // act, and it costs one click on the switch.
  eraseScope: 'all',
  brushTool: null,
  erodeRadius: DEFAULT_BRUSH_RADIUS,
  // Never 'auto', whatever the rest of the app is set to -- see `erodeSizeUnit`.
  erodeSizeUnit: 'cm',
  erodeHeat: DEFAULT_BRUSH_FORCE,
  erodeSmooth: DEFAULT_BRUSH_SMOOTH,
  // The same three numbers, in their own slots. See `sculptRadius`.
  sculptRadius: DEFAULT_BRUSH_RADIUS,
  sculptSizeUnit: 'cm',
  sculptStrength: DEFAULT_BRUSH_FORCE,
  sculptSmooth: DEFAULT_BRUSH_SMOOTH,
  // And the Smoother's two. Its size does NOT start where the other two do: an
  // edge is a thinner thing than a face, and this brush is the one that is
  // aimed at edges. See `DEFAULT_SMOOTHER_RADIUS`.
  smootherRadius: DEFAULT_SMOOTHER_RADIUS,
  smootherSizeUnit: 'cm',
  smootherStrength: DEFAULT_BRUSH_ROUND,
  // Everything, matching the eraser's default and for the same reason: the
  // commonest thing to do with a brush is point it at something and pull, and
  // a tool that silently did nothing until you had also selected the right
  // solid would read as broken.
  brushScope: 'all',

  // PUSH, IN HAND ON ARRIVAL. The lathe is a screen with one thing on it and
  // one thing to do to it, and the commonest first act on a fresh cylinder is
  // to take material off -- so the tool that does it is the one already held.
  // The alternative was arriving empty-handed, which made the first press
  // anybody made on the clay do nothing at all and read as a screen that was
  // not working. Putting a tool down is still a press on its lit button.
  latheTool: 'push',
  // Empty-handed, unlike the lathe -- see `LaserTool` for why the two screens
  // answer this differently.
  laserTool: null,
  freehandSmoothing: DEFAULT_ROPE,
  // OFF, because straight is what placing points and joining them up means
  // before anybody asks for anything else, and because it is the state in which
  // what you see is exactly what you placed. Curving is a thing you decide
  // about a line that already exists.
  fitCurve: false,
  stockOpen: true,
  latheZoom: 1,
  pushReach: DEFAULT_LATHE_REACH,
  pullReach: DEFAULT_LATHE_REACH,
  // Wider than the two that cut, because it is a different gesture: a rib is
  // drawn along a side to take the wobble out of a whole stretch of it, where a
  // push is aimed at one place. Half again is enough to feel like a different
  // size of thing without needing its own explanation.
  smoothReach: DEFAULT_LATHE_REACH * 1.5,
  // Centimetres, as the brushes are, and for the same reason: a tool runs from a
  // millimetre to over a metre, and under `auto` a single drag of the size
  // slider renumbers itself twice while the hand never changes direction.
  pushSizeUnit: 'cm',
  pullSizeUnit: 'cm',
  smoothSizeUnit: 'cm',
  // Millimetres: a wall is millimetres thick, and the panel opens speaking the
  // unit its one number is usually said in.
  hollowSizeUnit: 'mm',
  pushStrength: DEFAULT_LATHE_STRENGTH,
  pullStrength: DEFAULT_LATHE_STRENGTH,
  smoothStrength: DEFAULT_LATHE_STRENGTH,

  // Empty, not seeded with a starter palette: every slot on screen is a colour
  // this user actually chose, so the grid is a history rather than a suggestion.
  recentColors: [],

  // Nothing measured until asked for. The first click on the tool is what lays
  // a ruler down, so the button is never a switch with nothing behind it.
  rulerActive: false,
  rulers: [],
  selectedRuler: null,

  setScreen: (screen) => set({ screen, openPanel: null }),

  setTransformMode: (transformMode) => set({ transformMode }),

  pressTransformMode: (mode) =>
    set((s) => {
      // Pressing anything that is not the lit button picks it -- and brings the
      // handles back if they were down, so a hidden gizmo is never a dead
      // picker. Reaching for Rotate is a clear enough statement that you want a
      // gizmo again.
      if (s.gizmoHidden || s.transformMode !== mode) {
        return { transformMode: mode, gizmoHidden: false }
      }
      // Pressing the LIT button puts it away, and where it puts it away to
      // escalates. Rotate and Scale fall back to Move, which is where the gizmo
      // rests and has always been the answer. Move has nowhere further to fall,
      // so Move is the one that takes the handles off the object entirely --
      // which makes the whole picker a three-step ladder from any tool: press
      // your tool to get back to Move, press Move to get back to nothing.
      return mode === 'move' ? { gizmoHidden: true } : { transformMode: 'move' }
    }),

  setGizmoHidden: (gizmoHidden) => set({ gizmoHidden }),

  setMirrorAxis: (mirrorAxis) => set({ mirrorAxis }),

  setSnap: (on) => set({ snap: on }),
  setSnapDistance: (d) => set({ snapDistance: Math.max(0, d) }),
  // Clamped to the range the panel offers rather than only to nothing, because
  // this one can be typed into as well as dragged and a snap reaching half the
  // window is a knot that can never be placed anywhere.
  setLaserSnapDistance: (pixels) =>
    set({
      laserSnapDistance: Math.min(LASER_SNAP_MAX, Math.max(LASER_SNAP_MIN, pixels)),
    }),
    setDisplayUnit: (displayUnit) => set({ displayUnit }),

    setTheme: (theme) => set({ theme }),

    setShowOutlines: (showOutlines) => set({ showOutlines }),

  // Leaving the tool rearms it, so the next cut starts from a predictable plane
  // rather than wherever the previous one happened to be dragged to. Arming it
  // opens nothing: the console panels it drives are already on screen, and they
  // reveal themselves from `cutActive` alone.
  //
  // The blade is placed on the way IN and reset on the way out. Standing down
  // goes to the default rather than to the spawn, because the spawn describes a
  // selection that will have moved on by the next arming -- and arming is where
  // it is asked for again.
  // THE PANEL COMES AND GOES WITH THE PLANE, and it is stated here rather than
  // in the button for the reason `setIslandCollapsed` states its own rule
  // here: the invariant is about the state, and the button is only one of the
  // ways in. Arming OPENS it, which no other tool asks for and this one has to
  // -- a cut is fired from a button rather than by dragging the gizmo, so a
  // user shown nothing but a plane would have nothing to press. It is what the
  // actions did for themselves while they hung under the island.
  //
  // Disarming shuts it, but only if it is still the cut's own panel that is
  // up: closing somebody else's would be this tool reaching outside itself.
  setCutActive: (on, spawn) =>
    set((s) =>
      on
        ? { cutActive: true, cutPlane: spawn ?? DEFAULT_CUT_PLANE, openPanel: 'cut' }
        : {
            cutActive: false,
            cutPlane: DEFAULT_CUT_PLANE,
            openPanel: s.openPanel === 'cut' ? null : s.openPanel,
          }
    ),

  setCutPlane: (patch) => set((s) => ({ cutPlane: { ...s.cutPlane, ...patch } })),
  resetCutPlane: (spawn) => set({ cutPlane: spawn ?? DEFAULT_CUT_PLANE }),

  // One panel at a time: they hang over the same viewport and would overlap.
  setOpenPanel: (panel) => set({ openPanel: panel }),

  setHelpSection: (helpSection) => set({ helpSection }),

  setIslandCollapsed: (collapsed) =>
      set((s) => ({
        islandCollapsed: collapsed,
        // A panel hanging off a button inside the island goes off screen with
        // it, so it is closed rather than left open behind it -- otherwise it
        // springs back the next time the island does, from a click nobody
        // made. Here rather than in the collapse BUTTON because the invariant
        // is about the state, and the button is only one of the ways in.
        openPanel:
          collapsed && ISLAND_PANELS.includes(s.openPanel) ? null : s.openPanel,
      })),

  setIslandPlacement: (placement) => set({ islandPlacement: placement }),

  setEraseScope: (scope) => set({ eraseScope: scope }),

  // Unlike the cut plane, nothing is rearmed on the way out: the brush settings
  // are how you work rather than a thing being aimed, so a size dialled in for
  // one job is still there when the tool comes back. What DOES go is the tool
  // itself, since a brush left armed under the pointer is a brush that works
  // the next thing you click on.
  //
  // Picking one brush puts the other down without a word about it, which is
  // the whole reason this is a mode rather than two switches -- see
  // `BrushTool`. `null` is both of them down.
  setBrushTool: (brushTool) => set({ brushTool }),
  setErodeRadius: (radius) =>
    set({ erodeRadius: clamp(radius, BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX) }),
  // The unit alone. The radius is held in scene units and never touched by
  // this, so switching to millimetres shows the same brush, spelled longer.
  setErodeSizeUnit: (erodeSizeUnit) => set({ erodeSizeUnit }),
  setErodeHeat: (heat) => set({ erodeHeat: clamp(heat, 0, 1) }),
  // The floor is the geometry's, not the panel's -- a point cannot be melted
  // without some flow, and the control offers nothing below what actually
  // works rather than accepting a number and quietly correcting it.
  setErodeSmooth: (smooth) => set({ erodeSmooth: clamp(smooth, BRUSH_SMOOTH_MIN, 1) }),

  // The sculpt tool's three, held to exactly the same bounds: they are one
  // brush's limits, not one tool's. See `BRUSH_RADIUS_MIN` and the note on
  // `sculptRadius`.
  setSculptRadius: (radius) =>
    set({ sculptRadius: clamp(radius, BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX) }),
  setSculptSizeUnit: (sculptSizeUnit) => set({ sculptSizeUnit }),
  setSculptStrength: (strength) => set({ sculptStrength: clamp(strength, 0, 1) }),
  setSculptSmooth: (smooth) => set({ sculptSmooth: clamp(smooth, BRUSH_SMOOTH_MIN, 1) }),

  // The Smoother's two, its size held to the same bounds as the other brushes'
  // for the same reason: they are one brush's limits, not one tool's.
  setSmootherRadius: (radius) =>
    set({ smootherRadius: clamp(radius, BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX) }),
  setSmootherSizeUnit: (smootherSizeUnit) => set({ smootherSizeUnit }),
  // The floor is not zero, and it is geometry rather than taste: a round finer
  // than the triangles under it cannot be shown, and asking for one spends the
  // whole vertex budget arriving at nothing. See ROUND_MIN.
  setSmootherStrength: (strength) => set({ smootherStrength: clamp(strength, ROUND_MIN, 1) }),

  setBrushScope: (scope) => set({ brushScope: scope }),

  setLatheTool: (latheTool) => set({ latheTool }),
  // Putting a tool down shuts its panel with it: every control in there is
  // about a line that is no longer being drawn. Taking one UP opens its panel,
  // the way arming the cut plane does -- the tool's own Apply lives in there,
  // and a cut you could draw but not fire would be the panel nobody found.
  //
  // MOVE HAS NO PANEL, so it counts as putting the cutter down: it is a tool
  // with nothing to aim, and leaving the last cutter's panel standing open over
  // a block you are now dragging pictures about would be a lid with no button
  // under it.
  setLaserTool: (laserTool) =>
    set((s) => ({
      laserTool,
      openPanel: isCutTool(laserTool)
        ? laserTool
        : s.openPanel === 'freehand' || s.openPanel === 'points'
          ? null
          : s.openPanel,
    })),
  setFreehandSmoothing: (freehandSmoothing) =>
    set({ freehandSmoothing: clamp(freehandSmoothing, 0, 1) }),
  setFitCurve: (fitCurve) => set({ fitCurve }),
  setStockOpen: (stockOpen) => set({ stockOpen }),
  // Clamped in `latheView`, so the range is written down once beside the frame
  // that has to honour it rather than here and there again.
  zoomLathe: (factor) => set((s) => ({ latheZoom: clampZoom(s.latheZoom * factor) })),
  setLatheZoom: (zoom) => set({ latheZoom: clampZoom(zoom) }),
  setPushReach: (reach) => set({ pushReach: clamp(reach, BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX) }),
  setPushSizeUnit: (pushSizeUnit) => set({ pushSizeUnit }),
  setPushStrength: (strength) => set({ pushStrength: clamp(strength, 0, 1) }),
  setPullReach: (reach) => set({ pullReach: clamp(reach, BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX) }),
  setPullSizeUnit: (pullSizeUnit) => set({ pullSizeUnit }),
  setPullStrength: (strength) => set({ pullStrength: clamp(strength, 0, 1) }),
  setSmoothReach: (reach) => set({ smoothReach: clamp(reach, BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX) }),
  setSmoothSizeUnit: (smoothSizeUnit) => set({ smoothSizeUnit }),
  setSmoothStrength: (strength) => set({ smoothStrength: clamp(strength, 0, 1) }),
  setHollowSizeUnit: (hollowSizeUnit) => set({ hollowSizeUnit }),

  // Arming lays a ruler down rather than arming an empty tool: a switch that
  // turns on and shows nothing reads as broken, and "give me a ruler" is the
  // whole of what pressing this button ever means. Re-arming after every ruler
  // has been deleted takes the same branch, so the tool is never on and empty.
  //
  // Disarming keeps them. They are measurements of a scene that has not
  // changed, and the one thing that must not happen is a stray click on the
  // switch throwing away work that took two snapped ends to place. The
  // selection goes, though -- a gizmo hanging over a ruler nobody can see
  // would be a handle onto nothing.
  setRulerActive: (on, frame) =>
    set((s) => {
      if (!on) return { rulerActive: false, selectedRuler: null }
      if (s.rulers.length > 0) return { rulerActive: true }
      const ruler = makeRuler(frame)
      return {
        rulerActive: true,
        rulers: [ruler],
        selectedRuler: { id: ruler.id, end: 0 },
      }
    }),

  // Selected as it lands, so the ruler you just asked for is the one carrying
  // the handles -- and armed with it, since adding one from the panel while the
  // tool is off would otherwise put a ruler in a list nothing draws.
  addRuler: (frame) =>
    set((s) => {
      const ruler = makeRuler(frame)
      return {
        rulerActive: true,
        rulers: [...s.rulers, ruler],
        selectedRuler: { id: ruler.id, end: 0 },
      }
    }),

  removeRuler: (id) =>
    set((s) => ({
      rulers: s.rulers.filter((r) => r.id !== id),
      // A selection pointing at a ruler that no longer exists would leave the
      // gizmo drawn at the last place it stood, grabbable, writing to nothing.
      selectedRuler: s.selectedRuler?.id === id ? null : s.selectedRuler,
    })),

  selectRuler: (selection) => set({ selectedRuler: selection }),

  setRulerEnd: (id, end, position) =>
    set((s) => ({
      rulers: s.rulers.map((r) => {
        if (r.id !== id) return r
        // Rebuilt as a fresh pair rather than written through: what draws the
        // line is memoised on the array it came from, and an end mutated in
        // place would move with nothing noticing it had.
        const ends: [Vec3, Vec3] =
          end === 0 ? [position, r.ends[1]] : [r.ends[0], position]
        return { ...r, ends }
      }),
    })),

  noteRecentColor: (color) =>
    set((s) => ({
      // Filtered first, then unshifted: re-using a colour should move it back
      // to the front, not push a second copy of it in and cost a slot.
      recentColors: [color, ...s.recentColors.filter((c) => c !== color)].slice(
        0,
        RECENT_COLOR_SLOTS
      ),
    })),
}))

/**
 * What the armed brush is set to, whichever brush that is -- or `null` when
 * neither is up.
 *
 * THE ONE PLACE THAT KNOWS WHICH DIALS TO READ. Four things need the answer on
 * every frame of a stroke -- the ghost that draws the sphere, the spacing that
 * decides when the next dab lands, the dab itself, and the hint along the
 * bottom of the viewport -- and each of them writing its own
 * `brushTool === 'torch' ? erodeRadius : sculptRadius` is four chances for the
 * ghost to promise one brush and the stroke to lay down another. It has to be
 * asked imperatively inside a frame loop, so it takes the state rather than
 * being a hook.
 *
 * `raise` travels with the numbers rather than being re-derived from the mode
 * at the far end, because it is the same fact: it is what makes these three
 * numbers a description of one brush rather than of a size, a force and a
 * smoothing that could belong to either.
 */
/**
 * Is a DOCUMENT on screen?
 *
 * A selector rather than `screen === 'modelling'` written into each of the six
 * controls that need it. Every one of them -- Import, Export, Snap, undo, redo,
 * the counts -- is asking the same question, which is not "which screen is
 * this" but "is there a scene here for me to act on", and the day a third
 * screen arrives it is answered for that one by the table in `screens.ts`
 * rather than by six more clauses.
 */
export const onDocument = (s: ToolState): boolean => SCREEN_HAS_DOCUMENT[s.screen]

/**
 * Is there anything HERE for a snap to catch?
 *
 * The question Snap itself is asking, and it stopped being the same question as
 * `onDocument` the moment the laser cutter's knots learned to line up with each
 * other. A drag does not need a document to be worth aiming -- see
 * `SCREEN_SNAPS`, which is where the answer lives so that the day a fourth
 * screen arrives it is answered there rather than here.
 */
export const snapsHere = (s: ToolState): boolean => SCREEN_SNAPS[s.screen]

/**
 * The tool in the user's hand and its two dials, gathered.
 *
 * The lathe half of `armedBrush` below, and read the same way: with
 * `getState()` at the moment of a press or a frame, never as a hook selector.
 * It builds a fresh object every call, so subscribing a component to it would
 * hand React a new snapshot on every render and never settle. Hands back `null`
 * when the hands are empty, so a caller asks one question rather than three.
 */
export type ArmedLatheTool = { tool: ClayTool; reach: number; strength: number }

export const armedLatheTool = (s: ToolState): ArmedLatheTool | null => {
  if (s.latheTool === 'push') {
    return { tool: 'push', reach: s.pushReach, strength: s.pushStrength }
  }
  if (s.latheTool === 'pull') {
    return { tool: 'pull', reach: s.pullReach, strength: s.pullStrength }
  }
  if (s.latheTool === 'smooth') {
    return { tool: 'smooth', reach: s.smoothReach, strength: s.smoothStrength }
  }
  return null
}

export type ArmedBrush = {
  radius: number
  /** How far one dab moves the surface, 0..1: Heat, or Strength. Zero for the
   *  Smoother, which moves nothing of its own. */
  force: number
  smooth: number
  /** Up rather than down -- the sculpt tool. See `ErodeDab.raise`. */
  raise: boolean
  /**
   * The radius corners are driven to, as a share of `radius` -- the Smoother,
   * and `null` for the two brushes that have no such thing.
   *
   * It travels with the numbers rather than being re-derived at the far end for
   * the reason `raise` does: it is what makes these a description of ONE brush
   * rather than of a size, a force and a smoothing that could belong to any of
   * the three.
   */
  round: number | null
}

export function armedBrush(s: ToolState): ArmedBrush | null {
  if (s.brushTool === 'torch') {
    return {
      radius: s.erodeRadius,
      force: s.erodeHeat,
      smooth: s.erodeSmooth,
      raise: false,
      round: null,
    }
  }
  if (s.brushTool === 'sculpt') {
    return {
      radius: s.sculptRadius,
      force: s.sculptStrength,
      smooth: s.sculptSmooth,
      raise: true,
      round: null,
    }
  }
  if (s.brushTool === 'smoother') {
    // Zero force and zero flow, honestly rather than as placeholders: this
    // brush neither bites nor pours. Everything it does is in `round`.
    return {
      radius: s.smootherRadius,
      force: 0,
      smooth: 0,
      raise: false,
      round: s.smootherStrength,
    }
  }
  return null
}
