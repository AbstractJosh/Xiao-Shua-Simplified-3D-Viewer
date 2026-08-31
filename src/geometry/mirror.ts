import { Euler, Matrix4, Vector3 } from 'three'
import { assemblyCentre } from './assembly'
import type { Axis } from './dimensions'
import { mirrorMesh } from './meshLibrary'
import { endFaceFrame } from './prism'
import {
  cornersOfFaces,
  isMirrorPlane,
  mirrorPlanes,
  platonicFaces,
  prismFaces,
  pyramidFaces,
} from './solids'
import { conform, hostSurfaceFor, surfaceFor } from './surfaces'
import type { SurfaceDef } from './surfaces'
import type { BaseSolid, Feature, SceneObject, SurfaceAnchor, Vec2, Vec3 } from './types'

/**
 * Reflecting a whole object in one of its own axis planes.
 *
 * A MIRROR CANNOT BE A TRANSFORM, and that is the whole reason this file
 * exists. `ObjectTransform` is rigid on purpose -- rotation then translation,
 * never scale -- because a stored anchor's parameter space has to keep agreeing
 * with the geometry it was measured against. A reflection has determinant -1,
 * so it is not a rotation and never will be; bolting a sign onto the transform
 * would put an improper matrix underneath every anchor, every cut plane and
 * every torch mark in the document, and the whole geometry layer would have to
 * start asking which way round it was.
 *
 * So the reflection is REWRITTEN INTO THE DOCUMENT instead, the way
 * `scaleAssembly` rewrites a resize: every solid in the object, every sketch on
 * it, every cut through it and every dab burnt into it is restated on the other
 * side of the plane. What comes out is an ordinary `SceneObject` that no later
 * stage can tell apart from one built that way by hand, and undo takes it back
 * because it is one commit like any other.
 *
 * THE PRIMITIVE ITSELF IS THE AWKWARD PART. Everything in the document is
 * expressed relative to a base solid that is centred on the local origin, and
 * that base is a handful of numbers rather than geometry we may edit -- there
 * is no way to write down "a cone, but reflected". The way out is that a
 * reflection may be chosen: mirroring an object in the plane q_a = 0 is the
 * same act as mirroring it in ANY plane through the same point and then turning
 * the result, so we are free to pick the plane the primitive survives and let
 * the object's own rotation absorb the difference. See `mirrorNormal` for how
 * one is picked, and `mirrorAssembly` for the turn that pays for it.
 *
 * The one primitive with no symmetry to lean on is an imported model, and it is
 * also the only one whose geometry we hold outright -- so there the triangles
 * really are reflected, onto a new shelf entry. See `mirrorMesh`.
 */

/** The plane normals for a mirror asked for along X, Y or Z. */
const AXIS_NORMALS = [
  new Vector3(1, 0, 0),
  new Vector3(0, 1, 0),
  new Vector3(0, 0, 1),
] as const

/**
 * Reflection in the plane through the ORIGIN with this normal: I - 2nn'.
 *
 * Through the origin, always, because that is where every primitive here is
 * centred -- and a reflection in a plane that missed it would slide the base
 * off the local origin, which is the invariant the whole geometry layer rests
 * on. Mirroring about somewhere other than the origin is expressed as this plus
 * a shift of the object's transform, in `mirrorAssembly`.
 *
 * A Matrix4 rather than a Matrix3 so that one `applyMatrix4` serves points and
 * directions alike: there is no translation in it to tell them apart.
 */
function reflectionOf(n: Vector3): Matrix4 {
  const { x, y, z } = n
  // prettier-ignore
  return new Matrix4().set(
    1 - 2 * x * x, -2 * x * y,     -2 * x * z,     0,
    -2 * y * x,    1 - 2 * y * y,  -2 * y * z,     0,
    -2 * z * x,    -2 * z * y,     1 - 2 * z * z,  0,
    0,             0,              0,              1
  )
}

const reflected = (m: Matrix4, v: Vec3): Vec3 => {
  const out = new Vector3(v[0], v[1], v[2]).applyMatrix4(m)
  return [out.x, out.y, out.z]
}

const vec = (v: Vector3): Vec3 => [v.x, v.y, v.z]

/** Euler XYZ of a proper rotation, in the form a transform stores. */
function eulerOf(m: Matrix4): Vec3 {
  const e = new Euler().setFromRotationMatrix(m, 'XYZ')
  return [e.x, e.y, e.z]
}

/**
 * The corners of a faceted primitive, deduplicated.
 *
 * Only the faceted kinds have any: a sphere, a cylinder and a capsule are
 * smooth and every plane through their axis is a mirror anyway, so there is
 * nothing here to test them against. Null says "ask the table in
 * `mirrorNormal` instead".
 */
