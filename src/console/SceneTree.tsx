import type { MouseEvent } from 'react'
import type { Feature, SceneObject } from '../geometry/types'
import { solidLabel } from '../geometry/types'
import { selectedObjectId as primarySelection, useDoc } from '../store/docStore'
import { useEvalStatus } from '../store/evalStore'
import { useTools } from '../store/toolStore'
import type { UnitMode } from '../units'
import { formatLength, formatSize } from '../units'
import { Section } from './Field'
import { MergeIcon } from './navIcons'

/**
 * How big the sketch is, IN THE UNIT THE APP IS SET TO.
 *
 * These rows used to print the scene number itself -- `Circle r0.15` -- which
 * is the one measurement in the app that was in no unit at all. Fifteen
 * hundredths of what? The rule at the top of `units.ts` is that scene units
 * never leave the geometry, and a row of the tree is as much a readout as a
 * ruler's label is, so it converts like one.
 *
 * A rectangle's two sides go through `formatSize`, which says the unit once at
 * the end rather than after each side: `Rect 15.0 x 30.0 mm`. The row is
 * ellipsised by `.feature-text` when the panel is narrow, and a suffix repeated
 * mid-string is the first thing to cost it room.
 */
function shapeLabel(f: Feature, unit: UnitMode): string {
  return f.shape.type === 'circle'
    ? `Circle r${formatLength(f.shape.r, unit)}`
    : f.shape.type === 'rect'
      ? `Rect ${formatSize([f.shape.w, f.shape.h], unit)}`
      : `${f.shape.sides}-gon r${formatLength(f.shape.r, unit)}`
}

/**
 * What the feature does, and which way.
 *
 * The sign carries the direction now, so the row NAMES the direction and shows
 * the reach unsigned: "extrude -0.30" would state the same fact twice, in two
 * ways that read as a contradiction. The tint is the other half of that -- it
 * is what the Extrude / Intrude buttons used to say in green and red before the
 * two collapsed into one slider, and losing it would leave a column of rows
 * that differ by one word.
 */
function action(f: Feature, unit: UnitMode): { text: string; tone: string } {
  if (f.depth === 0) return { text: 'projection', tone: '' }
  const out = f.depth > 0
  return {
    // A LENGTH, and shown as one -- the reach is the same kind of number the
    // Inspector's Extrude field holds and it now reads the same way. See
    // `shapeLabel`.
    text: `${out ? 'extrude' : 'intrude'} ${formatLength(Math.abs(f.depth), unit)}`,
    tone: out ? ' feature-out' : ' feature-in',
  }
}

/**
 * The features an object still has HANDLES for.
 *
 * A confirmed sketch is signed off: it goes on building the solid and stops
 * being a row you can select, suppress or delete. So it leaves this list, and
 * with it the nested tree and the count beside the object's name.
 *
 * The tree is the document rather than a log of what was done to it, and this
 * is the one place that claim needs qualifying: a confirmed feature is still in
 * the document, it has simply stopped being separable from the shape. Undo is
 * what takes it back to being a sketch. See `Feature.confirmed`.
 */
function live(o: SceneObject): Feature[] {
  return o.features.filter((f) => !f.confirmed)
}

/** A renamed object answers to its own name; an unnamed one to its solid. */
function objectLabel(o: SceneObject): string {
  return o.name.trim() || solidLabel(o.base)
}

/**
 * The scene, in PRIORITY order: objects outside, their features nested within.
 * Like the feature list it replaces, this is the document itself and not a log
 * of past actions -- toggling, reordering or deleting any row re-derives the
 * geometry or the way it is drawn.
 *
 * The order is not decoration. Where two solids present the very same surface
 * -- two overlapping objects severed by one cut plane, whose caps are then
 * coplanar and overlapping -- the depth buffer has no tiebreak, and the shared
 * face tears into a stipple of both colours. Row 1 wins that; see `depthBias`
 * in the viewport, and `moveObject` in the store. Which is why every row
 * carries a pair of arrows.
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
 *
 * Nothing changes colour either. The result is one object, but it is drawn a
 * solid at a time in the colours that went in, so a merge is not a decision
 * about which of them to keep.
 */
