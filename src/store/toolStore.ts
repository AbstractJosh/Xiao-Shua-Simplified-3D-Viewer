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
export type NavPanel = 'snap' | 'help' | null

/**
 * Which half of the console is on screen.
 *
 * The two halves are split by what they are FOR, not by what they contain:
 * `view` is everything that is true of the scene whatever is selected -- what
 * you can drop in, what you have saved, and what the scene now holds -- and
 * `edit` is the controls that only mean anything once something IS selected.
 * That is why the palettes sit with the scene tree rather than with the
 * dimension fields: dragging a solid in and reading the tree are both things
 * you do with no selection at all.
 *
 * Here beside `openPanel` for the same reason that one is: it is chrome rather
 * than geometry, but keeping it in a store is what lets a headless render drive
 * the console exactly the way a click does.
 */
export type ConsoleTab = 'view' | 'edit'

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

export type ToolState = {
  snap: boolean
  snapDistance: number
  cutActive: boolean
  cutPlane: CutPlaneState
  openPanel: NavPanel
  consoleTab: ConsoleTab

  setSnap: (on: boolean) => void
  setSnapDistance: (d: number) => void
  setCutActive: (on: boolean) => void
  setCutPlane: (patch: Partial<CutPlaneState>) => void
  resetCutPlane: () => void
  setOpenPanel: (panel: NavPanel) => void
  setConsoleTab: (tab: ConsoleTab) => void
}

export const useTools = create<ToolState>((set) => ({
  snap: true,
  snapDistance: DEFAULT_SNAP_DISTANCE,
  cutActive: false,
  cutPlane: DEFAULT_CUT_PLANE,
  openPanel: null,
  // Opens on the half that works with nothing selected, which is also the half
  // the first gesture of a session needs: drag a solid in from Solids.
  consoleTab: 'view',

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

  setConsoleTab: (tab) => set({ consoleTab: tab }),
}))
