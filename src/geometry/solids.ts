/**
 * Construction of the faceted primitives, in the one representation the feature
 * engine can anchor to: a list of convex POLYGONAL faces, not a soup of
 * triangles. A dodecahedron exposed as 36 triangles would clamp every sketch
 * dropped on it to a sliver, because the clamp keeps the outline inside the
 * polygon of the face it landed on.
 *
 * The render geometry is rebuilt FROM the faces, so the patches tile the
 * rendered solid exactly by construction rather than by two pieces of code
 * happening to agree.
 *
 * Rings run (r sin theta, y, r cos theta) to match three.js's lathe family
 * (CylinderGeometry, ConeGeometry). Holding that convention here is what lets a
 * cylinder's cap patch sit exactly on the cap the renderer draws.
 */
import { BufferAttribute, BufferGeometry, Quaternion, Vector3 } from 'three'
import type { Point2 } from './outline'
import type { PlatonicKind } from './types'

/**
 * One flat face of a convex solid. `polygon` is the outline in the face's own
 * (u,v) frame, wound CCW seen from outside and measured in OBJECT UNITS from
 * `origin` -- which is exactly what a 'planar-face' anchor's u,v mean.
 *
 * uDir cross vDir === normal, the rule the whole engine leans on: a CCW outline
 * in a tangent frame faces outward, so the swept prism is not inside out.
 */
export type FacePatch = {
  normal: Vector3
  origin: Vector3
  uDir: Vector3
  vDir: Vector3
  polygon: Point2[]
}

export type FacetedSolid = { geometry: BufferGeometry; faces: FacePatch[] }

const EPS = 1e-9
const X_AXIS = new Vector3(1, 0, 0)

/**
 * How close two face normals must be in height before the azimuth decides which
 * comes first.
 *
 * Wide enough to swallow the rounding in a cross product of vertices scaled by
 * an arbitrary radius, and far narrower than the gap between two genuinely
 * different bands of faces -- the closest on any solid here are a
 * dodecahedron's, about 0.45 apart.
 */
const ORDER_EPS = 1e-9

/**
 * Where a face points around Y, as the key the ordering below sorts on.
 *
 * `atan2` is cut along -Z: a normal lying on that axis reads -pi or +pi
 * depending on nothing more than the SIGN OF A ZERO in its x, which is whatever
 * the cross product that made it happened to round to and which moves with the
 * radius. Two faces a hair either side of the cut are a hair apart in fact and
 * a whole turn apart in the key, so the one on it changes ends of the face list
 * at some arbitrary size -- the same anchor-breaking churn the height tolerance
 * above exists to prevent, reached the other way.
 *
 * Pinned to +pi rather than averaged away, because the two readings name the
 * SAME direction and the sort only needs them to agree on which.
 */
function faceAzimuth(normal: Vector3): number {
  const a = Math.atan2(normal.x, normal.z)
  return Math.abs(a) > Math.PI - ORDER_EPS ? Math.PI : a
}

/** Point on a face at (u,v) in that face's frame. */
export function facePoint(face: FacePatch, u: number, v: number): Vector3 {
  return face.origin.clone().addScaledVector(face.uDir, u).addScaledVector(face.vDir, v)
}

/** A face's outline back in object space, in winding order. */
export function faceVertices(face: FacePatch): Vector3[] {
  return face.polygon.map(([u, v]) => facePoint(face, u, v))
}

/**
 * Triangulate every face and weld the result into one mesh.
 *
 * Fan triangulation is valid because every face here is convex. The result is
 * non-indexed so computeVertexNormals yields flat per-triangle normals, which
 * is what a faceted solid should shade like.
 */
export function facesToGeometry(faces: FacePatch[]): BufferGeometry {
  const verts: number[] = []
  for (const face of faces) {
    const pts = faceVertices(face)
    for (let i = 1; i < pts.length - 1; i++) {
      for (const p of [pts[0], pts[i], pts[i + 1]]) verts.push(p.x, p.y, p.z)
    }
  }
  const geom = new BufferGeometry()
  geom.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3))
  geom.computeVertexNormals()
  return geom
}

/**
 * Newell's normal, summed as a cross product of successive vertices. That form
 * is independent of where the origin sits, so it stays exact for a face far
 * from the centre of the solid.
 */
