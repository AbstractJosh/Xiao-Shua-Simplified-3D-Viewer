import { CUT_POSITION_LIMIT, useTools } from '../store/toolStore'
import type { Vec3 } from '../geometry/types'
import { selectedObject, useDoc } from '../store/docStore'
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
 * It also puts the cut plane's numbers in the console rather than in a popover
 * hanging over the viewport, which is the one place a plane cannot be aimed:
 * the whole question of where to put a blade is answered by looking at what it
 * is about to sever.
 */

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

/** Position is this panel's own bound; nothing on the gizmo side reads it. */
const OBJECT_POSITION_LIMIT = 8

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
      tip="Drives whatever is being aimed: the selected object, or the cut plane while the cut tool is armed. The gizmo in the viewport moves the same numbers -- these are for when the answer has to be exact."
    >
      <Vec3Field
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
        step={1}
        decimals={0}
        degrees
        onChange={target.setRotation}
      />
    </Section>
  )
}
