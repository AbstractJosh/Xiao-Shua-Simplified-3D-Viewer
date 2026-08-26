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
  planes.sort(
    (a, b) =>
      b.normal.y - a.normal.y ||
      Math.atan2(a.normal.x, a.normal.z) - Math.atan2(b.normal.x, b.normal.z)
  )

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
 * Face patches for a platonic solid, standing the way a person would set it
 * down.
 *
 * A tetrahedron and a dodecahedron both rest on a face, so the hull is walked
 * once in the textbook orientation purely to learn where a face points, and the
 * vertices are then rotated to drop that face onto -Y. Every face of a platonic
 * solid is equivalent, so any of them will do -- and for the dodecahedron this
 * also lands the opposite face on top, giving it a real axis along +Y.
 *
 * The octahedron is left alone: its canonical pose already has a symmetry axis
 * along +Y, and tipping it onto a face would only make it look broken.
 */
export function platonicFaces(kind: PlatonicKind, radius: number): FacePatch[] {
  const verts = platonicVertices(kind, radius)
  if (kind === 'octahedron') return convexFaces(verts)
  const q = new Quaternion().setFromUnitVectors(
    convexFaces(verts)[0].normal,
    new Vector3(0, -1, 0)
  )
  return convexFaces(verts.map((v) => v.applyQuaternion(q)))
}

export function platonic(kind: PlatonicKind, radius: number): FacetedSolid {
  const faces = platonicFaces(kind, radius)
  return { geometry: facesToGeometry(faces), faces }
}
