import { Material } from 'three'
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
 * Groups are the ONE thing that may survive, and only when the caller says so.
 * A group is how a boolean result remembers which solid each triangle came from
 * -- see `paintMaterial` -- so a geometry that carries paint has to keep them,
 * while a freshly built primitive's six box faces are exactly the noise this
 * strips.
 *
 * Must be called BEFORE the geometry is handed to a Brush: the library also
 * warns that geometry may not be modified once a Brush owns it.
 */
export function normalizeGeometry(geom: BufferGeometry, keepGroups = false): BufferGeometry {
  for (const name of Object.keys(geom.attributes)) {
    if (name !== 'position' && name !== 'normal') geom.deleteAttribute(name)
  }
  if (!geom.getAttribute('normal')) geom.computeVertexNormals()
  if (!keepGroups) geom.clearGroups()
  return geom
}

/**
 * A PAINT KEY names the solid a triangle came from -- an object id, or the id
 * of one of the parts merged into it.
 *
 * The evaluator carries materials through a boolean: it concatenates the two
 * inputs' material lists, writes a group per surviving material, and folds
 * groups that point at the SAME material object into one. So handing it a
 * stand-in material per source solid makes the result self-describing: every
 * triangle lands in the group of whichever solid contributed it, all the way
 * through a union, a pocket and a cut.
 *
 * These are stand-ins, never rendered. They carry a name and nothing else --
 * the viewport reads the name back out and looks up the colour the document
 * holds for that id. Which is the whole point of doing it this way rather than
 * baking colours into a vertex attribute: RECOLOURING TOUCHES NO GEOMETRY. The
 * boolean result is about which solid, not about which colour, so a repaint is
 * a material prop and never a re-solve.
 *
 * Memoised because identity is the whole mechanism -- two brushes from the same
 * solid must hand the evaluator the SAME object or their groups will not merge.
 */
const paintMaterials = new Map<string, Material>()

export function paintMaterial(key: string): Material {
  const cached = paintMaterials.get(key)
  if (cached) return cached
  const material = new Material()
  material.name = key
  paintMaterials.set(key, material)
  return material
}

/**
 * The paint key of every group in a brush's geometry, indexed to match the
 * groups' `materialIndex`.
 *
 * The evaluator prunes materials nothing points at, so this is exactly the set
 * of solids VISIBLE in the result -- a part swallowed whole by the solid it was
 * merged into leaves no group and no entry here.
 */
export function paintsOf(brush: Brush): string[] {
  const material = brush.material
  return Array.isArray(material) ? material.map((m) => m.name) : [material.name]
}

/**
 * Wrap a geometry as a brush, painted.
 *
 * A single key is the ordinary case: one solid, one paint, and any groups the
 * geometry arrived with are noise to be cleared. A LIST is for geometry that
 * already came out of a boolean and carries groups of its own -- a merged part
 * being welded into its host -- where the groups and the list are two halves of
 * the same fact and neither survives alone.
 */
export function makeBrush(geom: BufferGeometry, paint: string | string[]): Brush {
  const grouped = Array.isArray(paint)
  const material = grouped ? paint.map(paintMaterial) : paintMaterial(paint)
  const brush = new Brush(normalizeGeometry(geom, grouped), material)
  // Brushes are evaluated in world space, so the matrix must be current.
  brush.updateMatrixWorld(true)
  return brush
}

const evaluator = new Evaluator()
// On, so the result remembers which solid each triangle came from. See
// `paintMaterial`: with it off every boolean collapses to one material and a
// merge of a red cube and a blue one comes back a single colour.
evaluator.useGroups = true
evaluator.attributes = ['position', 'normal']

/** Run one boolean operation. Inputs are left untouched. */
export function csg(a: Brush, b: Brush, op: CSGOperation): Brush {
  const result = evaluator.evaluate(a, b, op)
  result.updateMatrixWorld(true)
  return result
}

/**
 * Release a brush's geometry. Intermediates pile up fast while dragging.
 *
 * The MATERIALS are left alone: they are the shared paint stand-ins, held by
 * every brush cut from the same solid, and disposing one here would pull it out
 * from under all of them.
 */
export function disposeBrush(brush: Brush | null | undefined): void {
  brush?.geometry?.dispose()
}

/** Drop the paint stand-ins. Only safe once every brush holding one is gone. */
export function forgetPaints(): void {
  paintMaterials.clear()
}
