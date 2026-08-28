import type { BaseSolid, Shape2D, Vec3 } from './types'

/**
 * What resizing a primitive ALONG ONE AXIS means, for each of the eight kinds.
 *
 * This exists because two places now ask the question and they must not answer
 * it differently: the console's dimension fields, and the gizmo's arrows. The
 * gizmo is the reason it is geometry rather than a detail of the panel -- a
 * drag on the X arrow in Scale has to know that X is a box's width, a
 * cylinder's radius, and, on a sphere, the only dimension there is.
 *
 * Everything here works in the primitive's OWN frame, because that is the frame
 * `BaseSolid` is written in: every solid is centred on the local origin and
 * stands along +Y, so axis 1 is the one that means "height" wherever a solid
 * has one.
 */

export type Axis = 0 | 1 | 2

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Slider bounds, in scene units -- and ONE SCENE UNIT IS TEN CENTIMETRES.
 *
 * That mapping is the reason these numbers are what they are. A five-metre
 * object is fifty units, not five hundred, and fifty is a magnitude float32
 * still resolves finely: the weld tolerance in `brep.ts` has to clear the
 * float32 step at the largest coordinate in the scene, and that step grows with
 * the coordinate. Ten centimetres to the unit buys a room-sized envelope
 * without ever leaving the range the B-rep layer can weld.
 *
 * The floor is a millimetre, which is what makes the range 5000:1 -- wide
 * enough that the weld tolerance can no longer be one number for every model.
 * See `weldToleranceFor` in `brep.ts`.
 */
export const MIN_DIMENSION = 0.01
export const MAX_SIZE = 50
export const MAX_RADIUS = 25

/**
 * How far a created face may slide within its own plane.
 *
 * Lives here rather than in either of its two users -- the Inspector's slider
 * and the viewport's drag -- because the two MUST agree: a drag allowed to
 * out-run the panel leaves a slider pinned at its end while the face keeps
 * moving. It was the same literal written down in both files, kept in step by
 * hand.
 */
export const MAX_FACE_OFFSET = 10

/**
 * Sketches are detail work and go far smaller than a solid ever does.
 *
 * Half a millimetre, and it is a WELD floor rather than a taste one. A circular
 * outline is 48 segments (`outline.ts`), so its chord is `2r sin(pi/48)` --
 * about 0.131 of the radius. Let the radius reach 0.002 and that chord is
 * 2.6e-4, against a weld tolerance of 1.2e-4 at the far corner of the world:
 * near enough that two neighbouring points on the circle would collapse into
 * one, and the sketch would arrive in the STEP file as a polygon with corners
 * missing. At 0.005 the chord clears the weld five times over.
 */
export const MIN_SHAPE = 0.005

/**
 * Sensible upper bound for a sketch on a given solid, so it cannot be grown
 * past the face it sits on.
 *
 * Lives here, beside the solid dimensions, because two places ask: the
 * Inspector's Radius and Width fields, and the sketch gizmo's ring. A bound
 * only one of them honoured would let a drag build a sketch the panel then
 * refused to show.
 */
export function maxShapeSize(base: BaseSolid): number {
  switch (base.kind) {
    case 'box':
    // An imported model measures like a box and bounds a sketch like one. It is
    // the loosest of the eight bounds -- a mesh's actual surface wanders about
    // inside its box rather than filling it -- but a sketch on one lands on a
    // DERIVED anchor, which has no face to be clamped to in the first place.
    case 'mesh':
      return Math.min(...base.size) / 2
    case 'sphere':
    case 'platonic':
    case 'cylinder':
    case 'cone':
    case 'capsule':
    case 'pyramid':
    case 'prism':
      return base.radius * 0.9
  }
}

/**
 * Scale a 2D outline about its own centre.
 *
 * Every dimension moves by one factor, clamped ONCE against the tightest bound
 * any of them imposes -- the same rule `scaleUniform` follows for solids, and
 * for the same reason: clamping a rectangle's width and height separately would
 * let a long thin one hit the ceiling on one side and keep fattening on the
 * other, quietly changing an aspect ratio the user never asked to change.
 *
 * `max` is the radius-like bound; a rectangle's sides are full extents and get
 * twice it, which is exactly what the Inspector's own fields offer.
 */
