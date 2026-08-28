import { assemblyExtent, assemblyScaleLimits } from '../geometry/assembly'
import { MAX_RADIUS, MAX_SIZE, MIN_DIMENSION, baseParams } from '../geometry/dimensions'
import type { BaseSolid, SceneObject } from '../geometry/types'
import { solidLabel } from '../geometry/types'
import { selectedObject, useDoc } from '../store/docStore'
import { NumberField, Section } from './Field'

/** The gizmo's arrows resize the same fields these do, so both read one set of
 *  bounds -- a limit only one of them honoured would let a drag build a solid
 *  the panel then refused to show. */
const SIZE_MAX = MAX_SIZE
const RADIUS_MAX = MAX_RADIUS

/** The side counts the solid palette offers, so both places agree. */
const SIDE_CHOICES = [3, 4, 5, 6, 8]

/**
 * A solid built elsewhere can carry a count the palette never offers, and a row
 * that cannot show the current value would read as though nothing is selected.
 */
function sideChoices(current: number): number[] {
  if (SIDE_CHOICES.includes(current)) return SIDE_CHOICES
  return [...SIDE_CHOICES, current].sort((a, b) => a - b)
}

/**
 * The one dimension a merged object has.
 *
 * Its parts sit at their own angles and a `BaseSolid` carries no scale, so
 * there is no way to write down "this assembly, but wider" -- a per-axis field
 * could only ever have resized ONE of the welded solids, which is what made a
 * merged object stop behaving as one the moment it was sized. A single uniform
 * size is the whole of what is representable, and it is also the honest control:
 * the assembly keeps the shape the merge gave it.
 *
 * Shown as the longest side of the object's bounding box rather than as a bare
 * factor, so the row reads as a measurement like every other row in this panel
 * and a slider has somewhere absolute to sit. The two are interchangeable: a
 * uniform scale multiplies that extent by exactly the factor applied.
 */
function MergedSize({ object }: { object: SceneObject }) {
  const scaleObject = useDoc((s) => s.scaleObject)
  const extent = assemblyExtent(object)
  const { lo, hi } = assemblyScaleLimits(object)

  // An assembly with no extent has no factor to scale by either, and the field
  // would divide by zero to find one. Not reachable from a real merge, since
  // every primitive has size, but the row must not be the thing that throws.
  if (!(extent > 0) || !(hi > lo)) return null

  return (
    <NumberField
      unit
      label="Size"
      value={extent}
      // The range the object can actually take: the factor limits of the
      // tightest solid in it, read back as a size. Outside it some part would
      // clamp while the rest kept going, which is the one thing a uniform scale
      // must not do.
      min={extent * lo}
      max={extent * hi}
      tip="A merged object sizes as one. Every solid in it scales together and the gaps between them scale too, so the assembly keeps the shape the merge gave it."
      onChange={(next) => scaleObject(object.id, next / extent)}
    />
  )
}

