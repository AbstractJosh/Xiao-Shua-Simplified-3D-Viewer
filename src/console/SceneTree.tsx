import type { Feature, SceneObject } from '../geometry/types'
import { solidLabel } from '../geometry/types'
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

/** A renamed object answers to its own name; an unnamed one to its solid. */
function objectLabel(o: SceneObject): string {
  return o.name.trim() || solidLabel(o.base)
}

/**
 * The scene, in evaluation order: objects outside, their features nested
 * within. Like the feature list it replaces, this is the document itself and
 * not a log of past actions -- toggling or deleting any row re-derives the
 * geometry.
 */
export function SceneTree() {
  const objects = useDoc((s) => s.doc.objects)
  const selectedObjectId = useDoc((s) => s.selectedObjectId)
  const selectedFeatureId = useDoc((s) => s.selectedFeatureId)
  const selectObject = useDoc((s) => s.selectObject)
  const selectFeature = useDoc((s) => s.selectFeature)
  const removeObject = useDoc((s) => s.removeObject)
  const removeFeature = useDoc((s) => s.removeFeature)
  const toggleFeature = useDoc((s) => s.toggleFeature)
  // Mixed bag of feature, cut and object ids. Every lookup below matches one
  // exact id it can name, so an unrecognised entry simply lights nothing up
  // rather than mislabelling the row it happens to sit beside.
  const failed = useEvalStatus((s) => s.failed)

  if (objects.length === 0) {
    return (
      <Section title="Scene">
        <p className="tree-empty">Empty scene -- drag a solid in from Solids.</p>
      </Section>
    )
  }

  return (
    <Section title="Scene" hint={`${objects.length}`}>
      <ul className="tree">
        {objects.map((o, i) => {
          const cutFailed = o.cuts.some((c) => failed.includes(c.id))
          return (
            <li key={o.id} className="tree-object">
              <div
                className={`tree-object-head${
                  o.id === selectedObjectId ? ' tree-selected' : ''
                }`}
                onClick={() => selectObject(o.id)}
              >
                <span className="feature-index">{i + 1}</span>
                <span className="tree-object-name">{objectLabel(o)}</span>
                {o.features.length > 0 && (
                  <span
                    className="section-hint tree-count"
                    title={`${o.features.length} feature${o.features.length === 1 ? '' : 's'}`}
                  >
                    {o.features.length}f
                  </span>
                )}
                {/* Two halves of a cut solid look like two unrelated objects
                    until this chip explains where the second one came from. */}
                {o.cuts.length > 0 &&
                  (cutFailed ? (
                    <span className="feature-error" title="A cut on this object could not be applied">
                      cut
                    </span>
                  ) : (
                    <span
                      className="section-hint tree-cut"
                      title={`Kept half of ${o.cuts.length} cut plane${
                        o.cuts.length === 1 ? '' : 's'
                      }`}
                    >
                      {o.cuts.length === 1 ? 'cut' : `cut x${o.cuts.length}`}
                    </span>
                  ))}
                {failed.includes(o.id) && (
                  <span className="feature-error" title="This solid could not be built">
                    failed
                  </span>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  title="Delete object"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeObject(o.id)
                  }}
                >
                  {'×'}
                </button>
              </div>
              {o.features.length > 0 && (
                <ul className="tree-features">
                  {o.features.map((f, j) => (
                    <li
                      key={f.id}
                      // Feature ids come from one global counter, so a match
                      // here cannot belong to a different object's sketch --
                      // and selecting a feature selects its object too, which
                      // is what highlights the head row above.
                      className={`tree-feature${
                        f.id === selectedFeatureId ? ' tree-selected' : ''
                      }${f.enabled ? '' : ' tree-off'}`}
                      onClick={() => selectFeature(o.id, f.id)}
                    >
                      <span className="feature-index">{j + 1}</span>
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
                          toggleFeature(o.id, f.id)
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
                          removeFeature(o.id, f.id)
                        }}
                      >
                        {'×'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}
