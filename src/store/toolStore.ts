import { create } from 'zustand'
import { Euler, Vector3 } from 'three'
import { DEFAULT_SNAP_DISTANCE } from '../geometry/snap'
import type { Vec3 } from '../geometry/types'

/**
 * Tool state is deliberately OUTSIDE the doc. Snapping and the cut gizmo are
 * how you are working, not what you have built, so toggling snap or nudging the
 * cut plane must never land in undo history -- otherwise a user hunting for the
 * edit they want to reverse has to walk back through their own tool fiddling.
 */

/**
 * Which nav-bar panel is open, if any.
 *
 * Chrome rather than geometry, but it lives here so the whole bar is a pure
 * function of store state and a headless render can drive it exactly the way a
 * click does. The cut plane used to have a panel of its own; its controls are
 * in the console now, because a popover hanging off the toolbar covered the
 * only thing a plane can be aimed against.
 */
export type NavPanel = 'snap' | 'export' | 'help' | null

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
export const CUT_POSITION_LIMIT = 6
export const CUT_SIZE_MIN = 1
export const CUT_SIZE_MAX = 12

const DEFAULT_CUT_PLANE: CutPlaneState = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  size: 4,
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
  cutActive: boolean
  cutPlane: CutPlaneState
  openPanel: NavPanel
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
  setCutActive: (on: boolean) => void
  setCutPlane: (patch: Partial<CutPlaneState>) => void
  resetCutPlane: () => void
  setOpenPanel: (panel: NavPanel) => void
  setEraseScope: (scope: EraseScope) => void
  /** Record a colour as just used, moving it to the front if it is already
   *  there rather than letting the shelf fill with one repeated swatch. */
  noteRecentColor: (color: string) => void
}

export const useTools = create<ToolState>((set) => ({
  snap: true,
  snapDistance: DEFAULT_SNAP_DISTANCE,
  cutActive: false,
  cutPlane: DEFAULT_CUT_PLANE,
  openPanel: null,
  // Every object, because an eraser you have positioned inside something is an
  // eraser you meant to cut that something with. Narrowing is the deliberate
  // act, and it costs one click on the switch.
  eraseScope: 'all',
  // Empty, not seeded with a starter palette: every slot on screen is a colour
  // this user actually chose, so the grid is a history rather than a suggestion.
  recentColors: [],

  setSnap: (on) => set({ snap: on }),
  setSnapDistance: (d) => set({ snapDistance: Math.max(0, d) }),

  // Leaving the tool rearms it, so the next cut starts from a predictable plane
  // rather than wherever the previous one happened to be dragged to. Arming it
  // opens nothing: the console panels it drives are already on screen, and they
  // reveal themselves from `cutActive` alone.
  setCutActive: (on) =>
    set(on ? { cutActive: true } : { cutActive: false, cutPlane: DEFAULT_CUT_PLANE }),

  setCutPlane: (patch) => set((s) => ({ cutPlane: { ...s.cutPlane, ...patch } })),
  resetCutPlane: () => set({ cutPlane: DEFAULT_CUT_PLANE }),

  // One panel at a time: they all hang off the same bar and would overlap.
  setOpenPanel: (panel) => set({ openPanel: panel }),

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
