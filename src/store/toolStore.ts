import { create } from 'zustand'
import { Euler, Vector3 } from 'three'
import { DEFAULT_SNAP_DISTANCE } from '../geometry/snap'
import { fromDisplay } from '../units'
import type { UnitMode } from '../units'
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
export type NavPanel = 'snap' | 'units' | 'ruler' | 'export' | 'help' | null

/**
 * The panels that hang off buttons INSIDE the tool island, which go off screen
 * with it when it is collapsed.
 *
 * Down to one. `units` went to the bar first and `snap` followed it, and
 * neither collapses with anything now -- the bar is always there. The ruler
 * list is the only panel left over the scene.
 */
export const ISLAND_PANELS: NavPanel[] = ['ruler']

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
 * Bounds on the plane, shared by the panel that types them and the gizmo that
 * drags them. The position limit used to be the Position slider's range and
 * nothing else; now that the slider is gone and the gizmo is the only way to
 * place the plane, it is the one thing keeping a blade from being dragged out
 * past the scene and lost off screen.
 */
export const CUT_POSITION_LIMIT = 50
export const CUT_SIZE_MIN = 0.05
export const CUT_SIZE_MAX = 80

/** Twice the span a fresh solid lands at, so the blade overhangs the thing it
 *  is about to sever rather than ending somewhere inside it. */
const DEFAULT_CUT_PLANE: CutPlaneState = {
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
 */
export type TransformMode = 'move' | 'rotate' | 'scale'

export type ToolState = {
  /** Which gizmo the viewport is showing. See `TransformMode`. */
  transformMode: TransformMode
  snap: boolean
  snapDistance: number
  /** Which unit lengths are SHOWN in. Purely a display choice: nothing in the
   *  document or the geometry changes with it. */
  displayUnit: UnitMode
  cutActive: boolean
  cutPlane: CutPlaneState
  openPanel: NavPanel
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
  setSnap: (on: boolean) => void
  setSnapDistance: (d: number) => void
  setDisplayUnit: (unit: UnitMode) => void
  setCutActive: (on: boolean) => void
  setCutPlane: (patch: Partial<CutPlaneState>) => void
  resetCutPlane: () => void
  setOpenPanel: (panel: NavPanel) => void
  setIslandCollapsed: (collapsed: boolean) => void
  setIslandPlacement: (placement: IslandPlacement) => void
  setEraseScope: (scope: EraseScope) => void
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
  snap: true,
  snapDistance: DEFAULT_SNAP_DISTANCE,
  // `auto` by default: it reads correctly for a 2 mm boss and a 4 m wall alike,
  // which a fixed unit cannot do across the range the app now allows.
  displayUnit: 'auto',
  cutActive: false,
  cutPlane: DEFAULT_CUT_PLANE,
  openPanel: null,
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
  // Empty, not seeded with a starter palette: every slot on screen is a colour
  // this user actually chose, so the grid is a history rather than a suggestion.
  recentColors: [],

  // Nothing measured until asked for. The first click on the tool is what lays
  // a ruler down, so the button is never a switch with nothing behind it.
  rulerActive: false,
  rulers: [],
  selectedRuler: null,

  setTransformMode: (transformMode) => set({ transformMode }),

  setSnap: (on) => set({ snap: on }),
  setSnapDistance: (d) => set({ snapDistance: Math.max(0, d) }),
    setDisplayUnit: (displayUnit) => set({ displayUnit }),

  // Leaving the tool rearms it, so the next cut starts from a predictable plane
  // rather than wherever the previous one happened to be dragged to. Arming it
  // opens nothing: the console panels it drives are already on screen, and they
  // reveal themselves from `cutActive` alone.
  setCutActive: (on) =>
    set(on ? { cutActive: true } : { cutActive: false, cutPlane: DEFAULT_CUT_PLANE }),

  setCutPlane: (patch) => set((s) => ({ cutPlane: { ...s.cutPlane, ...patch } })),
  resetCutPlane: () => set({ cutPlane: DEFAULT_CUT_PLANE }),

  // One panel at a time: they hang over the same viewport and would overlap.
  setOpenPanel: (panel) => set({ openPanel: panel }),

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