export function scaleShape(shape: Shape2D, factor: number, max: number): Shape2D {
  const dims: number[] = shape.type === 'rect' ? [shape.w, shape.h] : [shape.r]
  const ceiling = shape.type === 'rect' ? max * 2 : max

  let lo = 0
  let hi = Infinity
  for (const value of dims) {
    lo = Math.max(lo, MIN_SHAPE / value)
    hi = Math.min(hi, ceiling / value)
  }
  const f = clamp(factor, lo, hi)

  switch (shape.type) {
    case 'circle':
      return { type: 'circle', r: shape.r * f }
    case 'ngon':
      return { type: 'ngon', r: shape.r * f, sides: shape.sides }
    case 'rect':
      return { type: 'rect', w: shape.w * f, h: shape.h * f }
  }
}

/**
 * Grow or shrink a sketch outline along ONE of its own axes, by how far the
 * pointer pulled that side's skin.
 *
 * The mirror of `resizeAlongAxis` for solids, and it follows the same
 * convention: the outline is centred on its anchor, so pulling one side out by
 * `travel` grows the whole dimension by twice that. A radius is measured from
 * the centre already, so it takes the travel unhalved.
 *
 * Only a rectangle has two dimensions to tell apart. A circle and a polygon
 * carry one radius between them, so both arrows drive it and the gesture is the
 * ring's -- which is honest rather than a limitation to hide: there is no way
 * to write down a wider-than-tall circle in a `Shape2D`, and pretending
 * otherwise would mean the arrow moved something the panel could not show.
 */
export function resizeShapeAlong(
  shape: Shape2D,
  axis: 0 | 1,
  travel: number,
  max: number
): Shape2D {
  switch (shape.type) {
    case 'circle':
      return { type: 'circle', r: clamp(shape.r + travel, MIN_SHAPE, max) }
    case 'ngon':
      return { ...shape, r: clamp(shape.r + travel, MIN_SHAPE, max) }
    case 'rect': {
      const grown = clamp(
        (axis === 0 ? shape.w : shape.h) + travel * 2,
        MIN_SHAPE,
        max * 2
      )
      return axis === 0 ? { ...shape, w: grown } : { ...shape, h: grown }
    }
  }
}

/**
 * Which field one axis drives, and how far the surface moves when it changes.
 *
 * `perUnit` is the distance the solid's surface travels along the axis per unit
 * of the field. A radius IS the half-extent, so it moves the surface one for
 * one; a box side and a height are FULL extents about a centred origin, so the
 * surface only moves half as far as the number does. Inverting that ratio is
 * what lets a drag put the surface exactly where the pointer asks for it.
 */
export type AxisDimension = {
  field: 'size' | 'radius' | 'height'
  /** Which component, for a box. Undefined for the scalar fields. */
  index?: Axis
  value: number
  min: number
  max: number
  perUnit: 0.5 | 1
}

/**
 * The dimension one axis of the gizmo controls, or null where the axis has
 * nothing to say.
 *
 * Never actually null today -- every primitive answers on all three axes, a
 * sphere simply answering "radius" three times over. The null is kept in the
 * type because the honest answer for a shape with a fixed axis would be
 * nothing, and a caller that ignores that possibility would silently resize the
 * wrong field the day one is added.
 */
export function axisDimension(base: BaseSolid, axis: Axis): AxisDimension | null {
  switch (base.kind) {
    case 'box':
    // Three independent extents about a centred origin, which is what a box is
    // and what an imported model is. Same field, same arithmetic, same arrows.
    case 'mesh':
      return {
        field: 'size',
        index: axis,
        value: base.size[axis],
        min: MIN_DIMENSION,
        max: MAX_SIZE,
        perUnit: 0.5,
      }

    case 'sphere':
    case 'platonic':
      // One dimension, so all three arrows drive it. Better than leaving two of
      // them inert: on a sphere every direction IS the radius.
      return {
        field: 'radius',
        value: base.radius,
        min: MIN_DIMENSION,
        max: MAX_RADIUS,
        perUnit: 1,
      }

    case 'cylinder':
    case 'cone':
    case 'capsule':
    case 'pyramid':
    case 'prism':
      // +Y is the axis every one of these stands on, so it is the only one that
      // can mean height; the other two are girth.
      return axis === 1
        ? {
            field: 'height',
            value: base.height,
            min: MIN_DIMENSION,
            max: MAX_SIZE,
            perUnit: 0.5,
          }
        : {
            field: 'radius',
            value: base.radius,
            min: MIN_DIMENSION,
            max: MAX_RADIUS,
            perUnit: 1,
          }
  }
}

