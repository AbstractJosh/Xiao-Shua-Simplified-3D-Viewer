import { useEffect, useMemo } from 'react'
import type { RefObject } from 'react'
import { Line } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import { hostSurfaceFor } from '../geometry/surfaces'
import { buildCapGeometry, outlineOnSurface, outlinePolyline } from '../geometry/prism'
import type { BaseSolid, SceneObject, Shape2D, SurfaceAnchor } from '../geometry/types'
import { useDoc } from '../store/docStore'

/** Lift of the projection above the solid; enough to clear z-fighting. */
const DECAL_LIFT = 0.005

export const COLORS = {
  idle: '#f0a848',
  selected: '#59a5ff',
  placing: '#5fd68a',
  invalid: '#ff7a66',
}

type DecalProps = {
  base: BaseSolid
  anchor: SurfaceAnchor
  shape: Shape2D
  rotation: number
  color: string
  filled: boolean
  /** Draw through the solid, so a buried sketch stays grabbable. */
  onTop?: boolean
  onPointerDown?: (e: ThreeEvent<PointerEvent>) => void
}

/**
 * A sketch drawn on the surface it is anchored to.
 *
 * Both the outline and the fill come from the same `outlineOnSurface` sampling
 * that builds the cutting prism, so what the user sees is literally the tool's
 * footprint -- on a sphere the outline curves with the surface for free.
 */
export function SketchDecal({
  base,
  anchor,
  shape,
  rotation,
  color,
  filled,
  onTop = false,
  onPointerDown,
}: DecalProps) {
  const { points, cap } = useMemo(() => {
    const host = hostSurfaceFor(base, anchor)
    const ring = outlineOnSurface(host, anchor, { shape, rotation })
    return {
      points: outlinePolyline(ring, DECAL_LIFT),
      cap: buildCapGeometry(ring, DECAL_LIFT),
    }
  }, [base, anchor, shape, rotation])

  // The anchor changes on every frame of a drag, so this rebuilds constantly.
  // Garbage collection reclaims the JS object but not the GPU buffers behind
  // it -- those need an explicit dispose or a long drag leaks one per frame.
  useEffect(() => () => cap?.dispose(), [cap])

  if (points.length < 2) return null

  return (
    <group renderOrder={onTop ? 10 : 1}>
      {cap && (
        <mesh geometry={cap} onPointerDown={onPointerDown}>
          <meshBasicMaterial
            color={color}
            transparent
            opacity={filled ? 0.22 : 0.06}
            depthTest={!onTop}
            depthWrite={false}
          />
        </mesh>
      )}
      <Line
        points={points}
        color={color}
        lineWidth={2}
        transparent
        depthTest={!onTop}
        depthWrite={false}
      />
    </group>
  )
}

/**
 * Every committed sketch on ONE object, selectable and draggable.
 *
 * Mounted by SceneObjects inside that object's group, so these decals are drawn
 * in object-local space -- which is the space anchors are already stored in.
 * Nothing here transforms anything; the group does it all.
 */
export function ObjectSketches({
  object,
  controlsRef,
}: {
  object: SceneObject
  controlsRef: RefObject<{ enabled: boolean } | null>
}) {
  const selectedObjectId = useDoc((s) => s.selectedObjectId)
  const selectedFeatureId = useDoc((s) => s.selectedFeatureId)
  const startMoving = useDoc((s) => s.startMoving)

  return (
    <>
      {object.features.map((f) => {
        // A feature id only identifies a sketch alongside its object: two
        // objects can each hold a selection-shaped id, and matching on the
        // feature alone would light up a sketch on the wrong solid.
        const isSelected =
          object.id === selectedObjectId && f.id === selectedFeatureId
        return (
          <SketchDecal
            key={f.id}
            base={object.base}
            anchor={f.anchor}
            shape={f.shape}
            rotation={f.rotation}
            color={
              !f.enabled ? '#5a6172' : isSelected ? COLORS.selected : COLORS.idle
            }
            filled={isSelected}
            onTop={isSelected}
            onPointerDown={(e) => {
              e.stopPropagation()
              // OrbitControls listens on the canvas directly, so a React-level
              // stopPropagation will not reach it. Disable it synchronously or
              // the camera orbits while the sketch is being dragged.
              if (controlsRef.current) controlsRef.current.enabled = false
              // startMoving selects as it begins the drag, so a plain click on
              // a sketch still ends up selecting it.
              startMoving(object.id, f.id)
            }}
          />
        )
      })}
    </>
  )
}

/**
 * Ghost of the shape being dragged in from the console.
 *
 * This one is mounted outside every object group, so it lives in WORLD space
 * and has to carry the target object's transform itself. The anchor under the
 * pointer is local to whichever object was hit, and drawing it without that
 * transform would strand the ghost at the origin.
 */
export function PlacingPreview() {
  const drag = useDoc((s) => s.drag)
  const objects = useDoc((s) => s.doc.objects)

  if (drag.kind !== 'placing' || drag.anchor === null) return null
  const object = objects.find((o) => o.id === drag.objectId)
  // Off every object: nothing valid to preview, and releasing here cancels.
  if (!object) return null

  const { position, rotation } = object.transform
  return (
    <group position={position} rotation={rotation}>
      <SketchDecal
        base={object.base}
        anchor={drag.anchor}
        shape={drag.shape}
        rotation={0}
        color={COLORS.placing}
        filled
        onTop
      />
    </group>
  )
}
