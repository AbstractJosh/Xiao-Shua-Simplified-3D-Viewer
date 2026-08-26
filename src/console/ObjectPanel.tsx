import type { BaseSolid, PlatonicKind } from '../geometry/types'
import { solidLabel } from '../geometry/types'
import { selectedObject, useDoc } from '../store/docStore'
import { NumberField, Section, Vec3Field } from './Field'

/** Slider bounds. Generous enough to compose a scene, tight enough to aim with. */
const POS_LIMIT = 8
const SIZE_MAX = 8
const RADIUS_MAX = 4

/** The side counts the solid palette offers, so both places agree. */
const SIDE_CHOICES = [3, 4, 5, 6, 8]

const PLATONIC_CHOICES: { solid: PlatonicKind; label: string; title: string }[] = [
  { solid: 'tetrahedron', label: 'Tetra', title: 'Tetrahedron' },
  { solid: 'octahedron', label: 'Octa', title: 'Octahedron' },
  { solid: 'dodecahedron', label: 'Dodeca', title: 'Dodecahedron' },
]

/**
 * A solid built elsewhere can carry a count the palette never offers, and a row
 * that cannot show the current value would read as though nothing is selected.
 */
function sideChoices(current: number): number[] {
  if (SIDE_CHOICES.includes(current)) return SIDE_CHOICES
  return [...SIDE_CHOICES, current].sort((a, b) => a - b)
}

export function ObjectPanel() {
  const object = useDoc(selectedObject)
  const setObjectTransform = useDoc((s) => s.setObjectTransform)
  const patchObject = useDoc((s) => s.patchObject)
  const removeObject = useDoc((s) => s.removeObject)

  if (!object) {
    return (
      <Section title="Object">
        <p className="empty">
          Nothing selected. Click an object to edit it, or drag a solid in from
          the palette above.
        </p>
      </Section>
    )
  }

  const { base, transform } = object
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
      case 'box': {
        const [x, y, z] = base.size
        return (
          <>
            <NumberField
              label="Width"
              value={x}
              min={0.1}
              max={SIZE_MAX}
              onChange={(w) => setBase({ kind: 'box', size: [w, y, z] })}
            />
            <NumberField
              label="Height"
              value={y}
              min={0.1}
              max={SIZE_MAX}
              onChange={(h) => setBase({ kind: 'box', size: [x, h, z] })}
            />
            <NumberField
              label="Depth"
              value={z}
              min={0.1}
              max={SIZE_MAX}
              onChange={(d) => setBase({ kind: 'box', size: [x, y, d] })}
            />
          </>
        )
      }

      case 'sphere':
        return (
          <NumberField
            label="Radius"
            value={base.radius}
            min={0.1}
            max={RADIUS_MAX}
            onChange={(radius) => setBase({ kind: 'sphere', radius })}
          />
        )

      case 'platonic':
        return (
          <>
            <NumberField
              label="Radius"
              value={base.radius}
              min={0.1}
              max={RADIUS_MAX}
              onChange={(radius) => setBase({ ...base, radius })}
            />
            <p className="subhead">Solid</p>
            <div className="seg">
              {PLATONIC_CHOICES.map((choice) => (
                <button
                  key={choice.solid}
                  type="button"
                  title={choice.title}
                  className={`seg-btn${base.solid === choice.solid ? ' seg-active' : ''}`}
                  onClick={() => {
                    if (choice.solid === base.solid) return
                    setTopology('solid', { ...base, solid: choice.solid })
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </>
        )

      case 'cylinder':
      case 'cone':
      case 'capsule':
        return (
          <>
            <NumberField
              label="Radius"
              value={base.radius}
              min={0.1}
              max={RADIUS_MAX}
              onChange={(radius) => setBase({ ...base, radius })}
            />
            <NumberField
              label="Height"
              value={base.height}
              min={0.1}
              max={SIZE_MAX}
              onChange={(height) => setBase({ ...base, height })}
            />
            {base.kind === 'capsule' && (
              <p className="hint">
                Height is the straight mid-section only. The domed caps add a
                radius at each end.
              </p>
            )}
          </>
        )

      case 'pyramid':
      case 'prism':
        return (
          <>
            <NumberField
              label="Radius"
              value={base.radius}
              min={0.1}
              max={RADIUS_MAX}
              onChange={(radius) => setBase({ ...base, radius })}
            />
            <NumberField
              label="Height"
              value={base.height}
              min={0.1}
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

  return (
    <Section title="Object" hint={solidLabel(base)}>
      <Vec3Field
        label="Position"
        value={transform.position}
        min={-POS_LIMIT}
        max={POS_LIMIT}
        step={0.05}
        onChange={(position) => setObjectTransform(object.id, { ...transform, position })}
      />
      <Vec3Field
        label="Rotation"
        value={transform.rotation}
        min={-180}
        max={180}
        step={1}
        decimals={0}
        degrees
        onChange={(rotation) => setObjectTransform(object.id, { ...transform, rotation })}
      />

      {/* A weight above .subhead, which Vec3Field already uses for its own label. */}
      <h3 className="section-title">Dimensions</h3>
      {dimensions()}

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
