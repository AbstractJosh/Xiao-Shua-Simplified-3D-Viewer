import { Box3, Matrix4, Vector3 } from 'three'
import { baseParams, scaleLimits, scaleUniform } from './dimensions'
import type { Axis } from './dimensions'
import { conform, surfaceFor } from './surfaces'
import { objectMatrix, toWorldDir, toWorldPoint } from './transform'
import type { SceneObject, Vec3 } from './types'

/**
 * A merged object, read as ONE thing.
 *
 * `SceneObject.parts` deliberately keeps every merged solid whole -- its own
 * base, its own features, its own transform -- so that an unmerge could hand
 * back exactly what went in. That is the right storage, but it leaves every
 * consumer looking at a host primitive with a list hanging off it, and a
 * consumer that reads only the host is a consumer that treats a merged object
 * as its first solid: a gizmo parked on one of the two, a Width field that
 * sizes one of the two.
 *
 * Everything here answers a question about the WHOLE: where its centre is, how
 * big it is, and what it means to scale it. Each walks the tree, so a merge of
 * a merge is covered by the same code that covers a merge of two primitives.
 *
 * For an object with no parts every one of these degenerates to the bare solid
 * -- centre at the origin, bounds of the primitive, scale of the base alone --
 * which is what lets the callers use them unconditionally.
 */

/**
 * Visit every solid in the object, with the matrix that carries it into the top
 * object's local frame. The host comes first, at the identity.
 */
function walk(
  obj: SceneObject,
  into: Matrix4,
  visit: (o: SceneObject, m: Matrix4) => void
): void {
  visit(obj, into)
  for (const part of obj.parts) {
    walk(part, into.clone().multiply(objectMatrix(part.transform)), visit)
  }
}

/**
 * The colour of every solid in the object, keyed by the id its paint uses.
 *
 * The evaluator hands the viewport a list of PAINT KEYS -- one per group in the
 * merged geometry, each the id of the solid whose triangles are in it -- and
 * this is the other half of that: the colours the document holds for those ids.
 * The two together are what let one mesh wear several colours.
 *
 * `undefined` for a solid that was never painted, which is not the same as
 * absent: the caller has to be able to tell "this part is the default grey"
 * from "this key is not one of ours", and only the first should draw.
 *
 * Walks the whole tree for the reason everything else here does -- a part that
 * was itself a merge brings its own parts' colours with it.
 */
export function assemblyColors(obj: SceneObject): Map<string, string | undefined> {
  const colors = new Map<string, string | undefined>()
  const collect = (o: SceneObject) => {
    colors.set(o.id, o.color)
    for (const part of o.parts) collect(part)
  }
  collect(obj)
  return colors
}

/**
 * The centre of a merged object, in its OWN local space.
 *
 * The average of every constituent solid's origin -- the host's, which is the
 * local origin, and each part's, carried up through however many merges deep it
 * sits. That is literally where the gizmos were before the merge: weld two
 * solids and the single gizmo left behind lands midway between the two that
 * went in.
 *
 * Unweighted, and measured from ORIGINS rather than from the bounding box.
 * Weighting by size would let a large solid pull the gizmo inside itself, and
 * both a weighted centre and a box centre would then shift every time a
 * dimension changed. This one moves only when the merge does, which is what
 * keeps the gizmo still while it is being dragged.
 */
export function assemblyCentre(obj: SceneObject): Vec3 {
  const sum = new Vector3()
  let count = 0
  walk(obj, new Matrix4(), (_, m) => {
    sum.add(new Vector3().setFromMatrixPosition(m))
    count += 1
  })
  return [sum.x / count, sum.y / count, sum.z / count]
}

/** That centre in WORLD space: where the object's one gizmo belongs. */
export function assemblyAnchor(obj: SceneObject): Vec3 {
  const centre = assemblyCentre(obj)
  const world = toWorldPoint(
    obj.transform,
    new Vector3(centre[0], centre[1], centre[2])
  )
  return [world.x, world.y, world.z]
}

/**
 * The extents of every solid in the object, unioned, in its own local space.
 *
 * Measured from the BASE primitives, not from the evaluated geometry: a
 * bounding box that grew and shrank as sketches were pushed and pulled would
 * make the size field jitter under an unrelated edit, and this has to be
 * answerable without a boolean solve.
 */
export function assemblyBounds(obj: SceneObject): Box3 {
  const box = new Box3()
  walk(obj, new Matrix4(), (o, m) => {
    box.union(surfaceFor(o.base).bounds().applyMatrix4(m))
  })
  return box
}

/**
 * The object's overall size: the longest side of that box.
 *
 * One number for a thing that has no single width, and the one the size field
 * shows. It is exactly proportional to the scale factor -- a uniform scale about
 * the local origin scales the union of the boxes by the same factor -- so
 * typing a number into the field lands on that number.
 */
