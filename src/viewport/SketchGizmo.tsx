import { useMemo } from 'react'
import type { RefObject } from 'react'
import { Matrix4, Quaternion } from 'three'
import { hostSurfaceFor } from '../geometry/surfaces'
import type { Feature, SceneObject, Vec3 } from '../geometry/types'
import { useDoc } from '../store/docStore'
import { SKETCH_AXIS_COLORS } from './axisColors'
import { TransformGizmo } from './TransformGizmo'

/**
 * Smaller than the object gizmo. A sketch is a detail ON a solid, and a gizmo
 * that reached as far as the one moving the whole object would say the two
 * gestures were the same size of act.
 */
const SKETCH_SCALE = 0.62

/** The two tangents, drawn as the gizmo's first two arrows. */
const TANGENT_AXES = [0, 1] as const

/**
 * The gizmo on a selected sketch: two arrows, along the surface's own U and V.
 *
 * Two rather than three because that is all a projection has. A sketch lives in
 * its host surface's parameter space -- that is what lets it survive the solid
 * being resized -- so the only moves that mean anything are the two across that
 * surface. A third arrow, off the face, would have nothing to write.
 *
 * The arrows follow the surface, not the world: on a box face they lie in the
 * face, and on a sphere they lie in the tangent plane at the sketch and swing
 * round as it is dragged. `TransformGizmo` takes them as a quaternion because
 * that is what a tangent frame gives -- three vectors, never three angles.
 */
export function SketchGizmo({
  object,
  feature,
  controlsRef,
}: {
  object: SceneObject
  feature: Feature
  controlsRef: RefObject<{ enabled: boolean } | null>
}) {
  const startSketchGizmo = useDoc((s) => s.startSketchGizmo)

  // The frame solve is cheap but runs on every frame of a drag; the anchor is
  // the only thing it depends on.
  const placement = useMemo(() => {
    const frame = hostSurfaceFor(object.base, feature.anchor).frame(feature.anchor)
    const position: Vec3 = [frame.origin.x, frame.origin.y, frame.origin.z]
    // uDir, vDir and normal are orthonormal by construction, so they ARE the
    // columns of a rotation: the gizmo's local +X becomes the surface's U, its
    // +Y becomes V, and the arrows it draws for axes 0 and 1 land on the two
    // directions the sketch can actually move in.
    const basis = new Matrix4().makeBasis(frame.uDir, frame.vDir, frame.normal)
    return { position, quaternion: new Quaternion().setFromRotationMatrix(basis) }
  }, [object.base, feature.anchor])

  return (
    <TransformGizmo
      position={placement.position}
      quaternion={placement.quaternion}
      axes={[...TANGENT_AXES]}
      colors={SKETCH_AXIS_COLORS}
      // The ring scales the outline about its own centre on the left button
      // and spins it on the right -- the same split the object gizmo uses. No
      // right-drag on the ARROWS though: a sketch has no per-axis extent to
      // stretch, so its two directions mean nothing but movement.
      sizable={false}
      size={SKETCH_SCALE}
      controlsRef={controlsRef}
      onGrab={(handle) => startSketchGizmo(object.id, feature.id, handle)}
    />
  )
}