function cornersOf(base: BaseSolid): Vector3[] | null {
  const faces =
    base.kind === 'prism'
      ? prismFaces(base.radius, base.height, base.sides)
      : base.kind === 'pyramid'
        ? pyramidFaces(base.radius, base.height, base.sides)
        : base.kind === 'platonic'
          ? platonicFaces(base.solid, base.radius)
          : null
  return faces === null ? null : cornersOfFaces(faces)
}

/**
 * WHICH PLANE the local model is actually reflected in, for a mirror asked for
 * along `axis`.
 *
 * The requested one wherever the primitive survives it, which is nearly always:
 * a box, a sphere, a cylinder and a bean are all symmetric about all three of
 * their own axis planes, so the answer is the plain axis and the object does
 * not turn at all.
 *
 * Where it does not survive, any mirror plane of the primitive will do, because
 * two reflections of the same object differ by a rotation and the rotation is
 * something a transform can carry. A cone is the clearest case: it is symmetric
 * about every plane containing its axis and about none across it, so a mirror
 * along Y reflects in X instead and the object is turned to compensate. What
 * comes out is exactly the reflected cone, standing exactly where the cone was.
 *
 * NOT ANY PLANE, THOUGH, IF THE PRESS IS TO UNDO ITSELF. The turn that pays for
 * the mismatch is `R . asked . used`, so pressing the same axis twice leaves the
 * object turned by the square of it -- which is the identity only when the plane
 * used is PARALLEL OR PERPENDICULAR to the axis asked for, the two cases where
 * the mismatch is a half turn or nothing at all. A plane at some other angle
 * comes back rotated by four times it, and, since the second press then reflects
 * about an axis the first press moved, a merged object walks its parts round the
 * scene a little further on every press. The axis planes searched below are all
 * parallel or perpendicular to each other, so any of them is safe; the fallback
 * past them is not, and `azimuthAlignment` in `solids.ts` is what keeps every
 * primitive out of it by standing the solid square with its own axes in the
 * first place. `engine-check` holds both ends of that: the alignment, and the
 * press-twice.
 *
 * The faceted kinds are asked rather than tabulated. A regular n-gon has a
 * mirror plane through every corner and every edge midpoint, so WHICH of the
 * three axis planes happen to be among them depends on the side count and on
 * where the ring starts -- a hexagonal prism survives all three and a pentagonal
 * one does not survive Z. Working that out from the corners it actually has
 * cannot drift from the ring `solids.ts` actually builds.
 *
 * An imported mesh returns the requested axis and means it: nothing about a
 * model off a file is symmetric, so its triangles are the thing that gets
 * reflected. See `mirrorBase`.
 */
export function mirrorNormal(base: BaseSolid, axis: Axis): Vector3 {
  const wanted = AXIS_NORMALS[axis]
  switch (base.kind) {
    case 'box':
    case 'sphere':
    case 'cylinder':
    case 'capsule':
    case 'mesh':
      return wanted.clone()
    case 'cone':
      // Round in section, so every plane containing its axis is a mirror -- and
      // the one across the axis is not, since it stands the cone on its point.
      return (axis === 1 ? AXIS_NORMALS[0] : wanted).clone()
    case 'prism':
    case 'pyramid':
    case 'platonic': {
      const corners = cornersOf(base) ?? []
      // The requested plane first, then the other two, so a solid that could
      // have used the plain axis is never turned for nothing. Any of the three
      // keeps the press self-cancelling; what follows them does not.
      for (const n of [wanted, ...AXIS_NORMALS]) {
        if (isMirrorPlane(corners, n)) return n.clone()
      }
      // A leaning plane, reached only by a primitive `azimuthAlignment` could
      // not stand square -- none of the ones built today. It reflects correctly
      // and it is the press-twice that suffers, which is the better half to
      // lose: a mirror that is right once beats one that refuses.
      const [leaning] = mirrorPlanes(corners)
      if (leaning !== undefined) return leaning
      // Unreachable for anything `solids.ts` builds -- every one of them is
      // achiral, so a mirror plane exists. Falling back to the axis keeps a
      // future primitive with no symmetry from throwing at the user.
      return wanted.clone()
    }
  }
}

/**
 * The base as it stands after the reflection.
 *
 * Unchanged for everything parametric, which is the point of choosing the plane
 * the way `mirrorNormal` does. An imported model has no symmetry to choose, so
 * its triangles are genuinely reflected and the ticket in the document is
 * swapped for the one that points at them.
 */
function mirrorBase(base: BaseSolid, axis: Axis): BaseSolid {
  return base.kind === 'mesh' ? { ...base, meshId: mirrorMesh(base.meshId, axis) } : base
}

