import { Plane, Raycaster, Vector2, Vector3 } from 'three'
import type { Camera } from 'three'
import { BLOCK_HALF, KERF, faceBasis, faceToBlock } from '../geometry/laserCut'
import type { FaceAxis, Pt } from '../geometry/laserCut'
import { pixelsToWorld } from './orthoFrame'

/**
 * THE POINTER, AS A PLACE ON THE FACE -- and the way back out again.
 *
 * Two functions and a scratchpad, lifted out of `CutLayer` the moment a second
 * thing on this screen needed them. The cut layer reads a press to put a line
 * down; `MirrorLayer` reads one to swing an axis and to say which part of the
 * face is being worked in. That is the same question asked twice, and asked of
 * a camera that has settled square on to a known plane -- so a second copy of
 * the arithmetic would be two answers that agree until the day one of them is
 * fixed.
 *
 * IT DOES ITS OWN PICKING, with a `Raycaster` against a plane, rather than
 * hanging `onPointerDown` off a mesh -- the reasoning is set out at the top of
 * `CutLayer` and none of it is about lines: the face has holes in it where cuts
 * have already been, the pointer has to go on meaning something past the
 * silhouette, and which plane it is was settled by the compass rather than by
 * the scene.
 *
 * EVERYTHING IS IN BLOCK SPACE going in and coming out: the unit cube centred
 * on the origin, scaled by the three sides and lifted so the block stands on
 * the bed. Inverting that is the whole of what is here.
 */

/** Scratch, reused rather than allocated: these run on every pointer move. */
const RAY = new Raycaster()
const NDC = new Vector2()
const PLANE = new Plane()
const HIT = new Vector3()
const PROJECTED = new Vector3()

/** A hair off the face, so a mark sits ON the block rather than fighting it
 *  for the same depth. Well under the kerf, so it never reads as floating. */
export const LIFT = KERF

/** Where the block's middle stands in the world: on the bed, half its height
 *  up. The one fact both directions have to agree about. */
const anchor = (dims: [number, number, number]) => new Vector3(0, dims[1] / 2, 0)

/**
 * Where a pointer event lands on the face, in that face's own (u, v) -- or null
 * when the ray runs parallel to it, which only a camera that has left its axis
 * can manage.
 */
export function pointerToFace(
  e: { clientX: number; clientY: number },
  camera: Camera,
  el: HTMLElement,
  face: FaceAxis,
  dims: [number, number, number]
): Pt | null {
  const rect = el.getBoundingClientRect()
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  NDC.set(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -(((e.clientY - rect.top) / rect.height) * 2 - 1)
  )
  RAY.setFromCamera(NDC, camera)

  const basis = faceBasis(face)
  const centre = anchor(dims).addScaledVector(basis.n, BLOCK_HALF * dims[face.axis])
  PLANE.setFromNormalAndCoplanarPoint(basis.n, centre)
  if (!RAY.ray.intersectPlane(PLANE, HIT)) return null

  const local = HIT.clone().sub(anchor(dims)).divide(new Vector3(dims[0], dims[1], dims[2]))
  return [local.dot(basis.u), local.dot(basis.v)]
}

/** How far a face point lands from the pointer, in pixels. */
export function facePixelsFrom(
  at: Pt,
  e: { clientX: number; clientY: number },
  camera: Camera,
  el: HTMLElement,
  face: FaceAxis,
  dims: [number, number, number]
): number {
  const basis = faceBasis(face)
  PROJECTED.copy(faceToBlock(basis, at, BLOCK_HALF + LIFT))
    .multiply(new Vector3(dims[0], dims[1], dims[2]))
    .add(anchor(dims))
    .project(camera)
  const rect = el.getBoundingClientRect()
  const x = rect.left + ((PROJECTED.x + 1) / 2) * rect.width
  const y = rect.top + ((1 - PROJECTED.y) / 2) * rect.height
  return Math.hypot(x - e.clientX, y - e.clientY)
}

/**
 * How much world one step along a face direction is worth on this block.
 *
 * THE BLOCK'S OWN STRETCH, which is what stops a diagonal being measured
 * wrongly on stock that is not a cube: face coordinates are fractions of each
 * side, so a step of a given length means different amounts of world depending
 * which way it points. `ribbon` does this same division to keep a drawn line
 * one width all the way along; here it is what lets a distance in face
 * coordinates be compared against a reach in pixels.
 */
export function faceStretch(dir: Pt, face: FaceAxis, dims: [number, number, number]): number {
  const basis = faceBasis(face)
  const along = (axis: Vector3) =>
    Math.abs(axis.x) * dims[0] + Math.abs(axis.y) * dims[1] + Math.abs(axis.z) * dims[2]
  return Math.hypot(dir[0] * along(basis.u), dir[1] * along(basis.v))
}

/** A distance in face coordinates along `dir`, in pixels on screen. */
export function facePixels(
  distance: number,
  dir: Pt,
  face: FaceAxis,
  dims: [number, number, number],
  zoom: number
): number {
  const world = distance * faceStretch(dir, face, dims)
  const perPixel = pixelsToWorld(1, zoom)
  return perPixel > 0 ? world / perPixel : Infinity
}
