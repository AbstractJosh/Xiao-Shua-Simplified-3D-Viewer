import type { Feature, SceneObject } from '../geometry/types'
import { solidLabel } from '../geometry/types'
import { selectedObjectId as primarySelection, useDoc } from '../store/docStore'
import { useEvalStatus } from '../store/evalStore'
import { Section } from './Field'
import { MergeIcon } from './navIcons'

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
/**
 * Weld the selected objects into one.
 *
 * It lives in the Scene section because that is where the selection is legible:
 * the rows it is about to fold together are the rows directly beneath it, and a
 * button in the toolbar was a long way from the list that says what it will
 * take. It appears only when it would do something -- two or more objects
 * picked out -- and names the count, because a merge is one undo step and the
 * user should know how big a step it is before taking it.
 *
 * The FIRST object picked is the one the rest merge into. It keeps its id, its
 * transform, its features and its cuts; the others become parts inside it, with
 * their placements rewritten into its local space so nothing moves.
 */
export function MergeButton() {
  const selected = useDoc((s) => s.selectedObjectIds)
  const mergeObjects = useDoc((s) => s.mergeObjects)

  if (selected.length < 2) return null

  return (
    <button
      type="button"
      className="btn btn-primary merge-btn"
      title="Weld the selected objects into the first one picked. They keep their own bases, features and cuts as parts inside it."
      onClick={() => mergeObjects(selected)}
    >
      <span className="merge-btn-icon" aria-hidden>
        <MergeIcon />
      </span>
      Merge {selected.length} objects
    </button>
  )
}

export function SceneTree() {
  const objects = useDoc((s) => s.doc.objects)
  const selectedObjectId = useDoc(primarySelection)
  const selectedObjectIds = useDoc((s) => s.selectedObjectIds)
  const toggleObjectSelection = useDoc((s) => s.toggleObjectSelection)
  const chosen = new Set(selectedObjectIds)
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
      <MergeButton />
      <ul className="tree">
        {objects.map((o, i) => {
          const cutFailed = o.cuts.some((c) => failed.includes(c.id))
          return (
            <li key={o.id} className="tree-object">
              <div
                className={`tree-object-head${
                  chosen.has(o.id) ? ' tree-selected' : ''
                }${o.id === selectedObjectId ? ' tree-primary' : ''}`}
                onClick={(e) =>
                  e.shiftKey ? toggleObjectSelection(o.id) : selectObject(o.id)
                }
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
                {/* A merged object is ONE row, because it is one object. The
                    chip is the only thing saying that more than one solid went
                    into it -- without it a scene that merged two cubes looks
                    like a scene that lost one. */}
                {o.parts.length > 0 && (
                  <span
                    className="section-hint tree-merged"
                    title={`${o.parts.length + 1} solids merged into one object`}
                  >
                    {o.parts.length + 1} merged
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