/**
 * Where the sketch's outline ends up, as a spin in the NEW tangent frame.
 *
 * A frame is right-handed by construction -- uDir cross vDir is the normal, and
 * the whole engine leans on it to keep a swept prism from coming out inside
 * out. A reflection cannot preserve that: the images of uDir and vDir wind the
 * other way about the reflected normal, so the frame the surface hands back on
 * the far side is NOT the reflected one, and the outline has to be re-measured
 * against it.
 *
 * Written in (u, v) the change of frame is a 2D reflection, and every reflection
 * of the plane is a turn about the origin followed by a flip in the u axis --
 * so `R(t) . flip` for one angle t, which the first column reads straight off.
 * The flip is free: a circle, a regular n-gon and a rectangle are all symmetric
 * about the axis their outlines are generated from, so flipping one leaves the
 * same ring of points. What is left is the turn, and the sketch's own spin runs
 * backwards under it.
 */
function mirrorSpin(
  m: Matrix4,
  from: SurfaceDef,
  f: Feature,
  to: SurfaceDef,
  anchor: SurfaceAnchor
): number {
  const image = from.frame(f.anchor).uDir.clone().applyMatrix4(m)
  const next = to.frame(anchor)
  return Math.atan2(image.dot(next.vDir), image.dot(next.uDir))
}

/**
 * The lateral slide of a feature's created end face, restated on the far side.
 *
 * `faceOffset` is measured along the end face's own in-plane axes, and those
 * are derived from the tangent frame -- which has just been reflected and
 * re-derived. So the slide is rebuilt as a VECTOR from the axes it was written
 * in, reflected, and read back off the axes it is written in now. Anything less
 * and a leaning pillar would straighten up as its solid was flipped.
 */
function mirrorFaceOffset(
  m: Matrix4,
  from: SurfaceDef,
  f: Feature,
  to: SurfaceDef,
  anchor: SurfaceAnchor,
  tilt: Vec3
): Vec2 {
  const [offU, offV] = f.faceOffset
  if (offU === 0 && offV === 0) return f.faceOffset

  const before = endFaceFrame(from, f.anchor, f)
  // Asked with no slide of its own: the axes are what is wanted, and they are
  // the same axes whether or not the face has already been slid along them.
  const after = endFaceFrame(to, anchor, { depth: f.depth, tilt, faceOffset: [0, 0] })
  // Depth 0 means there is no created face and the offset is inert; there is
  // nothing to re-measure and nothing that would show if we got it wrong.
  if (before === null || after === null) return f.faceOffset

  const slide = before.inU
    .clone()
    .multiplyScalar(offU)
    .addScaledVector(before.inV, offV)
    .applyMatrix4(m)
  return [slide.dot(after.inU), slide.dot(after.inV)]
}

/**
 * One sketch, moved to the far side of the plane.
 *
 * The anchor is re-derived from the reflected POINT rather than by flipping its
 * parameters, which is what keeps this to one implementation instead of seven.
 * A box face's u,v, a sphere's two angles and a polyhedron's face index all
 * mean different things and all reflect differently; where the point lands is
 * one question with one answer, and `anchorFromHit` is already the function
 * that turns a point on a primitive into the anchor for it -- it is what
 * picking uses for every click on a solid.
 *
 * A sketch on geometry an earlier feature produced has no analytic patch to
 * land on and stays `derived`, carrying its own reflected point and normal.
 */
function mirrorFeature(m: Matrix4, base: BaseSolid, next: BaseSolid, f: Feature): Feature {
  const from = hostSurfaceFor(base, f.anchor)
  const frame = from.frame(f.anchor)
  const origin = frame.origin.clone().applyMatrix4(m)
  const normal = frame.normal.clone().applyMatrix4(m).normalize()
  const derived: SurfaceAnchor = { on: 'derived', point: vec(origin), normal: vec(normal) }

  const anchor =
    f.anchor.on === 'derived' ? derived : (surfaceFor(next).anchorFromHit(origin) ?? derived)
  const to = hostSurfaceFor(next, anchor)

  // The tilt turns the surface normal in OBJECT space, so under a reflection it
  // becomes the same turn seen in the mirror: conjugated, which is a proper
  // rotation again and leaves an untilted feature at exactly [0, 0, 0].
  const spin = new Matrix4().makeRotationFromEuler(new Euler(f.tilt[0], f.tilt[1], f.tilt[2], 'XYZ'))
  const tilt = eulerOf(m.clone().multiply(spin).multiply(m))

  return {
    ...f,
    anchor,
    // Depth is signed along the normal, and the normal has been reflected with
    // everything else -- so a pocket stays a pocket and a boss stays a boss.
    rotation: mirrorSpin(m, from, f, to, anchor) - f.rotation,
    tilt,
    faceOffset: mirrorFaceOffset(m, from, f, to, anchor, tilt),
  }
}

