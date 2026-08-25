import type { BufferGeometry } from 'three'
import {
  ADDITION,
  Brush,
  type CSGOperation,
  Evaluator,
  INTERSECTION,
  SUBTRACTION,
} from 'three-bvh-csg'

export { ADDITION, INTERSECTION, SUBTRACTION }
export type { CSGOperation }

/**
 * three-bvh-csg requires that "all geometry are expected to have all attributes
 * being used and of the same type". A BoxGeometry ships six groups and a uv
 * set, a hand-built prism ships neither -- feed those to the same evaluator and
 * the output is silently malformed. Normalising every brush to position+normal
 * removes the whole class of problem.
 *
 * Must be called BEFORE the geometry is handed to a Brush: the library also
 * warns that geometry may not be modified once a Brush owns it.
 */
export function normalizeGeometry(geom: BufferGeometry): BufferGeometry {
  for (const name of Object.keys(geom.attributes)) {
    if (name !== 'position' && name !== 'normal') geom.deleteAttribute(name)
  }
  if (!geom.getAttribute('normal')) geom.computeVertexNormals()
  geom.clearGroups()
  return geom
}

export function makeBrush(geom: BufferGeometry): Brush {
  const brush = new Brush(normalizeGeometry(geom))
  // Brushes are evaluated in world space, so the matrix must be current.
  brush.updateMatrixWorld(true)
  return brush
}

const evaluator = new Evaluator()
evaluator.useGroups = false
evaluator.attributes = ['position', 'normal']

/** Run one boolean operation. Inputs are left untouched. */
export function csg(a: Brush, b: Brush, op: CSGOperation): Brush {
  const result = evaluator.evaluate(a, b, op)
  result.updateMatrixWorld(true)
  return result
}

/** Release a brush's geometry. Intermediates pile up fast while dragging. */
export function disposeBrush(brush: Brush | null | undefined): void {
  brush?.geometry?.dispose()
}