function loopNormal(loop: Vector3[]): Vector3 {
  const n = new Vector3()
  for (let i = 0; i < loop.length; i++) {
    n.add(new Vector3().crossVectors(loop[i], loop[(i + 1) % loop.length]))
  }
  return n.normalize()
}

function loopCentroid(loop: Vector3[]): Vector3 {
  const c = new Vector3()
  for (const p of loop) c.add(p)
  return c.divideScalar(loop.length || 1)
}

/**
 * Turn a closed loop, wound CCW seen from outside, into a face patch.
 *
 * `uHint` picks which in-plane direction becomes u. It matters: on a prism's
 * side wall the hint is the horizontal tangent, which drops vDir onto +Y so a
 * sketch's "up" is the solid's up. Without a hint the first edge is used, which
 * is all a platonic face can offer.
 */
export function facePatch(loop: Vector3[], uHint?: Vector3): FacePatch {
  const normal = loopNormal(loop)
  const origin = loopCentroid(loop)

  const inPlane = (d: Vector3) => d.clone().addScaledVector(normal, -d.dot(normal))
  let uDir = uHint ? inPlane(uHint) : new Vector3()
  if (uDir.lengthSq() < EPS) uDir = inPlane(new Vector3().subVectors(loop[1], loop[0]))
  uDir.normalize()

  const vDir = new Vector3().crossVectors(normal, uDir)
  const polygon = loop.map((p): Point2 => {
    const rel = p.clone().sub(origin)
    return [rel.dot(uDir), rel.dot(vDir)]
  })
  return { normal, origin, uDir, vDir, polygon }
}

/** Regular ring in the lathe convention, wound so its normal is +Y. */
function ring(radius: number, sides: number, y: number): Vector3[] {
  const pts: Vector3[] = []
  for (let k = 0; k < sides; k++) {
    const theta = (2 * Math.PI * k) / sides
    pts.push(new Vector3(radius * Math.sin(theta), y, radius * Math.cos(theta)))
  }
  return pts
}

/** Horizontal in-plane direction on the wall at `theta`, chosen so vDir is +Y. */
function wallTangent(theta: number): Vector3 {
  return new Vector3(Math.cos(theta), 0, -Math.sin(theta))
}

/**
 * A flat n-gon disc at height `y`, facing up or down. Used for the ends of a
 * cylinder and the base of a cone, where the curved wall is analytic but the
 * caps are ordinary planar faces.
 */
export function discFace(
  radius: number,
  y: number,
  sides: number,
  up: boolean
): FacePatch {
  const loop = ring(radius, sides, y)
  // The +X hint reproduces BoxGeometry's own +Y / -Y face frames, so a sketch
  // on a cylinder cap and one on a cube's top read the same way in the panel.
  return facePatch(up ? loop : loop.reverse(), X_AXIS)
}

// --- Prism / pyramid --------------------------------------------------------

function sideCount(sides: number): number {
  return Math.max(3, Math.round(sides))
}

export function prismFaces(radius: number, height: number, sides: number): FacePatch[] {
  const n = sideCount(sides)
  const top = ring(radius, n, height / 2)
  const bottom = ring(radius, n, -height / 2)
  const faces: FacePatch[] = [
    facePatch(top, X_AXIS),
    facePatch([...bottom].reverse(), X_AXIS),
  ]
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n
    const mid = (2 * Math.PI * (k + 0.5)) / n
    faces.push(facePatch([bottom[j], top[j], top[k], bottom[k]], wallTangent(mid)))
  }
  return faces
}

export function pyramidFaces(
  radius: number,
  height: number,
  sides: number
): FacePatch[] {
  const n = sideCount(sides)
  const base = ring(radius, n, -height / 2)
  const apex = new Vector3(0, height / 2, 0)
  const faces: FacePatch[] = [facePatch([...base].reverse(), X_AXIS)]
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n
    const mid = (2 * Math.PI * (k + 0.5)) / n
    faces.push(facePatch([base[j], apex, base[k]], wallTangent(mid)))
  }
  return faces
}

export function prism(radius: number, height: number, sides: number): FacetedSolid {
  const faces = prismFaces(radius, height, sides)
  return { geometry: facesToGeometry(faces), faces }
}