export function ObjectPanel() {
  const object = useDoc(selectedObject)
  const patchObject = useDoc((s) => s.patchObject)
  const removeObject = useDoc((s) => s.removeObject)

  if (!object) {
    return (
      <Section title="Dimensions">
        <p className="empty">
          Nothing selected. Click an object to edit it, or drag one in from the
          Solids palette.
        </p>
      </Section>
    )
  }

  const { base } = object
  const setBase = (next: BaseSolid) => patchObject(object.id, { base: next })

  /**
   * Side count and platonic kind both change SurfaceDef.kind, and patchObject
   * deliberately drops the feature list when that string changes -- face 3 of a
   * hexagonal prism is not face 3 of an octagonal one. Warn before spending the
   * sketches, the way the old base switcher did, and only when there are any.
   */
  const setTopology = (what: string, next: BaseSolid) => {
    if (
      object.features.length > 0 &&
      !window.confirm(`Changing the ${what} clears this object's sketches. Continue?`)
    ) {
      return
    }
    setBase(next)
  }

  const dimensions = () => {
    switch (base.kind) {
      // An imported model takes the box's three fields, because it measures the
      // way a box does: three independent extents about a centred origin. The
      // base is SPREAD rather than rebuilt so a mesh keeps its ticket and its
      // label -- writing `{ kind: 'box', size }` here would silently turn the
      // model into an empty cube.
      case 'box':
      case 'mesh': {
        const [x, y, z] = base.size
        return (
          <>
            <NumberField
              unit
              label="Width"
              value={x}
              min={MIN_DIMENSION}
              max={SIZE_MAX}
              onChange={(w) => setBase({ ...base, size: [w, y, z] })}
            />
            <NumberField
              unit
              label="Height"
              value={y}
              min={MIN_DIMENSION}
              max={SIZE_MAX}
              onChange={(h) => setBase({ ...base, size: [x, h, z] })}
            />
            <NumberField
              unit
              label="Depth"
              value={z}
              min={MIN_DIMENSION}
              max={SIZE_MAX}
              onChange={(d) => setBase({ ...base, size: [x, y, d] })}
            />
          </>
        )
      }

      case 'sphere':
        return (
          <NumberField
            unit
            label="Radius"
            value={base.radius}
            min={MIN_DIMENSION}
            max={RADIUS_MAX}
            onChange={(radius) => setBase({ kind: 'sphere', radius })}
          />
        )

      // No kind switcher here, unlike the side counts below. A tetrahedron is
      // not a coarser dodecahedron the way a hexagonal prism is a coarser
      // octagonal one -- swapping one for another is placing a different solid,
      // which the palette already does, and doing it from the Dimensions panel
      // only bought a way to silently spend the object's sketches.
      case 'platonic':
        return (
          <NumberField
            unit
            label="Radius"
            value={base.radius}
            min={MIN_DIMENSION}
            max={RADIUS_MAX}
            onChange={(radius) => setBase({ ...base, radius })}
          />
        )

      case 'cylinder':
      case 'cone':
      case 'capsule':
        return (
          <>
            <NumberField
              unit
              label="Radius"
              value={base.radius}
              min={MIN_DIMENSION}
              max={RADIUS_MAX}
              onChange={(radius) => setBase({ ...base, radius })}
            />
            <NumberField
              unit
              label="Height"
              value={base.height}
              min={MIN_DIMENSION}
              max={SIZE_MAX}
              tip={
                base.kind === 'capsule'
                  ? 'Height is the straight mid-section only. The domed caps add a radius at each end.'
                  : undefined
              }
              onChange={(height) => setBase({ ...base, height })}
            />
          </>
        )

      case 'pyramid':
      case 'prism':
        return (
          <>
            <NumberField
              unit
              label="Radius"
              value={base.radius}
              min={MIN_DIMENSION}
              max={RADIUS_MAX}
              onChange={(radius) => setBase({ ...base, radius })}
            />
            <NumberField
              unit
              label="Height"
              value={base.height}
              min={MIN_DIMENSION}
              max={SIZE_MAX}
              onChange={(height) => setBase({ ...base, height })}
            />
            <p className="subhead">Sides</p>
            {/* Discrete buttons, not a slider: every step of a slider is a
                topology change, so dragging one would fire a confirm per pixel. */}
            <div className="seg">
              {sideChoices(base.sides).map((sides) => (
                <button
                  key={sides}
                  type="button"
                  className={`seg-btn${base.sides === sides ? ' seg-active' : ''}`}
                  onClick={() => {
                    if (sides === base.sides) return
                    setTopology('side count', { ...base, sides })
                  }}
                >
                  {sides}
                </button>
              ))}
            </div>
          </>
        )
    }
  }

  const merged = object.parts.length > 0

  return (
    <Section
      title="Dimensions"
      hint={merged ? `${object.parts.length + 1} merged` : solidLabel(base)}
      // Exactly the numbers the rows below show: a merged object has the one
      // size row, everything else the base's own dimensions in the order
      // `dimensionsOf` lists them.
      lengths={merged ? [assemblyExtent(object)] : baseParams(base)}
    >
      {/* Position and rotation are NOT here. They are a placement, which the
          cut plane has too, so both read the one Position & Rotation panel
          above rather than each keeping a copy of two XYZ fields. What is left
          is what only a solid has: how big it is, and how many sides.

          A merged object gets one row instead of that set. Its own primitive's
          width is not a dimension of the object any more -- the object is every
          solid welded into it -- and offering the host's fields here is what
          made sizing a merge move one of its parts and leave the rest. */}
      {merged ? <MergedSize object={object} /> : dimensions()}

      <button
        type="button"
        className="danger"
        onClick={() => removeObject(object.id)}
      >
        Delete object
      </button>
    </Section>
  )
}
