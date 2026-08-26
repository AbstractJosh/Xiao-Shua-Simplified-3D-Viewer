import { useEffect, useMemo } from 'react'
import { DoubleSide, type Object3D } from 'three'
import { surfaceFor } from '../geometry/surfaces'
import { useDoc } from '../store/docStore'
import { COLORS } from './SketchLayer'

/**
 * Decoration only: the ghost tracks the pointer, so it is always the frontmost
 * thing under it. Left pickable it would shadow every object it flies over.
 */
const noRaycast: Object3D['raycast'] = () => {}

/**
 * Ghost of a 3D template being dragged in from the console.
 *
 * Nothing is drawn while the position is null -- the pointer is off the canvas
 * and `commitPlacingSolid` will cancel -- so an empty viewport is the honest
 * preview of releasing there, the same convention the 2D placing preview uses.
 */
export function PlacingSolidPreview() {
  const drag = useDoc((s) => s.drag)
  const base = drag.kind === 'placing-solid' ? drag.base : null

  // `updatePlacingSolid` spreads the drag, so `base` keeps its identity for the
  // whole gesture and this builds once per template rather than once per frame.
  const geometry = useMemo(() => (base ? surfaceFor(base).geometry() : null), [base])

  // surfaceFor().geometry() hands back a fresh BufferGeometry every call, and
  // dropping one only frees the JS wrapper -- the GPU buffers behind it survive
  // until dispose. Across a drag-and-drop session that is a real leak.
  useEffect(() => () => geometry?.dispose(), [geometry])

  if (drag.kind !== 'placing-solid' || !drag.position || !geometry) return null

  // Sits at drag.position verbatim, because commitPlacingSolid feeds that same
  // value straight into the new object's transform. Adding anything here -- the
  // ground lift of -bounds().min.y included -- would make the ghost promise a
  // placement the drop does not deliver. That lift belongs upstream, where the
  // ground point is picked, which is also the only place the snapper can see
  // the would-be object's real corners.
  return (
    <group position={drag.position}>
      <mesh geometry={geometry} raycast={noRaycast}>
        <meshBasicMaterial
          color={COLORS.placing}
          transparent
          opacity={0.24}
          side={DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {/* The fill alone reads as a flat blob at low opacity; the wireframe is
          what makes a bean distinguishable from a cylinder mid-drag. */}
      <mesh geometry={geometry} raycast={noRaycast}>
        <meshBasicMaterial
          color={COLORS.placing}
          wireframe
          transparent
          opacity={0.5}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}
