import { Vector3 } from 'three'
import type { BufferGeometry } from 'three'

/**
 * Signed volume of a triangle mesh by the divergence theorem.
 *
 * One number answers two questions at once, which is why this is the workhorse
 * of the headless checks: for a closed, consistently wound mesh it is the true
 * enclosed volume, so it verifies both that a boolean moved the right amount of
 * material AND that the result is watertight. A mesh that leaks or is inside
 * out cannot accidentally land on the analytic answer.
 *
 * The sign is the tell for winding: outward-facing triangles give a positive
 * result, an inverted mesh a negative one.
 */
export function signedVolume(geometry: BufferGeometry): number {
  const pos = geometry.getAttribute('position')
  if (!pos) return 0

  const index = geometry.getIndex()
  const triCount = Math.floor((index ? index.count : pos.count) / 3)

  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  const cross = new Vector3()

  let volume = 0
  for (let t = 0; t < triCount; t++) {
    const base = t * 3
    a.fromBufferAttribute(pos, index ? index.getX(base) : base)
    b.fromBufferAttribute(pos, index ? index.getX(base + 1) : base + 1)
    c.fromBufferAttribute(pos, index ? index.getX(base + 2) : base + 2)
    // Each triangle contributes the tetrahedron it forms with the origin. The
    // origin cancels out over a closed surface, so it need not be inside.
    cross.crossVectors(b, c)
    volume += a.dot(cross) / 6
  }
  return volume
}
