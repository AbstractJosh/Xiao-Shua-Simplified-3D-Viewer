import { Euler, Quaternion, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import type { HitPointInfo } from 'three-mesh-bvh'
import { assemblyAnchor, assemblyBounds, assemblyExtent, scaleAssembly } from './assembly'
import type { Axis } from './dimensions'
import { evaluateObject } from './evaluate'
import { objectMatrix, objectMatrixInverse, quaternionOf, toWorldDir } from './transform'
import type { SceneObject, Vec3 } from './types'

/**
 * The scene as a TREE: which object rides on which, and what happens to the
 * riders when the thing under them is edited.
 *
 * Two halves. The first is bookkeeping -- who is whose child, and keeping
 * `Doc.objects` in the order the tree reads. The second is the reason the tree
 * exists: an edit to a parent is turned into a MOTION, a description of where
 * every point that rode on it ends up, and each child is carried by it.
 *
 * Transforms stay in WORLD space throughout -- see `SceneObject.parentId` -- so
 * carrying a child is rewriting its transform, never re-reading it through its
 * parent's. That is what lets the rest of the app go on ignoring the tree.
 */

// --- The tree ----------------------------------------------------------------

/** `o` with its parent set, or the key REMOVED for none -- never written as
 *  undefined, so a loose object is the document it was before the tree. */
export function withParent(o: SceneObject, parentId: string | undefined): SceneObject {
  if (o.parentId === parentId) return o
  const next: SceneObject = { ...o }
  if (parentId === undefined) delete next.parentId
  else next.parentId = parentId
  return next
}

/**
 * Every object below `id`, at any depth.
 *
 * Repeated sweeps rather than a walk from a child map, because the list is
 * already in tree order and a parent always precedes its children there -- so
 * the first sweep finds the whole subtree and the second only confirms it. The
 * sweeps are still what makes this right on a list that has not been tidied.
 */
export function descendantIds(objects: readonly SceneObject[], id: string): Set<string> {
  const out = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const o of objects) {
      if (o.id === id || out.has(o.id) || o.parentId === undefined) continue
      if (o.parentId === id || out.has(o.parentId)) {
        out.add(o.id)
        grew = true
      }
    }
  }
  return out
}

/**
 * Whether `childId` may be made to ride on `parentId`.
 *
 * Not on itself, not on anything already riding on it -- that would be a loop
 * with no top to it -- and never with an eraser at either end: an eraser is a
 * tool waiting to be consumed, and a child left hanging off one would be
 * orphaned the moment its subtraction was confirmed.
 */
export function canParent(
  objects: readonly SceneObject[],
  childId: string,
  parentId: string
): boolean {
  if (childId === parentId) return false
  const child = objects.find((o) => o.id === childId)
  const parent = objects.find((o) => o.id === parentId)
  if (!child || !parent || child.erase || parent.erase) return false
  return !descendantIds(objects, childId).has(parentId)
}

/**
 * The list put back into TREE ORDER, with every link that cannot stand dropped.
 *
 * Tree order is pre-order: each object followed by its whole subtree, siblings
 * keeping the order they already had. It is what lets the list's order go on
 * meaning PRIORITY -- see `moveObject` -- while also reading as the tree.
 *
 * A link is dropped, leaving its object at the top level where it stands, when
 * it names an object that is not in the list (a parent deleted, or dropped on
 * load because its model did not come back), when either end is an eraser, or
 * when following it upward would come back round. Saved files and old undo
 * steps are the only ways in for any of those, which is why this is run on
 * every committed edit rather than trusted to the actions that make links.
 *
 * Objects that need no change come back as the SAME objects, so a tidy of a
 * tidy list costs nothing downstream.
 */
export function tidyTree(objects: readonly SceneObject[]): SceneObject[] {
  const byId = new Map(objects.map((o) => [o.id, o]))
  const parent = new Map<string, string>()
  for (const o of objects) {
    const up = o.parentId === undefined ? undefined : byId.get(o.parentId)
    if (!up || up.id === o.id || o.erase || up.erase) continue
    parent.set(o.id, up.id)
  }

  // A loop is broken at the first of its members the list reaches. Walking up
  // from an object that merely LEADS into a loop finds a repeat that is not
  // itself; that one is left alone, and the loop is broken when its own first
  // member comes round.
  for (const o of objects) {
    const seen = new Set([o.id])
    for (let up = parent.get(o.id); up !== undefined; up = parent.get(up)) {
      if (up === o.id) {
        parent.delete(o.id)
        break
      }
      if (seen.has(up)) break
      seen.add(up)
    }
  }

  const children = new Map<string | undefined, SceneObject[]>()
  for (const o of objects) {
    const key = parent.get(o.id)
    const siblings = children.get(key)
    if (siblings) siblings.push(o)
    else children.set(key, [o])
  }

  const out: SceneObject[] = []
  const visit = (o: SceneObject) => {
    out.push(withParent(o, parent.get(o.id)))
    for (const child of children.get(o.id) ?? []) visit(child)
  }
  for (const root of children.get(undefined) ?? []) visit(root)
  return out
}