/**
 * A solid nested inside another -- a merged part, or a hole erased out of it --
 * reflected along with its host.
 *
 * Its own contents are reflected in ITS OWN chosen plane, which need not be the
 * plane the host chose: a cone welded into a box is still a cone, and still has
 * to be reflected in a plane it survives. The mismatch lands in the part's
 * rotation, which is exactly where a mismatch belongs -- `host . part` has to
 * come out the same map either way, and it does.
 */
const mirrorNested =
  (m: Matrix4, axis: Axis) =>
  (nested: SceneObject): SceneObject => {
    const inner = reflectionOf(mirrorNormal(nested.base, axis))
    const [rx, ry, rz] = nested.transform.rotation
    const turn = new Matrix4().makeRotationFromEuler(new Euler(rx, ry, rz, 'XYZ'))
    return {
      ...mirrorSolids(nested, axis),
      transform: {
        position: reflected(m, nested.transform.position),
        // host . rotation . part, with each reflection its own inverse.
        rotation: eulerOf(m.clone().multiply(turn).multiply(inner)),
      },
    }
  }

/** The solids alone: bases, the sketches on them, the cuts through them and the
 *  marks burnt into them, every one restated on the far side of the plane. */
function mirrorSolids(obj: SceneObject, axis: Axis): SceneObject {
  const m = reflectionOf(mirrorNormal(obj.base, axis))
  const base = mirrorBase(obj.base, axis)

  return {
    ...obj,
    base,
    // Conformed for the reason a scale conforms: the anchor comes back from a
    // point solve rather than from arithmetic on its own parameters, so a
    // sketch that lands a hair over the edge of its face is pulled back onto
    // it instead of hanging off one.
    features: obj.features.map((f) => conform(base, mirrorFeature(m, obj.base, base, f))),
    // A cut is a plane in this object's space. Reflecting the origin and the
    // normal reflects the plane; the side is left alone, because the half that
    // was kept is the half whose image is now on the same side of the image of
    // the normal.
    cuts: obj.cuts.map((c) => ({
      ...c,
      origin: reflected(m, c.origin),
      normal: reflected(m, c.normal),
    })),
    parts: obj.parts.map(mirrorNested(m, axis)),
    ...(obj.erased ? { erased: obj.erased.map(mirrorNested(m, axis)) } : {}),
    // A dab is a place in this object's space, like a cut's origin -- how hard
    // it bit and which way it bit are facts about the tool, and a mirror does
    // not change either.
    ...(obj.erosion
      ? { erosion: obj.erosion.map((d) => ({ ...d, at: reflected(m, d.at) })) }
      : {}),
  }
}

/**
 * Reflect the whole object -- every solid merged into it -- in the plane through
 * its own centre, perpendicular to one of ITS OWN axes.
 *
 * Its own axes rather than the world's, which is the choice the Scale gizmo
 * already made and for the same reason: there is no such thing as a solid that
 * is left-handed along world X. Which way round a shape is is a fact about the
 * shape, so a part you have turned is flipped along its own length rather than
 * along whatever the world happens to call length from where you are standing.
 *
 * About its CENTRE, so a merged assembly stays where it was put -- the point
 * the gizmo sits on does not move, which is the same promise `scaleAssembly`
 * makes. For a bare solid the centre IS the local origin and the transform
 * comes through untouched.
 *
 * The rotation is where the awkwardness of the primitives is paid for. The
 * model has been reflected in whichever plane its base survives; asked for a
 * different one, the two differ by a turn, and `R . S . M` is that turn -- for
 * the common case where the plane asked for is the plane used, S and M are the
 * same reflection, they cancel, and nothing rotates.
 */
export function mirrorAssembly(obj: SceneObject, axis: Axis): SceneObject {
  const asked = reflectionOf(AXIS_NORMALS[axis])
  const used = reflectionOf(mirrorNormal(obj.base, axis))
  const [rx, ry, rz] = obj.transform.rotation
  const turn = new Matrix4().makeRotationFromEuler(new Euler(rx, ry, rz, 'XYZ'))

  // The centre reflects with the model, so holding it still is a matter of
  // giving back however far it moved -- in world terms, hence the turn.
  const centre = new Vector3(...assemblyCentre(obj))
  const shift = centre
    .clone()
    .sub(centre.clone().applyMatrix4(asked))
    .applyMatrix4(turn)
  const [x, y, z] = obj.transform.position

  return {
    ...mirrorSolids(obj, axis),
    transform: {
      position: [x + shift.x, y + shift.y, z + shift.z],
      rotation: eulerOf(turn.clone().multiply(asked).multiply(used)),
    },
  }
}
