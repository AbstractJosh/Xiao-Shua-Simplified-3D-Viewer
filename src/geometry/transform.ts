import { Euler, Matrix4, Quaternion, Ray, Vector3 } from 'three'
import type { ObjectTransform } from './types'

/**
 * The bridge between OBJECT-LOCAL space -- where every anchor, feature and cut
 * plane is stored -- and world space, where picking and snapping happen.
 *
 * Everything here is rigid: rotation then translation, never scale. That is
 * deliberate. A scaled transform would make a stored anchor's parameter space
 * disagree with the geometry it was measured against, and sketches would drift
 * off their faces the moment an object was resized.
 */

const UNIT_SCALE = new Vector3(1, 1, 1)

function quaternionOf(t: ObjectTransform): Quaternion {
  return new Quaternion().setFromEuler(
    new Euler(t.rotation[0], t.rotation[1], t.rotation[2], 'XYZ')
  )
}

export function objectMatrix(t: ObjectTransform): Matrix4 {
  return new Matrix4().compose(
    new Vector3(t.position[0], t.position[1], t.position[2]),
    quaternionOf(t),
    UNIT_SCALE
  )
}

export function objectMatrixInverse(t: ObjectTransform): Matrix4 {
  return objectMatrix(t).invert()
}

export function toWorldPoint(t: ObjectTransform, p: Vector3): Vector3 {
  return p.clone().applyMatrix4(objectMatrix(t))
}

export function toLocalPoint(t: ObjectTransform, p: Vector3): Vector3 {
  return p.clone().applyMatrix4(objectMatrixInverse(t))
}

/** Directions ignore the translation, so normals stay normals. */
export function toWorldDir(t: ObjectTransform, d: Vector3): Vector3 {
  return d.clone().applyQuaternion(quaternionOf(t))
}

export function toLocalDir(t: ObjectTransform, d: Vector3): Vector3 {
  return d.clone().applyQuaternion(quaternionOf(t).invert())
}

/**
 * Analytic raycasts run against the untransformed primitive, so the ray comes
 * to it rather than the other way round. The direction is re-normalised because
 * callers hand us rays built from unnormalised screen deltas, and a surface's
 * `t` values are meaningless against a direction of the wrong length.
 */
export function toLocalRay(t: ObjectTransform, ray: Ray): Ray {
  return new Ray(
    toLocalPoint(t, ray.origin),
    toLocalDir(t, ray.direction).normalize()
  )
}
