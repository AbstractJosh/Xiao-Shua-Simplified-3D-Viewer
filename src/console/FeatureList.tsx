import type { Feature } from '../geometry/types'
import { useDoc } from '../store/docStore'
import { useEvalStatus } from '../store/evalStore'
import { Section } from './Field'

function describe(f: Feature): string {
  const shape =
    f.shape.type === 'circle'
      ? `Circle r${f.shape.r.toFixed(2)}`
      : f.shape.type === 'rect'
        ? `Rect ${f.shape.w.toFixed(2)}x${f.shape.h.toFixed(2)}`
        : `${f.shape.sides}-gon r${f.shape.r.toFixed(2)}`
  const action = f.depth === 0 ? 'projection' : `${f.op} ${f.depth.toFixed(2)}`
  return `${shape} - ${action}`
}

/**
 * The feature tree, in order of evaluation. This is the document itself, not a
 * log of past actions: toggling or deleting any row re-derives the solid.
 */
export function FeatureList() {
  const features = useDoc((s) => s.doc.features)
  const selectedId = useDoc((s) => s.selectedId)
  const select = useDoc((s) => s.select)
  const toggleFeature = useDoc((s) => s.toggleFeature)
  const removeFeature = useDoc((s) => s.removeFeature)
  const failed = useEvalStatus((s) => s.failed)

  return (
    <Section title="Features" hint={features.length ? `${features.length}` : undefined}>
      {features.length === 0 ? (
        <p className="empty">No features yet.</p>
      ) : (
        <ul className="feature-list">
          {features.map((f, i) => (
            <li
              key={f.id}
              className={`feature-row${f.id === selectedId ? ' feature-selected' : ''}${
                f.enabled ? '' : ' feature-off'
              }`}
              onClick={() => select(f.id)}
            >
              <span className="feature-index">{i + 1}</span>
              <span className="feature-text">
                {describe(f)}
                {failed.includes(f.id) && (
                  <span className="feature-error" title="This feature could not be applied">
                    failed
                  </span>
                )}
              </span>
              <button
                type="button"
                className="icon-btn"
                title={f.enabled ? 'Suppress' : 'Enable'}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleFeature(f.id)
                }}
              >
                {f.enabled ? '●' : '○'}
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation()
                  removeFeature(f.id)
                }}
              >
                {'×'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
