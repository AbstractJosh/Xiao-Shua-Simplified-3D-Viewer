import { useMemo } from 'react'
import type { RefObject } from 'react'
import { Matrix4, Quaternion, Vector3 } from 'three'
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

/** The two the sketch can slide along, and the one it sweeps along. */
const SKETCH_AXES = [0, 1, 2] as const
const NORMAL_AXIS = [2] as const

/**
 * The gizmo on a selected sketch: two arrows across the surface, and a third
 * facing away from it.
 *
 * The first two are the outline's OWN axes -- a rectangle's width and height --
 * and the third is the surface normal, which is the one direction a sketch
 * cannot move along and the one it can sweep along. So the third arrow has no
 * slide: both buttons on it drag the feature's depth, out of the face for a
 * boss and back through it for a pocket, which is the same signed number the
 * Extrude slider writes.
 *
 * The frame is turned by the sketch's OWN rotation, not left on the surface's
 * raw U and V. That is what makes the stretch in Scale honest: it resizes the
 * outline along the arrow it was grabbed on, and on a rectangle spun 30 degrees
 * the width axis is spun with it. It pays off in Move too -- the arrows lie
 * along the edges of the shape being dragged rather than crossing them
 * diagonally -- and it costs only a decomposition of the travel back into the
 * surface's u and v, which is what a slide is stored in.
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

  // The frame solve is cheap but runs on every frame of a drag; the anchor and
  // the spin are the only things it depends on.
  const placement = useMemo(() => {
    const frame = hostSurfaceFor(object.base, feature.anchor).frame(feature.anchor)
    const position: Vec3 = [frame.origin.x, frame.origin.y, frame.origin.z]
    // uDir, vDir and normal are orthonormal by construction, so they ARE the
    // columns of a rotation: the gizmo's local +X becomes the surface's U, its
    // +Y becomes V, and its +Z the normal the third arrow points along.
    const basis = new Matrix4().makeBasis(frame.uDir, frame.vDir, frame.normal)
    // Then spun about that normal by the outline's own rotation, which is what
    // `sampleOutline` turns the shape by -- so local +X lands on the outline's
    // own first axis rather than on the surface's.
    const quaternion = new Quaternion()
      .setFromRotationMatrix(basis)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), feature.rotation))
    return { position, quaternion }
  }, [object.base, feature.anchor, feature.rotation])

  return (
    <TransformGizmo
      position={placement.position}
      quaternion={placement.quaternion}
      axes={[...SKETCH_AXES]}
      sizeOnlyAxes={[...NORMAL_AXIS]}
      colors={SKETCH_AXIS_COLORS}
      // Scale gives it the ring, which sizes the outline about its own centre,
      // and the two tangent arrows, which stretch it one dimension at a time --
      // a rectangle has a width and a height, and on a circle or a polygon,
      // which have one radius between them, both arrows drive that instead.
      sizable
      // ONE ring in Rotate, facing the viewer, rather than the ball of three.
      // A sketch spins in the surface it lies on and nowhere else, so there is
      // no axis to choose: two of the three rings would be handles for turns
      // the document cannot write down.
      turns="facing"
      // No plane quads. A sketch is anchored to a surface and slides in that
      // surface's own u and v, so there is no such thing as moving it through
      // the world's XZ plane -- and its two tangent arrows already ARE the two
      // directions it can go.
      planes={false}
      size={SKETCH_SCALE}
      controlsRef={controlsRef}
      onGrab={(handle) => startSketchGizmo(object.id, feature.id, handle)}
    />
  )
}
