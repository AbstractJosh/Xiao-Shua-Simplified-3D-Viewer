import { Mesh, Raycaster, Vector2, Vector3 } from 'three'
import type { Material, Ray } from 'three'
import { surfaceFor } from '../geometry/surfaces'
import { toLocalRay, toWorldDir, toWorldPoint } from '../geometry/transform'
import type { Doc, SceneObject, SurfaceAnchor } from '../geometry/types'

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

/** A pick resolved against one object. `point` and `normal` are WORLD space;
 *  `anchor`, like every anchor in the document, is that object's LOCAL space. */
export type ObjectHit = {
  objectId: string
  anchor: SurfaceAnchor
  point: Vector3
  normal: Vector3
}

// --- Local-space raycasting -------------------------------------------------

/**
 * Every raycast here runs against a stand-in mesh pinned at the identity, fed a
 * ray already carried into object space.
 *
 * Going through the real mesh instead would transform by its `matrixWorld`, so
 * the object's placement would be applied twice. It also decouples picking from
 * the scene graph: the document's transform stays authoritative on the frame
 * where React has moved an object but three has not yet flushed the group.
 */
const probe = new Raycaster()
const probeMesh = new Mesh()
const IDLE_GEOMETRY = probeMesh.geometry
const IDLE_MATERIAL: Material | Material[] = probeMesh.material

type LocalHit = { point: Vector3; normal: Vector3 }

function raycastLocal(source: Raycaster, mesh: Mesh, ray: Ray): LocalHit | null {
  probeMesh.geometry = mesh.geometry
  // The real material decides back-face culling and, for a grouped geometry,
  // which slots are hit at all; borrowing it keeps picking and rendering from
  // disagreeing about what is visible.
  probeMesh.material = mesh.material
  probe.ray.copy(ray)
  // A rigid transform preserves distance, so the camera's clip range means the
  // same thing in object space as it does in world space.
  probe.near = source.near
  probe.far = source.far

  const hits = probe.intersectObject(probeMesh, false)

  // Dropped straight away: holding these would keep an evaluated mesh and its
  // material alive long after the object they belong to has been deleted.
  probeMesh.geometry = IDLE_GEOMETRY
  probeMesh.material = IDLE_MATERIAL

  if (hits.length === 0) return null
  const hit = hits[0]
  return {
    point: hit.point,
    // No matrixWorld to apply: the probe sat at the identity, so a face normal
    // is already in the object's own space -- which is the space an anchor is
    // stored in.
    normal: hit.face ? hit.face.normal.clone() : new Vector3(0, 1, 0),
  }
}

/**
 * Turn a local-space mesh hit into an anchor.
 *
 * Classified analytically first: if the point lands on the base primitive, the
 * anchor carries the primitive's own smooth normal rather than the faceted
 * triangle normal. That is what makes a boss on a sphere extrude along a true
 * radius instead of stair-stepping with the tessellation. Only hits on geometry
 * an earlier feature produced fall back to a derived, locally-flat anchor.
 */
function classify(
  object: SceneObject,
  local: LocalHit
): { anchor: SurfaceAnchor; normal: Vector3 } {
  const surface = surfaceFor(object.base)
  const analytic = surface.anchorFromHit(local.point)
  if (analytic) return { anchor: analytic, normal: surface.frame(analytic).normal }

  return {
    anchor: {
      on: 'derived',
      point: [local.point.x, local.point.y, local.point.z],
      normal: [local.normal.x, local.normal.y, local.normal.z],
    },
    normal: local.normal,
  }
}

// --- Scene picks ------------------------------------------------------------

/**
 * The nearest surface under the ray, across every object in the scene.
 *
 * The winner is decided on the WORLD position of each hit. Each object's ray
 * was rebased into that object's own space, so the `t` that comes back is
 * measured from a different origin every time and says nothing about which
 * object is actually in front.
 */
export function pickAnchorAcrossObjects(
  raycaster: Raycaster,
  doc: Doc,
  meshes: Map<string, Mesh>
): ObjectHit | null {
  let best: ObjectHit | null = null
  let bestDistance = Infinity

  for (const object of doc.objects) {
    const mesh = meshes.get(object.id)
    if (!mesh) continue

    const local = raycastLocal(raycaster, mesh, toLocalRay(object.transform, raycaster.ray))
    if (!local) continue

    const point = toWorldPoint(object.transform, local.point)
    const distance = raycaster.ray.origin.distanceToSquared(point)
    if (distance >= bestDistance) continue

    const { anchor, normal } = classify(object, local)
    bestDistance = distance
    best = {
      objectId: object.id,
      anchor,
      point,
      normal: toWorldDir(object.transform, normal),
    }
  }

  return best
}

/**
 * The sliding pick: where a sketch already living on `obj` should move to.
 *
 * The ORIGINAL primitive is consulted first and the evaluated mesh only when
 * that misses. A sketch being dragged has its own solid sitting directly under
 * the pointer -- a pocket it just cut, or a boss it just raised -- and letting
 * the evaluated mesh win would let the sketch fall into its own pocket or climb
 * its own boss, chasing the geometry it is creating a frame at a time.
 *
 * The mesh fallback is what keeps a sketch on derived geometry draggable: past
 * the primitive's silhouette there is no analytic surface left to glide on.
 */
export function pickAnchorOnObject(
  raycaster: Raycaster,
  obj: SceneObject,
  mesh: Mesh | null
): SurfaceAnchor | null {
  const ray = toLocalRay(obj.transform, raycaster.ray)
  const surface = surfaceFor(obj.base)

  const analytic = surface.raycast(ray)
  if (analytic) {
    const anchor = surface.anchorFromHit(analytic.point)
    if (anchor) return anchor
  }

  if (!mesh) return null
  const local = raycastLocal(raycaster, mesh, ray)
  if (!local) return null
  return classify(obj, local).anchor
}

// --- Plane picks ------------------------------------------------------------

const GROUND_NORMAL = new Vector3(0, 1, 0)
const planeNormal = new Vector3()
const planeGap = new Vector3()
const groundOrigin = new Vector3()

/** Below this the ray runs along the plane rather than through it. */
const PARALLEL_EPS = 1e-6

/**
 * Where the ray crosses a plane, in world space.
 *
 * Null in the two cases where an answer exists but is not one a user meant: a
 * ray grazing the plane meets it out at the horizon, and a ray pointing away
 * from it meets the mirror image behind the camera. Returning either would
 * teleport whatever is being dragged.
 */
export function pickPlanePoint(
  raycaster: Raycaster,
  origin: Vector3,
  normal: Vector3
): Vector3 | null {
  planeNormal.copy(normal).normalize()
  const denom = raycaster.ray.direction.dot(planeNormal)
  if (Math.abs(denom) < PARALLEL_EPS) return null

  const t = planeGap.subVectors(origin, raycaster.ray.origin).dot(planeNormal) / denom
  if (t < 0) return null
  return raycaster.ray.at(t, new Vector3())
}

/** Where the ray meets the ground, which is where a dropped solid lands. */
export function pickGroundPoint(raycaster: Raycaster, y = 0): Vector3 | null {
  return pickPlanePoint(raycaster, groundOrigin.set(0, y, 0), GROUND_NORMAL)
}
