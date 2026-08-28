import { useState } from 'react'
import { CUT_POSITION_LIMIT, useTools } from '../store/toolStore'
import type { EraseScope } from '../store/toolStore'
import { MAX_SIZE } from '../geometry/dimensions'
import type { SceneObject, Vec3 } from '../geometry/types'
import { selectedObject, useDoc } from '../store/docStore'
import { EraseIcon } from './navIcons'
import { Section, Vec3Field } from './Field'

/**
 * Position and rotation for whatever is being aimed.
 *
 * One panel rather than one per target. Both things that carry a placement --
 * a solid, and the cut plane -- are placed the same way, with the same gizmo,
 * against the same scene; giving each its own copy of two XYZ fields would have
 * meant two sets of rows that behave identically and drift apart the first time
 * one of them gained a control.
 *
 * WHERE it is drawn is the viewport's bottom-right corner, in `SelectionHud`,
 * and for the cut plane that is a change of side rather than of kind. What a
 * plane cannot be aimed from is a popover over the MIDDLE of the scene -- the
 * whole question of where to put a blade is answered by watching what it is
 * about to sever -- and a corner is the opposite of that: near enough to reach
 * without a glance across the window, never over the cut.
 */

/**
 * Confirming an eraser, at the top of the panel that aims it.
 *
 * Here rather than in the toolbar because this is the one control that belongs
 * to THIS object: the panel below is already describing where the eraser is
 * and which way it faces, and "now take it" is the last line of that sentence.
 * A toolbar button would be a long way from the numbers that decide what gets
 * cut, which is the same argument that moved Merge into the scene tree.
 *
 * The act is ONE WAY. The eraser is consumed and each object it cut keeps the
 * hole with no handle left on it, so the button says what it is about to do and
 * the receipt says what it did -- and a single undo puts the whole thing back.
 */
