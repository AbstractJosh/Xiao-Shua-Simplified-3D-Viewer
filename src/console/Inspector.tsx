import { hostSurfaceFor } from '../geometry/surfaces'
import type { BaseSolid, Feature, SurfaceAnchor } from '../geometry/types'
import { useDoc } from '../store/docStore'
import { NumberField, Section } from './Field'

const FACE_NAMES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z']

function anchorLabel(anchor: SurfaceAnchor): string {
  switch (anchor.on) {
    case 'box-face':
      return `Face ${FACE_NAMES[anchor.face]}`
    case 'sphere':
      return 'Sphere surface (curved)'
    case 'derived':
      return 'Feature surface'
  }
}

/** Sensible upper bound for a sketch, so sliders stay usable. */
function maxShapeSize(base: BaseSolid): number {
  return base.kind === 'box' ? Math.min(...base.size) / 2 : base.radius * 0.9
}

export function Inspector() {
  const doc = useDoc((s) => s.doc)
  const selectedId = useDoc((s) => s.selectedId)
  const patchFeature = useDoc((s) => s.patchFeature)
  const setOp = useDoc((s) => s.setOp)
  const removeFeature = useDoc((s) => s.removeFeature)

  const feature = doc.features.find((f) => f.id === selectedId) ?? null

  if (!feature) {
    return (
      <Section title="Sketch">
        <p className="empty">
          Drag a shape onto the object, then adjust it here.
        </p>
      </Section>
    )
  }

  const host = hostSurfaceFor(doc.base, feature.anchor)
  const depthLimit = host.maxDepth(feature.op)
  const sizeLimit = maxShapeSize(doc.base)
  const patch = (p: Partial<Feature>) => patchFeature(feature.id, p)

  return (
    <Section title="Sketch" hint={anchorLabel(feature.anchor)}>
      {feature.shape.type === 'circle' && (
        <NumberField
          label="Radius"
          value={feature.shape.r}
          min={0.02}
          max={sizeLimit}
          onChange={(r) => patch({ shape: { type: 'circle', r } })}
        />
      )}

      {feature.shape.type === 'rect' && (
        <>
          <NumberField
            label="Width"
            value={feature.shape.w}
            min={0.02}
            max={sizeLimit * 2}
            onChange={(w) =>
              patch({ shape: { ...feature.shape, type: 'rect', w } as Feature['shape'] })
            }
          />
          <NumberField
            label="Height"
            value={feature.shape.h}
            min={0.02}
            max={sizeLimit * 2}
            onChange={(h) =>
              patch({ shape: { ...feature.shape, type: 'rect', h } as Feature['shape'] })
            }
          />
        </>
      )}

      {feature.shape.type === 'ngon' && (
        <>
          <NumberField
            label="Radius"
            value={feature.shape.r}
            min={0.02}
            max={sizeLimit}
            onChange={(r) =>
              patch({ shape: { ...feature.shape, type: 'ngon', r } as Feature['shape'] })
            }
          />
          <NumberField
            label="Sides"
            value={feature.shape.sides}
            min={3}
            max={12}
            step={1}
            decimals={0}
            onChange={(sides) =>
              patch({
                shape: { ...feature.shape, type: 'ngon', sides: Math.round(sides) } as Feature['shape'],
              })
            }
          />
        </>
      )}

      <NumberField
        label="Rotation"
        value={(feature.rotation * 180) / Math.PI}
        min={0}
        max={360}
        step={1}
        decimals={0}
        onChange={(deg) => patch({ rotation: (deg * Math.PI) / 180 })}
      />

      <div className="op-row">
        <button
          type="button"
          className={`op-btn${feature.op === 'extrude' ? ' op-active op-out' : ''}`}
          onClick={() => setOp(feature.id, 'extrude')}
        >
          Extrude
        </button>
        <button
          type="button"
          className={`op-btn${feature.op === 'intrude' ? ' op-active op-in' : ''}`}
          onClick={() => setOp(feature.id, 'intrude')}
        >
          Intrude
        </button>
      </div>

      <NumberField
        label="Depth"
        value={Math.min(feature.depth, depthLimit)}
        min={0}
        max={depthLimit}
        onChange={(depth) => patch({ depth })}
      />
      {feature.depth === 0 && (
        <p className="hint">
          Projection only. Pick Extrude or Intrude, or raise the depth.
        </p>
      )}

      <button
        type="button"
        className="danger"
        onClick={() => removeFeature(feature.id)}
      >
        Delete sketch
      </button>
    </Section>
  )
}
