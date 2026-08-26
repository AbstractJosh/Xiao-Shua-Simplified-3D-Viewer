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

  setSnap: (on: boolean) => void
  setSnapDistance: (d: number) => void
  setCutActive: (on: boolean) => void
  setCutPlane: (patch: Partial<CutPlaneState>) => void
  resetCutPlane: () => void
}

export const useTools = create<ToolState>((set) => ({
  snap: true,
  snapDistance: DEFAULT_SNAP_DISTANCE,
  cutActive: false,
  cutPlane: DEFAULT_CUT_PLANE,

  setSnap: (on) => set({ snap: on }),
  setSnapDistance: (d) => set({ snapDistance: Math.max(0, d) }),

  setCutActive: (on) =>
    // Leaving the tool rearms it: the next cut starts from a predictable plane
    // rather than wherever the previous one happened to be dragged to.
    set(on ? { cutActive: true } : { cutActive: false, cutPlane: DEFAULT_CUT_PLANE }),

  setCutPlane: (patch) => set((s) => ({ cutPlane: { ...s.cutPlane, ...patch } })),
  resetCutPlane: () => set({ cutPlane: DEFAULT_CUT_PLANE }),
}))