function EraseActions({ eraser }: { eraser: SceneObject }) {
  const applyErase = useDoc((s) => s.applyErase)
  const removeObject = useDoc((s) => s.removeObject)
  const selectedObjectIds = useDoc((s) => s.selectedObjectIds)
  const objectCount = useDoc((s) => s.doc.objects.filter((o) => !o.erase).length)
  const scope = useTools((s) => s.eraseScope)
  const setEraseScope = useTools((s) => s.setEraseScope)

  const [receipt, setReceipt] = useState<string | null>(null)

  // Everything picked out ALONGSIDE the eraser. The eraser is the primary
  // selection -- it is what this panel is aiming -- so shift-clicking a solid
  // adds it here without taking the panel off the thing being aimed.
  const picked = selectedObjectIds.filter((id) => id !== eraser.id)
  const ready = scope === 'all' ? objectCount > 0 : picked.length > 0

  const run = () => {
    const { doc } = useDoc.getState()
    const targets =
      scope === 'all' ? doc.objects.filter((o) => !o.erase).map((o) => o.id) : picked
    const cut = applyErase(eraser.id, targets)
    // Nothing cut is worth saying out loud: the eraser is still sitting there
    // and the user is entitled to know it did not simply fail to register.
    setReceipt(
      cut === 0
        ? 'Nothing to erase -- it does not overlap anything it was aimed at.'
        : `Erased from ${cut} object${cut === 1 ? '' : 's'}.`
    )
  }

  const scopes: { value: EraseScope; label: string; title: string }[] = [
    {
      value: 'all',
      label: 'Every object',
      title: `Takes material out of whatever it overlaps (${objectCount} in the scene).`,
    },
    {
      value: 'selected',
      label: 'Selected only',
      title:
        'Takes material out of the objects picked out alongside the eraser. Shift-click them in the scene or the tree.',
    },
  ]

  return (
    <div className="erase-actions">
      <div className="erase-head">
        <span className="erase-mark" aria-hidden>
          <EraseIcon />
        </span>
        <span className="erase-title">Subtract mode</span>
      </div>

      <div className="seg erase-scope" role="group" aria-label="What this eraser cuts">
        {scopes.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`seg-btn${scope === option.value ? ' seg-active' : ''}`}
            aria-pressed={scope === option.value}
            title={option.title}
            onClick={() => setEraseScope(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="erase-buttons">
        <button
          type="button"
          className="btn btn-primary erase-confirm"
          disabled={!ready}
          title={
            ready
              ? 'Takes the material away for good. The eraser is consumed; undo puts it back.'
              : scope === 'all'
                ? 'Nothing in the scene to erase from yet.'
                : 'Shift-click the objects to erase from first.'
          }
          onClick={run}
        >
          {scope === 'all' ? 'Subtract' : `Subtract from ${picked.length}`}
        </button>
        <button
          type="button"
          className="btn erase-discard"
          title="Throw the eraser away without cutting anything."
          onClick={() => removeObject(eraser.id)}
        >
          Discard
        </button>
      </div>

      {receipt !== null && <p className="erase-receipt">{receipt}</p>}
    </div>
  )
}

/** Bounds and wording differ per target; the rows do not. */
type Placement = {
  /** Shown beside the heading, so it is never ambiguous what is being moved. */
  label: string
  position: Vec3
  rotation: Vec3
  /** The rotation's own name. A plane's is its tilt, and calling it that is
   *  what connects this panel to the cut it is about to make. */
  rotationLabel: string
  positionLimit: number
  setPosition: (position: Vec3) => void
  setRotation: (rotation: Vec3) => void
}

/**
 * Position is this panel's own bound; nothing on the gizmo side reads it.
 *
 * Matched to `MAX_SIZE`, so a scene can hold a few of the largest solids the
 * app allows side by side rather than stacking them on the origin. It also
 * sets the furthest any coordinate can get from the origin -- this plus half a
 * diagonal -- which is the number `brep.ts` sizes its weld against.
 */
const OBJECT_POSITION_LIMIT = MAX_SIZE

export function PlacementPanel() {
  const object = useDoc(selectedObject)
  const setObjectTransform = useDoc((s) => s.setObjectTransform)

  // An armed cut plane outranks the selection, the same way it outranks it for
  // the gizmo: it is the thing the user is actively aiming, and the panel that
  // drives the arrows has to be describing the same thing they are moving.
  const cutActive = useTools((s) => s.cutActive)
  const cutPlane = useTools((s) => s.cutPlane)
  const setCutPlane = useTools((s) => s.setCutPlane)

  let target: Placement | null = null

  if (cutActive) {
    target = {
      label: 'cut plane',
      position: cutPlane.position,
      rotation: cutPlane.rotation,
      rotationLabel: 'Tilt',
      positionLimit: CUT_POSITION_LIMIT,
      setPosition: (position) => setCutPlane({ position }),
      setRotation: (rotation) => setCutPlane({ rotation }),
    }
  } else if (object) {
    const { transform } = object
    target = {
      label: 'object',
      position: transform.position,
      rotation: transform.rotation,
      rotationLabel: 'Rotation',
      positionLimit: OBJECT_POSITION_LIMIT,
      setPosition: (position) => setObjectTransform(object.id, { ...transform, position }),
      setRotation: (rotation) => setObjectTransform(object.id, { ...transform, rotation }),
    }
  }

  if (!target) {
    return (
      <Section title="Position & Rotation">
        <p className="empty">
          Nothing selected. Click an object to move it, or arm the cut tool to
          aim its plane.
        </p>
      </Section>
    )
  }

  return (
    <Section
      title="Position & Rotation"
      hint={target.label}
      // The position triple is the whole of what this panel measures -- the
      // rotation below it is degrees, and says so on its own rows.
      lengths={target.position}
      tip="Drives whatever is being aimed: the selected object, or the cut plane while the cut tool is armed. The gizmo in the viewport moves the same numbers -- these are for when the answer has to be exact."
    >
      {/* Above the rows rather than below them: an eraser is aimed and THEN
          taken, so the panel reads in the order the gesture runs. It only
          appears while an eraser is the thing being aimed -- the cut plane
          outranks the selection, so it cannot be showing for both. */}
      {!cutActive && object?.erase && <EraseActions eraser={object} />}
      <Vec3Field
        unit
        label="Position"
        value={target.position}
        min={-target.positionLimit}
        max={target.positionLimit}
        step={0.05}
        onChange={target.setPosition}
      />
      <Vec3Field
        label={target.rotationLabel}
        resetTo={0}
        value={target.rotation}
        min={-180}
        max={180}
        // A TENTH of a degree, not a whole one. The scrub starts at one step a
        // pixel and accelerates from there, so a whole-degree step left it with
        // no fine end at all -- half a degree was simply not reachable by drag,
        // however slowly you moved. A full sweep still crosses in the same 600
        // pixels; it is the first few that got finer.
        step={0.1}
        decimals={1}
        degrees
        onChange={target.setRotation}
      />
    </Section>
  )
}
