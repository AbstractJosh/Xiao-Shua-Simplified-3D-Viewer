import { Inspector } from '../console/Inspector'
import { ObjectPanel } from '../console/ObjectPanel'
import { PlacementPanel } from '../console/PlacementPanel'
import { selectedFeature, selectedObject, useDoc } from '../store/docStore'
import { useTools } from '../store/toolStore'

/**
 * The controls for whatever is being aimed, in the bottom-right of the
 * viewport, slid in while there is something to aim.
 *
 * These are the panels that used to be the console's Edit tab. They are here
 * because of what they do rather than what they are: every one of them is a
 * number you watch the SCENE to set. Dragging a position slider means nothing
 * unless you can see the solid move, and the eye had to cross the whole window
 * to check -- while the tab itself was a click away, so the commonest edit in
 * the app began by switching tabs. Beside the object, the loop closes.
 *
 * WHAT IS SHOWN IS WHAT HAS A TARGET, one panel at a time:
 *
 *   - Position & Rotation whenever anything is being aimed, which includes the
 *     cut plane. The plane has a placement like any other and no panel of its
 *     own; arming the cut tool is exactly as much a reason for this to be up as
 *     selecting a solid.
 *   - Dimensions only for a selected object, since a cut plane has no extent
 *     of its own to change.
 *   - The sketch controls only when a SKETCH is selected. Selecting the solid
 *     it sits on is not selecting it, and an empty Sketch panel standing under
 *     every selection was three quarters of the height of this thing saying
 *     nothing.
 *
 * Each panel still renders its own "nothing selected" branch, and none of them
 * is ever asked to here -- the condition is answered outside, so a panel that
 * has nothing to say is not mounted at all rather than mounted and apologetic.
 *
 * The panels themselves are the console's, unchanged. What makes this compact
 * is CSS scoped to `.selection-hud`, which pulls every row onto one line and
 * takes the tips out: the same controls, driving the same store, at a size that
 * can sit over a scene. Forking them into a second set of components would have
 * meant two definitions of every bound in the app, drifting apart on the first
 * change to either.
 */
export function SelectionHud() {
  const object = useDoc(selectedObject)
  const feature = useDoc(selectedFeature)
  const cutActive = useTools((s) => s.cutActive)

  const aiming = !!object || cutActive

  return (
    // `inert` rather than `aria-hidden`: the panel slides out but stays in the
    // document, and a hidden thing full of live number boxes is still in the
    // tab order. `inert` takes the whole subtree out of focus and pointer
    // handling at once, which is the honest version of what the transform is
    // already doing visually.
    <div className={`selection-hud${aiming ? ' selection-hud-in' : ''}`} inert={!aiming}>
      {aiming && <PlacementPanel />}
      {object && <ObjectPanel />}
      {object && feature && <Inspector />}
    </div>
  )
}
