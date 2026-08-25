import { Mesh, Raycaster, Vector2, Vector3 } from 'three'
import { surfaceFor } from '../geometry/surfaces'
import type { BaseSolid, SurfaceAnchor } from '../geometry/types'

/**
 * Latest pointer position in client coordinates.
 *
 * Tracked on `window` rather than through React events because a placement
 * gesture starts on a console chip and finishes over the canvas. A listener
 * bound to either element alone would miss half the gesture.
 */
export const pointerClient = { x: 0, y: 0 }

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointermove',
    (e) => {
      pointerClient.x = e.clientX
      pointerClient.y = e.clientY
    },
    { passive: true }
  )
}

/** Pointer in normalised device coordinates, or null when off-canvas. */
export function pointerNdc(el: HTMLElement): Vector2 | null {
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return null
  const x = ((pointerClient.x - r.left) / r.width) * 2 - 1
  const y = -((pointerClient.y - r.top) / r.height) * 2 + 1
  if (x < -1 || x > 1 || y < -1 || y > 1) return null
  return new Vector2(x, y)
}

/**
 * Pick an anchor from the evaluated solid.
 *
 * The hit is classified analytically first: if it lands on the base primitive,
 * the anchor carries the primitive's own smooth normal rather than the faceted
 * triangle normal. That is what makes a boss on a sphere extrude along a true
 * radius instead of stair-stepping with the tessellation. Only hits on geometry
 * an earlier feature produced fall back to a derived, locally-flat anchor.
 */
export function pickAnchorOnSolid(
  raycaster: Raycaster,
  base: BaseSolid,
  mesh: Mesh | null
): SurfaceAnchor | null {
  if (!mesh) return null
  const hits = raycaster.intersectObject(mesh, false)
  if (hits.length === 0) return null
  const hit = hits[0]

  const analytic = surfaceFor(base).anchorFromHit(hit.point)
  if (analytic) return analytic

  const normal = hit.face
    ? hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize()
    : new Vector3(0, 1, 0)
  return {
    on: 'derived',
    point: [hit.point.x, hit.point.y, hit.point.z],
    normal: [normal.x, normal.y, normal.z],
  }
}

/**
 * Pick an anchor from the base primitive analytically, ignoring the evaluated
 * mesh entirely -- so dragging a sketch glides across the original surface
 * instead of snagging on the pocket it just cut.
 */
export function pickAnchorOnBase(
  raycaster: Raycaster,
  base: BaseSolid
): SurfaceAnchor | null {
  const surface = surfaceFor(base)
  const hit = surface.raycast(raycaster.ray)
  if (!hit) return null
  return surface.anchorFromHit(hit.point)
}
