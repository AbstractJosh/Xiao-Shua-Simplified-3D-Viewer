import { Mesh, Raycaster, Vector2, Vector3 } from 'three'
import type { Material, Ray } from 'three'
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh'
import { useDoc } from '../store/docStore'
import { PERF_ON, notePick } from './perfProbe'
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

/**
 * The POINTER'S PATH since something last read it, in client coordinates, as
 * flat x,y pairs.
 *
 * `pointerClient` is where the pointer is; this is how it got there, and the
 * difference is the whole of what a brush needs. A frame loop that samples only
 * the position sees a stroke as a handful of points a frame apart, and HOW FAR
 * apart is how fast the user was moving -- which is why a quick flick with the
 * torch used to land as a row of separate imprints with the surface untouched
 * between them. The gap was never the tool; it was the sampling. See
 * `dragErode`, which walks this to fill it in.
 *
 * Filled from `getCoalescedEvents`, which hands back every sample the platform
 * received since the last event was dispatched rather than only the newest.
 * A mouse reporting at 1000 Hz or a pen at 240 puts several of those in every
 * frame, and they are the actual CURVE of the gesture -- so a fast arc is filled
 * in as the arc it was, rather than as the straight chord between the two
 * places a frame happened to catch it.
 *
 * Bounded, and emptied by whoever drains it. Nothing outside a stroke wants it,
 * and a queue nobody reads is a leak that lasts the session -- so the cap is
 * what makes it safe to record this unconditionally rather than arming it when
 * a brush comes up.
 */
const TRAIL_POINTS = 256
let trail: number[] = []

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointermove',
    (e) => {
      for (const sample of e.getCoalescedEvents?.() ?? [e]) {
        trail.push(sample.clientX, sample.clientY)
      }
      if (trail.length > TRAIL_POINTS * 2) trail = trail.slice(-TRAIL_POINTS * 2)
      pointerClient.x = e.clientX
      pointerClient.y = e.clientY
    },
    { passive: true }
  )
}

/** The path since the last call, emptied. */
export function takePointerTrail(): readonly number[] {
  const path = trail
  trail = []
  return path
}

/** Drop it. A gesture that is not a stroke has no use for where the pointer has
 *  been, and starting one on a stale path would smear the first dab across it. */
export function clearPointerTrail(): void {
  trail.length = 0
}

/**
 * A client point in normalised device coordinates, or null when off-canvas.
 *
 * Takes the rect rather than the element because a stroke converts a whole
 * frame's worth of samples at once, and reading `getBoundingClientRect` per
 * sample is a layout read per sample.
 */
export function ndcIn(rect: DOMRect, clientX: number, clientY: number): Vector2 | null {
  if (rect.width === 0 || rect.height === 0) return null
  const x = ((clientX - rect.left) / rect.width) * 2 - 1
  const y = -((clientY - rect.top) / rect.height) * 2 + 1
  if (x < -1 || x > 1 || y < -1 || y > 1) return null
  return new Vector2(x, y)
}

/** Pointer in normalised device coordinates, or null when off-canvas. */
export function pointerNdc(el: HTMLElement): Vector2 | null {
  return ndcIn(el.getBoundingClientRect(), pointerClient.x, pointerClient.y)
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

/**
 * The probe walks a BOUNDS TREE rather than every triangle in the object.
 *
 * Patched onto the instance rather than onto `Mesh.prototype`, because this one
 * mesh is the only thing in the app that ever raycasts document geometry --
 * everything below goes through it -- and patching a three prototype to serve
 * one private object is a change every other mesh in the scene has to read the
 * release notes for.
 *
 * `acceleratedRaycast` falls back to three's own brute-force walk whenever the
 * geometry has no tree, so this is safe from the first pick: there is no
 * arrangement of geometry that has to be prepared before it works.
 *
 * FIRST HIT ONLY, because the nearest hit is the only one this file has ever
 * read -- see the `hits[0]` below, which drops the rest. Said here rather than
 * sorted for afterwards: it is what lets the walk stop at the first leaf it can
 * prove nothing nearer lies in, and that is most of the saving. Without it the
 * tree is walked to the end and the results sorted, on a question that was
 * decided in the first few nodes.
 */
probeMesh.raycast = acceleratedRaycast
probe.firstHitOnly = true

/**
 * Below this, a tree costs more to build than the walk it saves.
 *
 * A box is twelve triangles and a cylinder a hundred and ninety-two; three's
 * own loop is through those before a tree has finished allocating. The number
 * is not delicate -- anywhere from a few hundred to a few thousand behaves the
 * same -- and it is here to keep a scene full of primitives from each paying
 * for a structure that describes eight triangles.
 */
const BVH_FLOOR = 2_000

/**
 * Give a geometry a bounds tree, if it is worth one and this is a safe moment.
 *
 * MOST GEOMETRY ARRIVES ALREADY CARRYING ONE. three-bvh-csg builds a `MeshBVH`
 * onto the geometry of every brush it feeds to a boolean -- see its
 * `Brush.prepareGeometry` -- under exactly the property `acceleratedRaycast`
 * reads. So every step of an object's history except the last one has a tree
 * already, and this only ever has to cover the final step.
 *
 * NOT DURING A STROKE. A melt hands back a fresh geometry for every dab, so a
 * tree built here would be built again from scratch on the next frame and the
 * one after -- a hundred and forty thousand triangles re-indexed per dab, which
 * is far worse than the brute-force walk it replaced. While a stroke runs,
 * picking does exactly what it did before. The stroke is not the case this
 * helps; the ghost that tracks the pointer with a brush merely ARMED is, and it
 * spends one of these every frame.
 *
 * The tree is never disposed here, and that is deliberate. These geometries
 * belong to the evaluator's prefix cache and are borrowed -- see the contract
 * on `EvalReadout`. A tree is plain typed arrays with nothing on the GPU, so it
 * is collected with the geometry it hangs off when the cache retires it.
 */
function ensureBoundsTree(mesh: Mesh): void {
  const geometry = mesh.geometry
  if (geometry.boundsTree) return
  if (useDoc.getState().drag.kind === 'erode') return
  const index = geometry.getIndex()
  const position = geometry.getAttribute('position')
  if (!position) return
  if ((index ? index.count : position.count) / 3 < BVH_FLOOR) return
  computeBoundsTree.call(geometry)
}

type LocalHit = { point: Vector3; normal: Vector3 }

function raycastLocal(source: Raycaster, mesh: Mesh, ray: Ray): LocalHit | null {
  const began = PERF_ON ? performance.now() : 0
  ensureBoundsTree(mesh)
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
  notePick(PERF_ON ? performance.now() - began : 0)

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
