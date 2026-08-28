import { create } from 'zustand'
import { Euler, Vector3 } from 'three'
import { BRUSH_SMOOTH_MIN } from '../geometry/erode'
import { DEFAULT_SNAP_DISTANCE } from '../geometry/snap'
import { fromDisplay } from '../units'
import { DEFAULT_HELP_SECTION } from '../helpTopics'
import type { HelpSectionId } from '../helpTopics'
import { DEFAULT_THEME } from '../theme'
import type { Theme } from '../theme'
import type { Unit, UnitMode } from '../units'
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
 * The cut plane used to have a panel of its own; its controls are in the
 * console now, because a popover hanging off the toolbar covered the only thing
 * a plane can be aimed against.
 */
export type NavPanel =
  | 'snap'
  | 'settings'
  | 'ruler'
  | 'export'
  | 'erode'
  | 'sculpt'
  | 'help'
  | null

/**
 * The panels that hang off buttons INSIDE the tool island, which go off screen
 * with it when it is collapsed.
 *
 * Three, and it is the CONTAINER that decides which: the ruler list and the two
 * brushes' numbers are the panels that hang off buttons over the scene. The
 * unit selector went to the bar first and `snap` followed it, and neither
 * collapses with anything now -- the bar is always there. (The units menu has
 * since become one group inside `settings`, which is a bar panel too.)
 *
 * A panel left off this list is one the island cannot shut: its button goes off
 * screen with the body and `openPanel` still names it, so the panel springs
 * back open the next time the island does, from a click nobody made. That is
 * exactly what the erode panel did between arriving in the island and being
 * added here.
 */
export const ISLAND_PANELS: NavPanel[] = ['ruler', 'erode', 'sculpt']

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
 * Which brush is in the user's hand, if either.
 *
 * ONE FIELD RATHER THAN TWO SWITCHES, and that is not a tidiness argument. The
 * blowtorch and the sculpt tool both claim the same gesture -- a plain left
 * press on a solid, dragged -- so "both armed" is not a state either of them
 * could act on; one of them would silently win, decided by whichever branch a
 * press happened to reach first. Held as a mode, the question cannot be asked:
 * arming one is choosing against the other, and no code has to enforce it. It
 * is the bargain `transformMode` already strikes for the three gizmos.
 *
 * The other tools stay independent booleans, because they genuinely are: a
 * ruler and an armed cut plane both being up is a scene with a measurement and
 * a blade in it, and neither takes the press off a solid.
 */
export type BrushTool = 'torch' | 'sculpt' | null

/**
 * What either brush may be sized to.
 *
 * The floor is a millimetre, which is the smallest feature this app can draw at
 * all; the ceiling is a quarter of the five-metre envelope, past which the
 * brush stops being a brush and becomes a way of deleting an object slowly.
 *
 * Shared, and so are the defaults below, because these are facts about the
 * BRUSH -- the sphere, the mesh under it, the range this app's solids live in
 * -- rather than about either tool. What is not shared is where each tool's
 * dials happen to be sitting: see `sculptRadius`.
 */
export const BRUSH_RADIUS_MIN = 0.01
export const BRUSH_RADIUS_MAX = 12.5

/**
 * How far the pointer travels between one dab and the next, as a fraction of
 * the brush radius.
 *
 * Either tool is a brush, so a stroke is a RUN of overlapping dabs rather than
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
/** Half force, so one pass is plainly a mark and a second pass plainly deepens
 *  it -- the rate is the thing that has to feel right, not the single dab. */
export const DEFAULT_BRUSH_FORCE = 0.5
/** Well over half, because the flow is the whole point of both tools: at low
 *  smoothing the torch sandblasts rather than melting, and the sculpt tool
 *  lays down a ridge with the facets still on it rather than a bead. */
export const DEFAULT_BRUSH_SMOOTH = 0.7

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
 * Eight, in two rows of four: enough that a scene built from a handful of
 * colours keeps all of them within reach, and few enough that the grid stays a
 * thing you recognise at a glance rather than a list you read. The slots are
 * drawn whether or not there is a colour in them, so the panel does not change
 * height as the shelf fills -- a control that grows under the pointer is a
 * control you miss.
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
 * ONE SETTING FOR BOTH BRUSHES, for the same reason. "Which solids am I working
 * on" is a fact about the job rather than about the tool in your hand, and
 * having to re-narrow it every time you swapped the torch for the sculpt tool
 * would be a way of melting the wrong object.
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
  snap: boolean
  snapDistance: number
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

  /** What either brush may touch. Shared -- see `BrushScope`. */
  brushScope: BrushScope

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
  setSnap: (on: boolean) => void
  setSnapDistance: (d: number) => void
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
  setBrushScope: (scope: BrushScope) => void
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
  // Move: the arrows and the plane quads, which is the gizmo this app had
  // before there was a choice to make.
  transformMode: 'move',
  // Handles ON. Selecting a solid and finding it wearing arrows is the app's
  // oldest behaviour, and it is the right default: the gizmo is how most people
  // do most things, and the ones who want it gone now have a way to say so.
  gizmoHidden: false,
  snap: true,
  snapDistance: DEFAULT_SNAP_DISTANCE,
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
  // Everything, matching the eraser's default and for the same reason: the
  // commonest thing to do with a brush is point it at something and pull, and
  // a tool that silently did nothing until you had also selected the right
  // solid would read as broken.
  brushScope: 'all',
  // Empty, not seeded with a starter palette: every slot on screen is a colour
  // this user actually chose, so the grid is a history rather than a suggestion.
  recentColors: [],

  // Nothing measured until asked for. The first click on the tool is what lays
  // a ruler down, so the button is never a switch with nothing behind it.
  rulerActive: false,
  rulers: [],
  selectedRuler: null,

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

  setSnap: (on) => set({ snap: on }),
  setSnapDistance: (d) => set({ snapDistance: Math.max(0, d) }),
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
  setCutActive: (on, spawn) =>
    set(
      on
        ? { cutActive: true, cutPlane: spawn ?? DEFAULT_CUT_PLANE }
        : { cutActive: false, cutPlane: DEFAULT_CUT_PLANE }
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

  setBrushScope: (scope) => set({ brushScope: scope }),

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
export type ArmedBrush = {
  radius: number
  /** How far one dab moves the surface, 0..1: Heat, or Strength. */
  force: number
  smooth: number
  /** Up rather than down -- the sculpt tool. See `ErodeDab.raise`. */
  raise: boolean
}

export function armedBrush(s: ToolState): ArmedBrush | null {
  if (s.brushTool === 'torch') {
    return {
      radius: s.erodeRadius,
      force: s.erodeHeat,
      smooth: s.erodeSmooth,
      raise: false,
    }
  }
  if (s.brushTool === 'sculpt') {
    return {
      radius: s.sculptRadius,
      force: s.sculptStrength,
      smooth: s.sculptSmooth,
      raise: true,
    }
  }
  return null
}
