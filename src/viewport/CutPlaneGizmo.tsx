import { useMemo } from 'react'
import type { RefObject } from 'react'
import { Line } from '@react-three/drei'
import { DoubleSide, Vector3, type Object3D } from 'three'
import { useDoc } from '../store/docStore'
import { useTools } from '../store/toolStore'
import { useSceneColors } from './useSceneColors'
import { TransformGizmo } from './TransformGizmo'

/**
 * The quad below is a three.js plane -- which faces +Z -- turned -PI/2 about X,
 * so its face normal is the local +Y that `cutPlaneNormal` reads. Drawing and
 * cutting therefore cannot drift apart: both sides of that agreement come from
 * the one function, which is why it lives with the tool state rather than here.
 */

/**
 * Decoration only. Without this the translucent quad sits between the pointer
 * and the very solid it is about to sever, swallowing the clicks that select
 * and drag objects underneath it.
 */
const noRaycast: Object3D['raycast'] = () => {}

/**
 * The square plane the user aims with the Tools panel's XYZ position and tilt.
 *
 * Translucent and double-sided with no depth write, so it reads as a blade
 * passing through the scene rather than a slab parked in front of it -- and so
 * the object it is about to cut stays visible while it is being aimed. The
 * outline gives the finite square a readable edge; the arrow shows which way
 * the normal points, which matters because the two halves are not
 * interchangeable -- each keeps its own side of this plane.
 */
export function CutPlaneGizmo({
  controlsRef,
}: {
  controlsRef: RefObject<{ enabled: boolean } | null>
}) {
  // styles.css --danger, per theme, mirrored in `sceneColors` and guarded by
  // `ui-check` -- a three material cannot read a CSS custom property.
  const CUT_COLOR = useSceneColors().danger
  const cutActive = useTools((s) => s.cutActive)
  const plane = useTools((s) => s.cutPlane)
  const startCutGizmo = useDoc((s) => s.startCutGizmo)

  // Rebuilt only when the extent changes: nudging position or tilt moves the
  // group, and drei's Line rebuilds its GPU buffers whenever `points` changes
  // identity -- which, during a slider drag, would be every frame.
  const { border, shaft, headY, headHeight, headRadius } = useMemo(() => {
    const half = plane.size / 2
    const arrow = Math.max(0.5, plane.size * 0.18)
    const hh = arrow * 0.4
    return {
      // Local XZ, the quad's own plane. Closed, or the fourth edge is missing.
      border: [
        new Vector3(-half, 0, -half),
        new Vector3(half, 0, -half),
        new Vector3(half, 0, half),
        new Vector3(-half, 0, half),
        new Vector3(-half, 0, -half),
      ],
      shaft: [new Vector3(0, 0, 0), new Vector3(0, arrow, 0)],
      headY: arrow + hh / 2,
      headHeight: hh,
      headRadius: hh * 0.42,
    }
  }, [plane.size])

  if (!cutActive) return null

  return (
    <>
      {/* The plane is aimed with the same arrows as an object, which is why the
          Position fields are gone from the panel: two ways to set one number,
          one of them a slider you cannot see the effect of without looking
          away. Tilt stays typed -- an angle is far easier to dial in than to
          drag, and the tilt is what decides which way the halves fall.
          NO rotation is passed, so the arrows and the ring stand in the world,
          exactly as they do for a selected object: a tilted blade is nudged
          along the same X, Y and Z everything else in the scene is measured
          in, and it turns about those too rather than about axes the last turn
          has already moved. The quad below still carries the tilt -- it is the
          blade -- so the green arrow is no longer the normal.
          Scale gives the plane its ring and no arrows: a plane has no per-axis
          extent, and its one dimension -- the guide square -- is what the ring
          sizes. That falls out of `sizable`, which is why the gizmo needs no
          case for the plane. */}
      <TransformGizmo
        position={plane.position}
        sizable={false}
        controlsRef={controlsRef}
        onGrab={startCutGizmo}
      />

    <group position={plane.position} rotation={plane.rotation}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={noRaycast}>
        <planeGeometry args={[plane.size, plane.size]} />
        <meshBasicMaterial
          color={CUT_COLOR}
          transparent
          opacity={0.16}
          side={DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* Coplanar with the quad, but the quad writes no depth, so there is
          nothing for these to fight with -- no lift needed. */}
      <Line points={border} color={CUT_COLOR} lineWidth={2} transparent depthWrite={false} raycast={noRaycast} />
      <Line points={shaft} color={CUT_COLOR} lineWidth={2} transparent depthWrite={false} raycast={noRaycast} />

      {/* A cone's apex is its +Y end, so the head already points along the
          normal without any extra rotation. */}
      <mesh position={[0, headY, 0]} raycast={noRaycast}>
        <coneGeometry args={[headRadius, headHeight, 12]} />
        <meshBasicMaterial color={CUT_COLOR} transparent opacity={0.85} depthWrite={false} />
      </mesh>
    </group>
    </>
  )
}