/** Write one dimension back, leaving the rest of the solid alone. */
function withDimension(base: BaseSolid, dim: AxisDimension, value: number): BaseSolid {
  const next = clamp(value, dim.min, dim.max)
  if (dim.field === 'size') {
    if (base.kind !== 'box' && base.kind !== 'mesh') return base
    const size: Vec3 = [base.size[0], base.size[1], base.size[2]]
    size[dim.index ?? 0] = next
    // Spread rather than rebuilt, so a mesh keeps its ticket and its label.
    return { ...base, size }
  }
  if (dim.field === 'radius') {
    if (base.kind === 'box' || base.kind === 'mesh') return base
    return { ...base, radius: next }
  }
  if (
    base.kind === 'box' ||
    base.kind === 'mesh' ||
    base.kind === 'sphere' ||
    base.kind === 'platonic'
  ) {
    return base
  }
  return { ...base, height: next }
}

/**
 * Resize along one axis by moving that axis's SURFACE `travel` units outward.
 *
 * Phrased as surface travel rather than as a change to the field because that
 * is what a drag actually asks for: the pointer is out at the solid's skin, and
 * a gesture that moved the skin half as far on a box as on a cylinder -- which
 * is what changing the field by the same amount would do -- reads as the gizmo
 * slipping.
 */
export function resizeAlongAxis(base: BaseSolid, axis: Axis, travel: number): BaseSolid {
  const dim = axisDimension(base, axis)
  if (!dim) return base
  return withDimension(base, dim, dim.value + travel / dim.perUnit)
}

/** Every dimension a solid has, for the uniform-scale ring. */
function dimensionsOf(base: BaseSolid): { value: number; min: number; max: number }[] {
  switch (base.kind) {
    case 'box':
    case 'mesh':
      return base.size.map((value) => ({ value, min: MIN_DIMENSION, max: MAX_SIZE }))
    case 'sphere':
    case 'platonic':
      return [{ value: base.radius, min: MIN_DIMENSION, max: MAX_RADIUS }]
    default:
      return [
        { value: base.radius, min: MIN_DIMENSION, max: MAX_RADIUS },
        { value: base.height, min: MIN_DIMENSION, max: MAX_SIZE },
      ]
  }
}

/**
 * A base's numbers in a fixed order, so two can be compared for "no change".
 *
 * Here rather than in the store because a merged object is compared the same
 * way -- every solid in it, in tree order -- and neither caller should be
 * writing down which fields a kind has for a second time.
 */
export function baseParams(base: BaseSolid): number[] {
  return dimensionsOf(base).map((d) => d.value)
}

/**
 * The range of uniform factors this solid can take without any one of its
 * dimensions leaving its limits.
 *
 * Separated from `scaleUniform` because a merged object has to INTERSECT this
 * across every solid in it before scaling any of them: clamping each part on
 * its own is what would let one part hit the ceiling while the rest kept
 * growing, quietly changing the proportions of the assembly.
 */
export function scaleLimits(base: BaseSolid): { lo: number; hi: number } {
  let lo = 0
  let hi = Infinity
  for (const d of dimensionsOf(base)) {
    lo = Math.max(lo, d.min / d.value)
    hi = Math.min(hi, d.max / d.value)
  }
  return { lo, hi }
}

/**
 * Scale every dimension by one factor.
 *
 * The factor is clamped ONCE, against the tightest bound any single dimension
 * imposes, rather than each dimension being clamped on its own. Clamping them
 * separately is what would let a long thin box hit the length ceiling and keep
 * fattening -- the ring would quietly change the shape's proportions, which is
 * the one thing a uniform scale must not do.
 */
export function scaleUniform(base: BaseSolid, factor: number): BaseSolid {
  const { lo, hi } = scaleLimits(base)
  const f = clamp(factor, lo, hi)

  switch (base.kind) {
    case 'box':
    case 'mesh':
      return { ...base, size: [base.size[0] * f, base.size[1] * f, base.size[2] * f] }
    case 'sphere':
    case 'platonic':
      return { ...base, radius: base.radius * f }
    default:
      return { ...base, radius: base.radius * f, height: base.height * f }
  }
}
