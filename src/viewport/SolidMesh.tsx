import { useEffect, useMemo } from 'react'
import type { RefObject } from 'react'
import { Edges } from '@react-three/drei'
import type { Mesh } from 'three'
import { evaluateDoc } from '../geometry/evaluate'
import { useDoc } from '../store/docStore'
import { useEvalStatus } from '../store/evalStore'

export function SolidMesh({ meshRef }: { meshRef: RefObject<Mesh | null> }) {
  const doc = useDoc((s) => s.doc)
  const dragging = useDoc((s) => s.drag.kind !== 'idle')
  const publish = useEvalStatus((s) => s.publish)

  // The whole viewport is a pure function of the document: every edit replays
  // the feature tree, and the prefix cache keeps that cheap.
  const result = useMemo(() => evaluateDoc(doc), [doc])

  useEffect(() => {
    const pos = result.geometry.getAttribute('position')
    const index = result.geometry.getIndex()
    publish({
      failed: result.failed,
      millis: result.millis,
      triangles: Math.round((index ? index.count : pos.count) / 3),
    })
  }, [result, publish])

  return (
    <mesh ref={meshRef} geometry={result.geometry} castShadow receiveShadow>
      <meshStandardMaterial color="#9aa3b4" metalness={0.15} roughness={0.55} />
      {/* Edge outlines read as CAD, but rebuilding them every frame competes
          with the boolean solve, so they are dropped for the duration of a drag. */}
      {!dragging && <Edges threshold={18} color="#2b3442" />}
    </mesh>
  )
}
