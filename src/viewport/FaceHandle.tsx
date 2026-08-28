import { useEffect, useMemo } from 'react'
import type { RefObject } from 'react'
import { Line } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import { BufferGeometry, DoubleSide, Quaternion, Vector3 } from 'three'
import { hostSurfaceFor } from '../geometry/surfaces'
import {
  buildCapGeometry,
  endFaceCentre,
  endFaceFrame,
  endFaceRing,
  outlinePolyline,
} from '../geometry/prism'
import type { BaseSolid, Feature, SceneObject } from '../geometry/types'
import { shapeRadius } from '../geometry/types'
import { selectedObjectId as primarySelection, useDoc } from '../store/docStore'
import { useSceneColors } from './useSceneColors'

/** Lift off the created face; enough to clear z-fighting with the solid's cap. */
const HANDLE_LIFT = 0.004

const DISC_SEGMENTS = 24
/** CircleGeometry is built in the XY plane, so this is the disc's own normal. */
const DISC_AXIS = new Vector3(0, 0, 1)

/**
 * The disc is sized from the sketch so a tiny feature does not get a grab
 * target larger than the face it belongs to, but floored so that feature still
 * has something a pointer can find.
 */
const DISC_MIN = 0.003
const DISC_MAX = 0.6
const DISC_FRACTION = 0.35

type Handle = {
  fill: BufferGeometry | null
  outline: Vector3[]
  centre: Vector3
  orientation: Quaternion
  discRadius: number
}

/**
 * Everything the handle draws, from the same solve the solid runs.
 *
 * `endFaceRing` is authoritative on every host, curved ones included -- the
 * evaluator terminates the tool on exactly these points -- so the handle sits ON
 * the face instead of hovering near an independently guessed one.
 */
function buildHandle(base: BaseSolid, feature: Feature): Handle | null {
  const host = hostSurfaceFor(base, feature.anchor)
  const frame = endFaceFrame(host, feature.anchor, feature)
  if (!frame) return null

  const ring = endFaceRing(host, feature.anchor, feature)
  // An empty ring means the tilt drove the tool degenerate; the feature is
  // already reported as failed, and a handle on a face that does not exist
  // would invite the user to drag nothing.
  if (ring.length < 3) return null

  // Both helpers lift each point along its own normal. The created face is
  // planar by construction, so every point shares the plane's normal.
  const lifted = ring.map((position) => ({ position, normal: frame.normal }))
  const r = shapeRadius(feature.shape)

  return {
    fill: buildCapGeometry(lifted, HANDLE_LIFT),
    outline: outlinePolyline(lifted, HANDLE_LIFT),
    centre: endFaceCentre(ring).addScaledVector(frame.normal, HANDLE_LIFT),
    orientation: new Quaternion().setFromUnitVectors(DISC_AXIS, frame.normal),
    discRadius: Math.max(DISC_MIN, Math.min(DISC_MAX, r * DISC_FRACTION)),
  }
}

/**
 * The draggable end face of an extrusion: drag it to slide the created face
 * within its own plane, leaving the base welded to the surface so the pillar
 * leans over.
 *
 * Rendered inside the owning object's group, hence in object-local space.
 */
export function FaceHandle({
  object,
  feature,
  controlsRef,
}: {
  object: SceneObject
  feature: Feature
  controlsRef: RefObject<{ enabled: boolean } | null>
}) {
  const startMovingFace = useDoc((s) => s.startMovingFace)
  // Before the `!handle` return below: hooks cannot sit behind a condition.
  const scene = useSceneColors()
  const active = useDoc(
    (s) =>
      primarySelection(s) === object.id &&
      s.selectedFeatureId === feature.id &&
      // Either direction: a pocket has a floor to lean exactly as a boss has a
      // top, and only a flat projection has no created face at all.
      feature.depth !== 0
  )

  // Gated on `active` rather than filtered afterwards: this runs the same ring
  // solve the evaluator does, and a scene full of features would pay for it on
  // every render for the sake of one visible handle.
  const handle = useMemo(
    () => (active ? buildHandle(object.base, feature) : null),
    [active, object.base, feature]
  )

  // Same trap as the sketch decals: the ring is rebuilt on every frame of a
  // drag, and garbage collection reclaims the JS object but not its GPU buffer.
  useEffect(() => () => handle?.fill?.dispose(), [handle])

  if (!handle) return null

  const grab = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    // OrbitControls listens on the canvas directly, so a React-level
    // stopPropagation will not reach it. Disable it synchronously or the
    // camera orbits while the face is being dragged.
    if (controlsRef.current) controlsRef.current.enabled = false
    startMovingFace(object.id, feature.id)
  }

  return (
    // Drawn through the solid on purpose: an intrude's created face is the
    // floor of its own pit, and a depth-tested handle down there is hidden by
    // the walls the user is trying to lean.
    <group renderOrder={12}>
      {handle.fill && (
        <mesh geometry={handle.fill} onPointerDown={grab}>
          <meshBasicMaterial
            color={scene.accent}
            transparent
            opacity={0.26}
            side={DoubleSide}
            depthTest={false}
            depthWrite={false}
          />
        </mesh>
      )}

      <Line
        points={handle.outline}
        color={scene.accent}
        lineWidth={2.5}
        transparent
        depthTest={false}
        depthWrite={false}
      />

      {/* The whole face is grabbable, but a bare outline reads as decoration
          and users do not discover it; the disc is the affordance that says
          "pull me". DoubleSide keeps it visible once the face turns away. */}
      <mesh position={handle.centre} quaternion={handle.orientation} onPointerDown={grab}>
        <circleGeometry args={[handle.discRadius, DISC_SEGMENTS]} />
        <meshBasicMaterial
          color={scene.accent}
          transparent
          opacity={0.9}
          side={DoubleSide}
          depthTest={false}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}