export function assemblyExtent(obj: SceneObject): number {
  const size = assemblyBounds(obj).getSize(new Vector3())
  return Math.max(size.x, size.y, size.z)
}

/** Half the object's reach along one of its own axes, for an arrow drag. */
export function assemblyHalfExtent(obj: SceneObject, axis: Axis): number {
  const size = assemblyBounds(obj).getSize(new Vector3())
  return [size.x, size.y, size.z][axis] / 2
}

/**
 * The uniform factors the whole object can take, intersected across every solid
 * in it.
 *
 * Intersected rather than applied per solid, for the reason `scaleUniform`
 * clamps once rather than per dimension: a part that hit its ceiling while the
 * rest kept growing would change the shape of the assembly, and a merged object
 * that quietly rearranged itself under a scale is not one object.
 */
export function assemblyScaleLimits(obj: SceneObject): { lo: number; hi: number } {
  let lo = 0
  let hi = Infinity
  walk(obj, new Matrix4(), (o) => {
    const limit = scaleLimits(o.base)
    lo = Math.max(lo, limit.lo)
    hi = Math.min(hi, limit.hi)
  })
  return { lo, hi }
}

/**
 * Every number a scale moves, in tree order, so two states can be compared for
 * "this frame changed nothing".
 *
 * Cheap on purpose -- no surfaces are built -- because it runs on every frame of
 * a drag, and the frames that arrive while a scale sits pinned at its limit must
 * not each cost an undo entry.
 */
export function assemblyParams(obj: SceneObject): number[] {
  const out: number[] = []
  walk(obj, new Matrix4(), (o, m) => {
    out.push(...baseParams(o.base))
    const at = new Vector3().setFromMatrixPosition(m)
    out.push(at.x, at.y, at.z)
  })
  return out
}

/** The solids alone: bases, the offsets between them, and the cuts through them. */
/**
 * A solid nested inside another -- a merged part, or a hole erased out of it --
 * scaled along with its host.
 *
 * The offset from the host scales as well as the solid. Scaling the solids and
 * leaving the gaps would pull a merged assembly apart at exactly the rate it
 * grew, and would slide every hole out from under the feature it was cut for.
 */
const scaleNested = (f: number) => (nested: SceneObject): SceneObject => ({
  ...scaleSolids(nested, f),
  transform: {
    ...nested.transform,
    position: [
      nested.transform.position[0] * f,
      nested.transform.position[1] * f,
      nested.transform.position[2] * f,
    ] as Vec3,
  },
})

function scaleSolids(obj: SceneObject, f: number): SceneObject {
  const base = scaleUniform(obj.base, f)
  return {
    ...obj,
    base,
    // Sketches keep their own size, which is the rule a bare solid's ring
    // already follows -- but they are reseated onto the face that has just
    // moved out from under them, and a pocket deeper than the solid now is
    // stands down.
    features: obj.features.map((feature) => conform(base, feature)),
    // A cut is a plane in this object's own space, so its origin is a length
    // like any other and travels with the surface it was aimed at. The normal
    // is a direction, and a uniform scale leaves directions alone.
    cuts: obj.cuts.map((cut) => ({
      ...cut,
      origin: [cut.origin[0] * f, cut.origin[1] * f, cut.origin[2] * f] as Vec3,
    })),
    parts: obj.parts.map(scaleNested(f)),
    // A hole is a solid like any other and scales with the object it is in.
    // Left alone it would stay the size it was while the object grew around it,
    // which is the one thing a user resizing a drilled block never means.
    ...(obj.erased ? { erased: obj.erased.map(scaleNested(f)) } : {}),
  }
}

/**
 * Scale the whole object -- every solid merged into it -- by one factor, about
 * its own centre.
 *
 * The model scales about the LOCAL ORIGIN, because that is the frame every
 * primitive is written in and the invariant the whole geometry layer rests on.
 * Scaling about the centre instead is then a translation: the centre would have
 * moved to `f * centre`, so the object transform takes back the difference. The
 * result is that the point the gizmo sits on does not move, which is both what a
 * user expects of a scale and what keeps a ring drag from chasing its own
 * measurement round the loop `gizmoDrag.ts` describes.
 *
 * For an object with no parts the centre IS the origin, the translation is zero,
 * and this is `scaleUniform` on the base with the reseat pass the panel and the
 * arrows already do.
 */
export function scaleAssembly(obj: SceneObject, factor: number): SceneObject {
  const { lo, hi } = assemblyScaleLimits(obj)
  const f = Math.min(hi, Math.max(lo, factor))
  const centre = assemblyCentre(obj)
  const scaled = scaleSolids(obj, f)

  const shift = toWorldDir(
    obj.transform,
    new Vector3(centre[0], centre[1], centre[2]).multiplyScalar(1 - f)
  )
  const [x, y, z] = obj.transform.position
  return {
    ...scaled,
    transform: {
      ...scaled.transform,
      position: [x + shift.x, y + shift.y, z + shift.z],
    },
  }
}