export function pyramid(radius: number, height: number, sides: number): FacetedSolid {
  const faces = pyramidFaces(radius, height, sides)
  return { geometry: facesToGeometry(faces), faces }
}

// --- Platonic solids --------------------------------------------------------

const PHI = (1 + Math.sqrt(5)) / 2

/** Vertices in their textbook orientation, pushed out to circumradius `radius`. */
function platonicVertices(kind: PlatonicKind, radius: number): Vector3[] {
  const raw: Vector3[] = []
  switch (kind) {
    case 'tetrahedron':
      raw.push(
        new Vector3(1, 1, 1),
        new Vector3(1, -1, -1),
        new Vector3(-1, 1, -1),
        new Vector3(-1, -1, 1)
      )
      break
    case 'octahedron':
      for (const s of [1, -1]) {
        raw.push(new Vector3(s, 0, 0), new Vector3(0, s, 0), new Vector3(0, 0, s))
      }
      break
    case 'dodecahedron':
      for (const x of [1, -1]) {
        for (const y of [1, -1]) {
          for (const z of [1, -1]) raw.push(new Vector3(x, y, z))
        }
      }
      for (const a of [1, -1]) {
        for (const b of [1, -1]) {
          raw.push(new Vector3(0, a / PHI, b * PHI))
          raw.push(new Vector3(a / PHI, b * PHI, 0))
          raw.push(new Vector3(a * PHI, 0, b / PHI))
        }
      }
      break
  }
  return raw.map((v) => v.normalize().multiplyScalar(radius))
}

/**
 * Face patches of the convex hull of a point set.
 *
 * Every plane spanned by three vertices that leaves all the others on one side
 * is a face; its vertices are everything lying on that plane, which is what
 * recovers a dodecahedron's PENTAGONS instead of the triangles a mesh would
 * give. The triple walk is O(n^3), but n is at most 20 here -- cheaper than a
 * single boolean, and it runs once per surface lookup.
 */
function convexFaces(verts: Vector3[]): FacePatch[] {
  const scale = Math.max(1, ...verts.map((v) => v.length()))
  const tol = 1e-6 * scale
  const planes: { normal: Vector3; d: number }[] = []

  for (let i = 0; i < verts.length; i++) {
    for (let j = i + 1; j < verts.length; j++) {
      for (let k = j + 1; k < verts.length; k++) {
        const normal = new Vector3()
          .subVectors(verts[j], verts[i])
          .cross(new Vector3().subVectors(verts[k], verts[i]))
        if (normal.lengthSq() < tol * tol) continue
        normal.normalize()
        let d = normal.dot(verts[i])

        let above = false
        let below = false
        for (const v of verts) {
          const s = normal.dot(v) - d
          if (s > tol) above = true
          if (s < -tol) below = true
        }
        // Vertices on both sides: an interior plane, not a face.
        if (above && below) continue
        if (above) {
          normal.negate()
          d = -d
        }

        const seen = planes.some(
          (p) => p.normal.dot(normal) > 1 - 1e-9 && Math.abs(p.d - d) <= tol
        )
        if (!seen) planes.push({ normal, d })
      }
    }
  }

  // Face indices live in saved anchors, so the order has to be reproducible
  // rather than an accident of the walk above.
  //
  // Height first, then azimuth -- but height is compared with a TOLERANCE,
  // because on a platonic solid whole bands of faces share one exactly. A
  // dodecahedron resting on a face has two rings of five, and `a.normal.y -
  // b.normal.y` puts those five in whatever order the last bit of the cross
  // products happened to land in. That order then moves with the circumradius,
  // which is how a saved `planar-face` anchor ends up naming a different face
  // after nothing more than a resize.
  //
  // The azimuth is taken through `faceAzimuth` for the same reason in the other
  // direction: it is the one key here with a DISCONTINUITY in it, and a face
  // pointing along -Z sits exactly on it.
  planes.sort((a, b) => {
    const height = b.normal.y - a.normal.y
    if (Math.abs(height) > ORDER_EPS) return height
    return faceAzimuth(a.normal) - faceAzimuth(b.normal)
  })

  return planes.map(({ normal, d }) => {
    const on = verts.filter((v) => Math.abs(normal.dot(v) - d) <= tol)
    const centre = loopCentroid(on)
    const t1 = on[0].clone().sub(centre).normalize()
    const t2 = new Vector3().crossVectors(normal, t1)
    // Ascending angle in a (t1, t2, normal) right-handed frame is CCW seen
    // from outside, which is the winding facePatch expects.
    const loop = [...on].sort((a, b) => {
      const ra = a.clone().sub(centre)
      const rb = b.clone().sub(centre)
      return Math.atan2(ra.dot(t2), ra.dot(t1)) - Math.atan2(rb.dot(t2), rb.dot(t1))
    })
    return facePatch(loop)
  })
}