/**
 * New parents for whatever was riding on objects that are LEAVING the scene.
 *
 * By default a rider drops to the nearest ancestor that is staying, or to the
 * top level -- deleting a table never deletes the vase on it. With an `heir`,
 * which is a merge's host, riders go to the heir instead: the table merged into
 * the bench, the vase rides on the bench. The exception is anything the heir
 * itself rides on, which cannot also ride on the heir; those fall back to the
 * nearest staying ancestor, and so does the heir.
 */
export function rehome(
  objects: readonly SceneObject[],
  leaving: ReadonlySet<string>,
  heir?: string
): SceneObject[] {
  const byId = new Map(objects.map((o) => [o.id, o]))
  const above = new Set<string>()
  let climb = heir === undefined ? undefined : byId.get(heir)?.parentId
  while (climb !== undefined && !above.has(climb)) {
    above.add(climb)
    climb = byId.get(climb)?.parentId
  }

  return objects.map((o) => {
    if (leaving.has(o.id) || o.parentId === undefined || !leaving.has(o.parentId)) return o
    let up: string | undefined = o.parentId
    const seen = new Set<string>()
    while (up !== undefined && leaving.has(up) && !seen.has(up)) {
      seen.add(up)
      up = byId.get(up)?.parentId
    }
    const toHeir = heir !== undefined && o.id !== heir && !above.has(o.id)
    return withParent(o, toHeir ? heir : up)
  })
}

// --- Carrying the riders -----------------------------------------------------

/**
 * What an edit did to one object, as the things riding on it feel it.
 *
 * `carry` is a map of WORLD points: a point that rode on the object before the
 * edit is where it rides afterwards. `turn` is the rotation the edit put the
 * object through, and `grow` the uniform factor it scaled by -- 1 for anything
 * that was not a scale, so a resize or a slide leaves the riders their size.
 *
 * `rigid` says the edit moved the object as a body, with no change of shape:
 * then every point it carries moves the same way, so where a rider touches it
 * stops mattering and nobody has to evaluate anything to find out.
 */
export type Motion = {
  carry: (p: Vector3) => Vector3
  turn: Quaternion
  grow: number
  rigid: boolean
}

const EPS = 1e-9

const vec = (v: Vec3) => new Vector3(v[0], v[1], v[2])
const tuple = (v: Vector3): Vec3 => [v.x, v.y, v.z]

/**
 * The motion of an edit, read off the object before and after it.
 *
 * In the object's own frame the edit is a change of BOUNDS, axis by axis, and
 * that is enough to say where a point on it went: a point between the two skins
 * on an axis keeps its fraction of the way across, so a vase standing on the top
 * face of a table is on the top face of the table after it.
 *
 * `scaled` says the edit was a uniform scale. Then the map is a plain
 * similarity -- every gap grows with the object, which is what keeps a scaled
 * group the same group, only bigger. Otherwise a point OUTSIDE the bounds is
 * carried by the skin nearest it, unstretched: a lamp hanging a hand's width
 * above a desk stays a hand's width above it however much taller the desk is
 * made.
 */
export function motionOf(before: SceneObject, after: SceneObject, scaled = false): Motion {
  const was = assemblyBounds(before)
  const now = assemblyBounds(after)
  const into = objectMatrixInverse(before.transform)
  const out = objectMatrix(after.transform)
  const grow = scaled ? assemblyExtent(after) / assemblyExtent(before) : 1

  const along = (v: number, k: Axis): number => {
    const lo0 = was.min.getComponent(k)
    const hi0 = was.max.getComponent(k)
    const lo1 = now.min.getComponent(k)
    const hi1 = now.max.getComponent(k)
    const span = hi0 - lo0
    if (span < EPS) return v + (lo1 + hi1) / 2 - (lo0 + hi0) / 2
    if (!scaled && v < lo0) return lo1 + (v - lo0)
    if (!scaled && v > hi0) return hi1 + (v - hi0)
    return lo1 + ((v - lo0) * (hi1 - lo1)) / span
  }

  const rigid =
    !scaled && was.min.distanceTo(now.min) < EPS && was.max.distanceTo(now.max) < EPS

  return {
    carry: (p) => {
      const local = p.clone().applyMatrix4(into)
      return new Vector3(along(local.x, 0), along(local.y, 1), along(local.z, 2)).applyMatrix4(out)
    },
    turn: quaternionOf(after.transform).multiply(quaternionOf(before.transform).invert()),
    grow,
    rigid,
  }
}