export function MergeButton() {
  const selectedIds = useDoc((s) => s.selectedObjectIds)
  const objects = useDoc((s) => s.doc.objects)
  const mergeObjects = useDoc((s) => s.mergeObjects)

  // Erasers are skipped by the merge itself, so counting them here would offer
  // to weld three things and weld two.
  const selected = selectedIds.filter((id) =>
    objects.some((o) => o.id === id && !o.erase)
  )

  if (selected.length < 2) return null

  return (
    <button
      type="button"
      className="btn btn-primary merge-btn"
      title="Weld the selected objects into the first one picked. They keep their own bases, features, cuts and colours as parts inside it."
      onClick={() => mergeObjects(selected)}
    >
      <span className="merge-btn-icon" aria-hidden>
        <MergeIcon />
      </span>
      Merge {selected.length} objects
    </button>
  )
}

/**
 * Move an object up or down the priority order.
 *
 * Two arrows rather than a drag handle: the list is short, the moves are single
 * steps, and a button says what it does to a keyboard and a screen reader as
 * well as to a pointer. Both are DISABLED at the ends rather than hidden, so
 * the row does not change width as it travels -- a control that moves out from
 * under the pointer is a control that takes two clicks to use twice.
 */
function OrderButtons({ id, rank, count }: { id: string; rank: number; count: number }) {
  const moveObject = useDoc((s) => s.moveObject)
  const step = (e: MouseEvent, delta: number) => {
    // The row itself selects on click, and reordering is not selecting.
    e.stopPropagation()
    moveObject(id, delta)
  }

  return (
    <span className="tree-order">
      <button
        type="button"
        className="icon-btn"
        disabled={rank === 0}
        title={
          rank === 0
            ? 'Already at the top -- this object already wins any surface it shares'
            : 'Move up. Higher in the list wins where two solids share a surface.'
        }
        aria-label="Move up"
        onClick={(e) => step(e, -1)}
      >
        {'▲'}
      </button>
      <button
        type="button"
        className="icon-btn"
        disabled={rank === count - 1}
        title={
          rank === count - 1
            ? 'Already at the bottom -- it gives way on any surface it shares'
            : 'Move down. Lower in the list gives way where two solids share a surface.'
        }
        aria-label="Move down"
        onClick={(e) => step(e, 1)}
      >
        {'▼'}
      </button>
    </span>
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
  // The tree is a readout like any other, so its sizes follow the app-wide
  // unit -- see `shapeLabel`.
  const displayUnit = useTools((s) => s.displayUnit)

  if (objects.length === 0) {
    return (
      <Section title="Scene">
        <p className="tree-empty">Empty scene -- drag a solid in from Solids.</p>
      </Section>
    )
  }

  return (
    <Section
      title="Scene"
      hint={`${objects.length}`}
      tip="The list is a priority order, top to bottom. Where two objects present the same surface -- two overlapping solids cut by one plane, say -- the higher one is drawn and the lower gives way. The arrows on a row move it."
    >
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
                <span className="feature-index" title={`Priority ${i + 1} of ${objects.length}`}>
                  {i + 1}
                </span>
                <span className="tree-object-name">{objectLabel(o)}</span>
                {/* Counts what the list below it will SHOW. A badge reading
                    "3f" over an empty list is a worse answer than no badge:
                    confirmed features are baked into the solid and have no row,
                    so they are no longer things this object has -- they are
                    part of its shape. */}
                {live(o).length > 0 && (
                  <span
                    className="section-hint tree-count"
                    title={`${live(o).length} feature${live(o).length === 1 ? '' : 's'}`}
                  >
                    {live(o).length}f
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
                {/* A red ghost in the scene has an ordinary-looking row, and
                    the one thing worth knowing about it is that it takes
                    material away rather than adding it. */}
                {o.erase && (
                  <span
                    className="tree-erase"
                    title="An eraser. Aim it, then confirm the subtraction under Position & Rotation."
                  >
                    erase
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
                <OrderButtons id={o.id} rank={i} count={objects.length} />
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
              {live(o).length > 0 && (
                <ul className="tree-features">
                  {live(o).map((f, j) => (
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
                        {shapeLabel(f, displayUnit)} -{' '}
                        <span className={`feature-action${action(f, displayUnit).tone}`}>
                          {action(f, displayUnit).text}
                        </span>
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