/**
 * The distinct corners of a set of face patches.
 *
 * Deduplicated, because every corner is named once per face that meets there
 * and the symmetry tests below have to count it once.
 */
export function cornersOfFaces(faces: FacePatch[]): Vector3[] {
  const corners: Vector3[] = []
  for (const face of faces) {
    for (const v of faceVertices(face)) {
      if (!corners.some((w) => w.distanceToSquared(v) < 1e-12)) corners.push(v)
    }
  }
  return corners
}

/** How far apart two corners may be and still be the same corner. Relative to
 *  the solid's own reach, since a radius here is a user's number. */
function cornerTolerance(corners: Vector3[]): number {
  const reach = Math.max(1, ...corners.map((v) => v.length()))
  return (1e-6 * reach) ** 2
}

/** Does reflecting in the plane through the origin with this normal leave the
 *  corner set exactly where it was? */
export function isMirrorPlane(corners: Vector3[], n: Vector3): boolean {
  const tol = cornerTolerance(corners)
  return corners.every((v) => {
    const image = v.clone().addScaledVector(n, -2 * v.dot(n))
    return corners.some((w) => w.distanceToSquared(image) < tol)
  })
}

/**
 * Every plane the corner set is genuinely symmetric about.
 *
 * A reflection that is not the identity has to SWAP at least one pair of
 * corners -- if it fixed them all they would every one lie in the plane, and
 * the solid would be flat. The plane of a swap is the perpendicular bisector of
 * the pair, and since a symmetry fixes the solid's centre, that bisector passes
 * through the origin exactly when the two corners are the same distance from
 * it. So: every equidistant pair, one candidate each, kept if it really is a
 * mirror. Twenty corners is a dodecahedron, the largest of these, so the walk
 * is trivial.
 */
export function mirrorPlanes(corners: Vector3[]): Vector3[] {
  const out: Vector3[] = []
  const tol = cornerTolerance(corners)
  for (let i = 0; i < corners.length; i++) {
    for (let j = i + 1; j < corners.length; j++) {
      const a = corners[i]
      const b = corners[j]
      if (Math.abs(a.lengthSq() - b.lengthSq()) > tol) continue
      const n = new Vector3().subVectors(a, b)
      if (n.lengthSq() < tol) continue
      n.normalize()
      // A plane is one plane however many pairs of corners name it, and n and
      // -n are the same plane.
      if (out.some((w) => Math.abs(Math.abs(w.dot(n)) - 1) < 1e-9)) continue
      if (isMirrorPlane(corners, n)) out.push(n)
    }
  }
  return out
}

/** The three axis planes, as the normals that name them. */
const AXIS_NORMALS = [
  new Vector3(1, 0, 0),
  new Vector3(0, 1, 0),
  new Vector3(0, 0, 1),
] as const

/** The same angle, brought to the smallest spin that reaches the same PLANE:
 *  a turn of pi about Y lands a plane's normal back on its own axis. */
function smallestHalfTurn(angle: number): number {
  let a = angle
  while (a > Math.PI / 2) a -= Math.PI
  while (a <= -Math.PI / 2) a += Math.PI
  return a
}

