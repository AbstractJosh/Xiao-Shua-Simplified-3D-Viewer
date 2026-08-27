import { create } from 'zustand'
import { Euler, Vector3 } from 'three'
import { DEFAULT_SNAP_DISTANCE } from '../geometry/snap'
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
export type NavPanel = 'snap' | 'units' | 'export' | 'help' | null

/** The panels that hang off buttons INSIDE the tool island. */
export const ISLAND_PANELS: NavPanel[] = ['snap', 'units']

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

const DEFAULT_CUT_PLANE: CutPlaneState = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  size: 4,
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

export type ToolState = {
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
  /** Record a colour as just used, moving it to the front if it is already
   *  there rather than letting the shelf fill with one repeated swatch. */
  noteRecentColor: (color: string) => void
}

export const useTools = create<ToolState>((set) => ({
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