/**
 * The motion of a mirror: a reflection in the plane `mirrorAssembly` uses, the
 * one through the object's centre square to one of its own axes.
 *
 * A rider is carried to its reflected place but is not itself turned inside
 * out -- a rotation cannot say "the other way round", and a child that sits on
 * the left of a table and is mirrored to the right is still the same vase.
 */
export function mirrorMotion(before: SceneObject, axis: Axis): Motion {
  const origin = vec(assemblyAnchor(before))
  const unit = new Vector3()
  unit.setComponent(axis, 1)
  const normal = toWorldDir(before.transform, unit).normalize()
  return {
    carry: (p) => p.clone().addScaledVector(normal, -2 * p.clone().sub(origin).dot(normal)),
    turn: new Quaternion(),
    grow: 1,
    rigid: false,
  }
}

/**
 * The motion of a rider held at one point `at`, which is carried to `to`: it
 * turns as its carrier turned and grows by `grow` about that point.
 */
function heldAt(at: Vector3, to: Vector3, turn: Quaternion, grow: number): Motion {
  return {
    carry: (p) => p.clone().sub(at).multiplyScalar(grow).applyQuaternion(turn).add(to),
    turn,
    grow,
    rigid: grow === 1,
  }
}

/**
 * How near two solids have to come to count as TOUCHING: a fifth of a
 * millimetre.
 *
 * A snap lands two surfaces exactly together -- the same tessellation on both
 * sides, so the gap is float dust -- and this is a long way above that and a
 * long way below anything a person would call a gap between two parts.
 */
export const CONTACT_TOLERANCE = 0.002

const contacts = new WeakMap<SceneObject, WeakMap<SceneObject, Vector3 | null>>()

/**
 * Where `child` rests on `parent`, in WORLD space -- or null if it does not
 * touch it.
 *
 * Asked of the EVALUATED meshes, because the surfaces that touch are the ones
 * the user sees: a vase stood on a dome, on the curve of a cylinder, on a boss
 * grown out of a table top, touches what is drawn, and none of those is the
 * box the primitive was dimensioned by.
 *
 * Two questions. First, do they come within `CONTACT_TOLERANCE` anywhere at
 * all. Then, if they do, the point on the parent nearest the child's CENTRE --
 * the middle of where the vase stands rather than whichever corner of its foot
 * the first question happened to find, which is what keeps a vase in the middle
 * of a table in the middle of it when the table is made wider.
 *
 * Remembered per pair of OBJECTS, by identity. A gesture carries its riders
 * from the scene as it stood at the press, so every frame of a drag asks about
 * the same two objects and only the first pays for the replay.
 * ponytail: two full evaluations on a miss -- borrow the viewport's cached
 * meshes if heavy sculpted solids make the first frame of a scale stutter.
 */
export function contactPoint(parent: SceneObject, child: SceneObject): Vector3 | null {
  let byChild = contacts.get(parent)
  if (!byChild) {
    byChild = new WeakMap()
    contacts.set(parent, byChild)
  }
  const known = byChild.get(child)
  if (known !== undefined) return known?.clone() ?? null

  const found = measureContact(parent, child)
  byChild.set(child, found)
  return found?.clone() ?? null
}

function measureContact(parent: SceneObject, child: SceneObject): Vector3 | null {
  const host = evaluateObject(parent).geometry
  const rider = evaluateObject(child).geometry
  try {
    if (host.getAttribute('position').count === 0 || rider.getAttribute('position').count === 0) {
      return null
    }
    // The parent's mesh carries the tree, in the parent's own frame, and the
    // child is brought into that frame to be measured against it.
    const tree = new MeshBVH(host)
    const riderToHost = objectMatrixInverse(parent.transform).multiply(objectMatrix(child.transform))
    const touch = tree.closestPointToGeometry(
      rider,
      riderToHost,
      {} as HitPointInfo,
      undefined,
      CONTACT_TOLERANCE,
      CONTACT_TOLERANCE
    )
    if (!touch || touch.distance > CONTACT_TOLERANCE) return null

    const centre = vec(assemblyAnchor(child)).applyMatrix4(objectMatrixInverse(parent.transform))
    const under = tree.closestPointToPoint(centre)
    const local = under ? under.point : touch.point
    return local.applyMatrix4(objectMatrix(parent.transform))
  } finally {
    host.dispose()
    rider.dispose()
  }
}

/** Where a rider is held when it touches nothing: its own centre. */
const centreOf = (o: SceneObject) => vec(assemblyAnchor(o))