/**
 * The extra spin about Y that lands one of the solid's OWN mirror planes on one
 * of its own axis planes.
 *
 * The azimuth of a resting solid is free -- dropping a face onto -Y says which
 * way is down and nothing about which way it faces -- and `setFromUnitVectors`
 * spends that freedom on whatever the shortest arc happens to be. This spends
 * it deliberately instead, because the app asks a solid to be symmetric about
 * its own axes rather than about some plane at 15 degrees to them: the MIRROR
 * is the caller that cares. `mirrorAssembly` reflects a primitive in a plane
 * the primitive survives and pays for the difference with a turn of the whole
 * object, and that turn is only self-cancelling -- press X twice, get the
 * object back -- when the plane it used is parallel or perpendicular to the
 * axis asked for. A tetrahedron dropped onto a face by the shortest arc has its
 * three mirror planes at 45, 105 and 165 degrees, none of them either, so it
 * came back from a second press rotated by four times the mismatch. Fifteen
 * degrees of azimuth nobody can see is the whole fix.
 *
 * Nothing for a solid already square with its axes, which is every one of them
 * but the tetrahedron -- the octahedron takes no resting turn at all and the
 * dodecahedron's shortest arc happens to land square. And nothing, rather than
 * a guess, for a solid whose mirror planes all lean out of the upright: a spin
 * about Y cannot bring those onto an axis, and tilting one that rests on a face
 * to chase symmetry would stand it on an edge.
 */
function azimuthAlignment(corners: Vector3[]): Quaternion {
  const none = new Quaternion()
  if (AXIS_NORMALS.some((n) => isMirrorPlane(corners, n))) return none
  const upright = mirrorPlanes(corners).filter((n) => Math.abs(n.y) < 1e-9)
  if (upright.length === 0) return none
  // Onto X rather than Z for no reason beyond having to pick one: the two are
  // the same plane set seen a quarter turn apart.
  const angle = upright
    .map((n) => smallestHalfTurn(Math.atan2(n.z, n.x)))
    .reduce((best, a) => (Math.abs(a) < Math.abs(best) ? a : best))
  return new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle)
}

/**
 * How far a platonic solid is turned to stand the way a person would set it
 * down, worked out ONCE per kind at unit size.
 *
 * A tetrahedron and a dodecahedron both rest on a face, so the hull is walked in
 * the textbook orientation purely to learn where a face points, and the vertices
 * are then rotated to drop that face onto -Y. Every face of a platonic solid is
 * equivalent, so any of them will do -- and for the dodecahedron this also lands
 * the opposite face on top, giving it a real axis along +Y.
 *
 * The octahedron gets no turn: its canonical pose already has a symmetry axis
 * along +Y, and tipping it onto a face would only make it look broken.
 *
 * THE DROP DECIDES WHICH WAY IS DOWN AND NOTHING ELSE, so the azimuth left over
 * is spent squaring the solid's own mirror planes with its own axes rather than
 * left to the shortest arc. See `azimuthAlignment` for why the mirror needs it.
 *
 * Cached, and measured at radius 1, because HOW A SHAPE STANDS IS NOT A
 * FUNCTION OF ITS SIZE. Derived per call from vertices already scaled by the
 * radius, it very nearly is: the walk picks whichever face sorts first, the
 * faces tie, and the tie is settled by rounding that moves with the radius. A
 * dodecahedron dragged bigger would snap round its own axis by 36 degrees
 * whenever the tie fell the other way, and a tetrahedron would tip onto a
 * different face outright.
 */
const restingTurns = new Map<PlatonicKind, Quaternion>()

function restingTurn(kind: PlatonicKind): Quaternion {
  const cached = restingTurns.get(kind)
  if (cached) return cached
  const drop = new Quaternion().setFromUnitVectors(
    convexFaces(platonicVertices(kind, 1))[0].normal,
    new Vector3(0, -1, 0)
  )
  const dropped = platonicVertices(kind, 1).map((v) => v.applyQuaternion(drop))
  // Spin after the drop, so the face that was landed on stays landed on.
  const turn = azimuthAlignment(dropped).multiply(drop)
  restingTurns.set(kind, turn)
  return turn
}

/** Face patches for a platonic solid, standing the way a person would set it down. */
export function platonicFaces(kind: PlatonicKind, radius: number): FacePatch[] {
  const verts = platonicVertices(kind, radius)
  if (kind === 'octahedron') return convexFaces(verts)
  const turn = restingTurn(kind)
  return convexFaces(verts.map((v) => v.applyQuaternion(turn)))
}

export function platonic(kind: PlatonicKind, radius: number): FacetedSolid {
  const faces = platonicFaces(kind, radius)
  return { geometry: facesToGeometry(faces), faces }
}
