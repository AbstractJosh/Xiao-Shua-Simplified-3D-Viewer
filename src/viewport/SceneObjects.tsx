import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { Edges } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import type { Mesh } from 'three'
import { evaluateDoc } from '../geometry/evaluate'
import type { SnapEntry } from '../geometry/snap'
import { useDoc } from '../store/docStore'
import { useEvalStatus } from '../store/evalStore'
import { FaceHandle } from './FaceHandle'
import { ObjectSketches } from './SketchLayer'
import { publishScene } from './snapping'

/** Selection is carried by the outline colour, which is why there is no
 *  separate outline pass to keep in sync with the scene. */
const EDGE_IDLE = '#2b3442'
const EDGE_SELECTED = '#59a5ff'

type Props = {
  meshes: RefObject<Map<string, Mesh>>
  controlsRef: RefObject<{ enabled: boolean } | null>
}

/**
 * The whole scene: one group per object, carrying that object's evaluated mesh,
 * its sketches and -- for the selected feature -- its end-face handle.
 */
export function SceneObjects({ meshes, controlsRef }: Props) {
  const doc = useDoc((s) => s.doc)
  const selectedObjectId = useDoc((s) => s.selectedObjectId)
  const selectedFeatureId = useDoc((s) => s.selectedFeatureId)
  const dragging = useDoc((s) => s.drag.kind !== 'idle')
  const publish = useEvalStatus((s) => s.publish)

  // The viewport is a pure function of the document: every edit replays the
  // feature tree, and the per-object prefix cache keeps that cheap. Nothing in
  // the cache keys mentions a transform, so dragging an object through the
  // scene re-renders groups and does no boolean work at all.
  const result = useMemo(() => evaluateDoc(doc), [doc])

  const geometries = useMemo(
    () => new Map(result.objects.map((o) => [o.id, o.geometry])),
    [result]
  )

  // One stable ref callback per object id. A fresh closure each render would
  // make React detach and re-attach the ref every time, so the map the
  // raycaster reads would briefly lose the mesh it is about to hit.
  const registrars = useRef(new Map<string, (mesh: Mesh | null) => void>())
  const registrarFor = (id: string) => {
    const cached = registrars.current.get(id)
    if (cached) return cached
    const register = (mesh: Mesh | null) => {
      if (mesh) meshes.current.set(id, mesh)
      // A stale entry would let picking raycast a mesh that has left the scene.
      else meshes.current.delete(id)
    }
    registrars.current.set(id, register)
    return register
  }

  useEffect(() => {
    publish({
      objects: result.objects,
      failed: result.failed,
      millis: result.millis,
      triangles: result.triangles,
    })

    // The snapping registry has to describe the scene AS EVALUATED: publishing
    // anything else would catch corners and edges that are no longer there.
    const entries: SnapEntry[] = []
    for (const object of doc.objects) {
      const geometry = geometries.get(object.id)
      if (geometry) entries.push({ id: object.id, geometry, transform: object.transform })
    }
    publishScene(entries)

    // React nulls the ref of an unmounted mesh, but the closure that does it
    // would otherwise be retained for every object the scene has ever held.
    const live = new Set(doc.objects.map((o) => o.id))
    for (const id of registrars.current.keys()) {
      if (!live.has(id)) registrars.current.delete(id)
    }
  }, [doc, geometries, result, publish])

  const onObjectPointerDown = (e: ThreeEvent<PointerEvent>, id: string) => {
    e.stopPropagation()
    const s = useDoc.getState()
    // A placement gesture already owns the pointer; letting a press through
    // here would abandon the drop half-finished and grab something else.
    if (s.drag.kind !== 'idle') return

    if (s.selectedObjectId !== id) {
      // The first press only selects. Dragging an unselected object still
      // orbits the camera, which is what keeps orbit-anywhere intact.
      s.selectObject(id)
      return
    }

    // OrbitControls listens on the canvas directly, so a React-level
    // stopPropagation never reaches it. Disable it synchronously or the camera
    // orbits while the object is being dragged.
    if (controlsRef.current) controlsRef.current.enabled = false
    s.startMovingObject(id)
  }

  return (
    <>
      {doc.objects.map((object) => {
        const geometry = geometries.get(object.id)
        if (!geometry) return null

        const isSelected = object.id === selectedObjectId
        const feature = isSelected
          ? object.features.find((f) => f.id === selectedFeatureId) ?? null
          : null

        return (
          <group
            key={object.id}
            position={object.transform.position}
            rotation={object.transform.rotation}
          >
            {/* The geometry belongs to the evaluator's cache -- this is a
                borrow. Disposing it here would free a buffer the next
                evaluation hands straight back. */}
            <mesh
              ref={registrarFor(object.id)}
              geometry={geometry}
              castShadow
              receiveShadow
              onPointerDown={(e) => onObjectPointerDown(e, object.id)}
            >
              <meshStandardMaterial color="#9aa3b4" metalness={0.15} roughness={0.55} />
              {/* Edge outlines read as CAD, but rebuilding them every frame
                  competes with the boolean solve, so they are dropped for the
                  duration of a drag. */}
              {!dragging && (
                <Edges threshold={18} color={isSelected ? EDGE_SELECTED : EDGE_IDLE} />
              )}
            </mesh>

            <ObjectSketches object={object} controlsRef={controlsRef} />
            {feature && (
              <FaceHandle object={object} feature={feature} controlsRef={controlsRef} />
            )}
          </group>
        )
      })}
    </>
  )
}