/**
 * One rider, carried by its carrier's motion. Returns the rider as it is now,
 * and the motion IT went through -- which is what its own riders are carried
 * by in turn.
 *
 * A rigid motion carries the rider as a body. Anything else is felt at ONE
 * point, where the rider touches its carrier (or its centre, where it touches
 * nothing): that point goes where the carrier takes it, and the rider turns as
 * the carrier turned and grows as the carrier grew, about it. So a vase on a
 * table that is made taller rises with the top and stays its size, and a vase
 * on a table that is scaled up grows from its foot and stays standing on it.
 */
function follow(carrier: SceneObject, rider: SceneObject, motion: Motion): [SceneObject, Motion] {
  if (motion.rigid) {
    return [
      {
        ...rider,
        transform: {
          position: tuple(motion.carry(vec(rider.transform.position))),
          rotation: eulerOf(motion.turn.clone().multiply(quaternionOf(rider.transform))),
        },
      },
      motion,
    ]
  }

  const at = contactPoint(carrier, rider) ?? centreOf(rider)
  // The rider's own size, when it grows, is scaled about its local origin, and
  // its placement is then computed from the held point -- so the factor it
  // ACTUALLY took is read back rather than assumed: a solid at its size limit
  // grows less than the carrier did, and its foot has to stay put all the same.
  const grown = motion.grow === 1 ? rider : scaleAssembly(rider, motion.grow)
  const factor = motion.grow === 1 ? 1 : assemblyExtent(grown) / assemblyExtent(rider)
  const own = heldAt(at, motion.carry(at), motion.turn, factor)
  return [
    {
      ...grown,
      transform: {
        position: tuple(own.carry(vec(rider.transform.position))),
        rotation: eulerOf(motion.turn.clone().multiply(quaternionOf(rider.transform))),
      },
    },
    own,
  ]
}

const eulerOf = (q: Quaternion): Vec3 => {
  const e = new Euler().setFromQuaternion(q, 'XYZ')
  return [e.x, e.y, e.z]
}

/**
 * The scene with one object edited and everything riding on it carried along.
 *
 * `objects` is the scene BEFORE the edit -- for a drag, as it stood at the
 * press, never the last frame's result, so the riders are carried from where
 * they began rather than nudged from where the previous frame left them. That
 * is the same rule `gizmoDrag.ts` keeps for the object itself, and for the same
 * reason: a frame built on the last frame accumulates, and a rider would creep.
 *
 * `edited` is the object as the edit leaves it, and `motion` what that did.
 * Returns only the objects that changed, by id, so the caller can write them
 * into whatever the scene has become since.
 */
export function carryRiders(
  objects: readonly SceneObject[],
  before: SceneObject,
  edited: SceneObject,
  motion: Motion
): Map<string, SceneObject> {
  const changed = new Map<string, SceneObject>([[before.id, edited]])
  const ride = (carrier: SceneObject, carried: Motion) => {
    for (const rider of objects) {
      // `changed` doubles as the loop guard: a list that somehow held a cycle
      // would otherwise carry its way round it for ever.
      if (rider.parentId !== carrier.id || changed.has(rider.id)) continue
      const [moved, own] = follow(carrier, rider, carried)
      changed.set(rider.id, moved)
      ride(rider, own)
    }
  }
  ride(before, motion)
  return changed
}

/**
 * An edit to a rider, slid back so that wherever it rests on its parent stays
 * where it was.
 *
 * What "scaling either object keeps the snapped surfaces together" means from
 * the rider's side: a vase stood on a table and scaled about its own middle
 * would sink into the top or lift off it, so the scale is followed by the slide
 * that puts its foot back. Where the edit already holds that point -- a resize
 * from the far face, with the foot on the far face -- the slide is nothing.
 *
 * Returns the edit unchanged when the object has no parent or does not touch
 * it, and in every case the motion its own riders are to be carried by.
 */
export function pinToParent(
  objects: readonly SceneObject[],
  before: SceneObject,
  edited: SceneObject,
  motion: Motion
): { edited: SceneObject; motion: Motion } {
  const parent =
    before.parentId === undefined ? undefined : objects.find((o) => o.id === before.parentId)
  const at = parent ? contactPoint(parent, before) : null
  if (!at) return { edited, motion }

  const back = at.clone().sub(motion.carry(at))
  if (back.lengthSq() < EPS * EPS) return { edited, motion }
  const [x, y, z] = edited.transform.position
  return {
    edited: {
      ...edited,
      transform: { ...edited.transform, position: [x + back.x, y + back.y, z + back.z] },
    },
    motion: { ...motion, carry: (p) => motion.carry(p).add(back), rigid: false },
  }
}
