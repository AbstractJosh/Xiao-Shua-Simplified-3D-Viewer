import { DoubleSide, type Object3D } from 'three'
import { useDoc } from '../store/docStore'
import { peekDropCache } from './dropCache'
import { useSceneColors } from './useSceneColors'

/**
 * Decoration only: the ghost tracks the pointer, so it is always the frontmost
 * thing under it. Left pickable it would shadow every object it flies over.
 */
const noRaycast: Object3D['raycast'] = () => {}

/**
 * Ghost of a solid being dragged in from the console.
 *
 * Nothing is drawn while the position is null -- the pointer is off the canvas
 * and `commitPlacingSolid` will cancel -- so an empty viewport is the honest
 * preview of releasing there, the same convention the 2D placing preview uses.
 *
 * The geometry is BORROWED from the drop cache rather than built here, and that
 * is the point: the shape the ghost draws and the shape the snapper seeks a
 * landing for are then the same one. A clipboard template is a whole object --
 * pockets, cuts, merged parts -- and a ghost that showed only its host primitive
 * would be promising a different solid from the one about to land.
 *
 * The cache is filled by the frame loop, which also sets the position this
 * reads; by the time there is a position to draw at, there is a geometry.
 */
export function PlacingSolidPreview() {
  const drag = useDoc((s) => s.drag)
  // Before the early returns below, or the hook order changes with the drag.
  const scene = useSceneColors()
  if (drag.kind !== 'placing-solid' || !drag.position) return null

  const cache = peekDropCache()
  if (!cache || cache.template !== drag.template) return null

  /**
   * An eraser in flight looks like the eraser it is about to be.
   *
   * The ghost used to be one colour whatever was being dragged, so the whole
   * gesture -- the part where the shape is aimed, which is the part that
   * matters -- said "material arriving" and only the drop said otherwise. Both
   * colours are the ones the landed object actually wears: `in` is the eraser's
   * body (see `EraseBody`) and `eraseEdge` is its outline, so nothing changes
   * hue on release. A solid keeps `out` for both, as it always has.
   */
  const fill = drag.template.erase ? scene.in : scene.out
  const wire = drag.template.erase ? scene.eraseEdge : scene.out

  // Sits at drag.position verbatim, because commitPlacingSolid feeds that same
  // value straight into the new object's transform. Adding anything here -- the
  // ground lift of -bounds().min.y included -- would make the ghost promise a
  // placement the drop does not deliver. That lift belongs upstream, where the
  // ground point is picked, which is also the only place the snapper can see
  // the would-be object's real corners.
  //
  // No rotation either: the cache baked the template's own into the geometry,
  // so turning the group here would apply it twice.
  return (
    <group position={drag.position}>
      <mesh geometry={cache.geometry} raycast={noRaycast}>
        <meshBasicMaterial
          color={fill}
          transparent
          opacity={0.24}
          side={DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {/* The fill alone reads as a flat blob at low opacity; the wireframe is
          what makes a bean distinguishable from a cylinder mid-drag. */}
      <mesh geometry={cache.geometry} raycast={noRaycast}>
        <meshBasicMaterial
          color={wire}
          wireframe
          transparent
          opacity={0.5}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}
