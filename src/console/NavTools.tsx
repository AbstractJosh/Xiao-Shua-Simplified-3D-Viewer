import { useEffect, useState } from 'react'
import type { Vec3 } from '../geometry/types'
import { selectedObjectId as primarySelection, useDoc } from '../store/docStore'
import { cutPlaneNormal, useTools } from '../store/toolStore'
import { NumberField } from './Field'
import { NavTool } from './NavTool'
import { CutIcon, HelpIcon, SnapIcon, UnitsIcon } from './navIcons'
import { UNIT_MODES } from '../units'

export function SnapTool() {
  const snap = useTools((s) => s.snap)
  const snapDistance = useTools((s) => s.snapDistance)
  const setSnap = useTools((s) => s.setSnap)
  const setSnapDistance = useTools((s) => s.setSnapDistance)

  return (
    <NavTool
      id="snap"
      label="Snap"
      icon={<SnapIcon />}
      active={snap}
      onToggle={setSnap}
      panelTitle="Snapping"
    >
      {/* The field stays visible with snapping off rather than vanishing: the
          distance is what you came here to read, and a control that disappears
          when the tool is idle reads as a bug. */}
      <fieldset className="tool-group" disabled={!snap}>
        <NumberField
          unit
          label="Distance"
          value={snapDistance}
          min={0.005}
          max={2}
          step={0.005}
          onChange={setSnapDistance}
        />
      </fieldset>
    </NavTool>
  )
}

/**
 * A bare toggle. Everything the cut needs aiming with lives in the console --
 * its placement in Position & Rotation, the rest in the Cut section -- because
 * a panel hanging off this button covered the one thing a plane is aimed
 * against: the solids it is about to sever.
 */
export function CutTool() {
  const cutActive = useTools((s) => s.cutActive)
  const setCutActive = useTools((s) => s.setCutActive)

  return (
    <NavTool
      label="Cut"
      icon={<CutIcon />}
      active={cutActive}
      onToggle={setCutActive}
    />
  )
}

/** `applyCut` takes plain data; the shared solve hands back a three vector. */
function planeNormal(rotation: Vec3): Vec3 {
  const n = cutPlaneNormal(rotation)
  return [n.x, n.y, n.z]
}

/** How long the outcome of a cut stays on screen before clearing itself. */
const RECEIPT_MS = 8000

/**
 * The two things you do to an armed plane, beside the switch that armed it.
 *
 * On the island rather than in the console because they are ACTIONS, not
 * settings: the plane is aimed by dragging its gizmo in the viewport, and the
 * button that fires the cut wants to be a short travel from the hand that just
 * aimed it -- not at the end of a scroll through the panels that describe the
 * document. Over the scene it is shorter still than it was in the bar.
 *
 * They exist only while the tool is armed, so the island is no taller than its
 * two switches for anyone not cutting.
 */
export function CutActions() {
  const cutActive = useTools((s) => s.cutActive)
  const cutPlane = useTools((s) => s.cutPlane)
  const resetCutPlane = useTools((s) => s.resetCutPlane)

  // Only what the wording depends on: the doc itself is read at click time, so
  // building a solid never re-renders the bar.
  const selectedObjectId = useDoc(primarySelection)
  const objectCount = useDoc((s) => s.doc.objects.length)

  const [status, setStatus] = useState<string | null>(null)
  const [missed, setMissed] = useState(false)

  const planeKey = `${cutPlane.position.join()}|${cutPlane.rotation.join()}`
  // The outcome describes one plane in one place. Once the gizmo moves it is a
  // claim about geometry that no longer exists, so it goes rather than lingers.
  useEffect(() => {
    setStatus(null)
  }, [planeKey])

  // And it goes on its own even if nothing moves: it hangs off the island, over
  // the scene the plane was aimed at.
  useEffect(() => {
    if (status === null) return
    const timer = setTimeout(() => setStatus(null), RECEIPT_MS)
    return () => clearTimeout(timer)
  }, [status])

  useEffect(() => {
    if (!cutActive) setStatus(null)
  }, [cutActive])

  if (!cutActive) return null

  const target =
    selectedObjectId === null
      ? `Cuts every object in the scene (${objectCount}).`
      : 'Cuts the selected object. Deselect to cut the whole scene.'

  const cut = () => {
    const { doc, applyCut } = useDoc.getState()
    const selected = primarySelection(useDoc.getState())
    const object = doc.objects.find((o) => o.id === selected)
    const targets = object ? [object.id] : doc.objects.map((o) => o.id)

    const split = applyCut(cutPlane.position, planeNormal(cutPlane.rotation), targets)
    // A plane that only grazes a solid is the common miss, and it looks exactly
    // like a broken button unless the tool says so out loud.
    setMissed(split === 0)
    setStatus(
      split === 0
        ? 'The plane does not pass all the way through'
        : `Split ${split} object${split === 1 ? '' : 's'}`
    )
  }

  return (
    <div className="nav-cut">
      <button
        type="button"
        className="nav-action nav-action-primary"
        disabled={objectCount === 0}
        // What the button is about to destroy is a sentence, and the island is
        // 176px wide, so it rides the button itself. The count in the label
        // carries the part that must not be missed: whether this is about to
        // cut everything.
        title={target}
        onClick={cut}
      >
        {selectedObjectId === null ? `Apply cut · all ${objectCount}` : 'Apply cut'}
      </button>
      <button
        type="button"
        className="nav-action"
        title="Return the plane to the middle of the scene, level"
        onClick={resetCutPlane}
      >
        Reset plane
      </button>

      {status !== null && (
        <div className={`nav-flyout${missed ? ' nav-flyout-bad' : ''}`} role="status">
          {status}
        </div>
      )}
    </div>
  )
}

/**
 * The gesture list, which used to be a permanent section at the bottom of the
 * console. It is read once or twice by a new user and never again, so it earns
 * a button rather than a panel that everything else has to scroll past.
 */
export function HelpTool() {
  return (
    <NavTool id="help" label="Help" icon={<HelpIcon />} panelTitle="Controls" align="right">
      <ul className="keys">
        <li><b>Drag</b> a solid from Solids into the scene to add it</li>
        <li><b>Sweep across</b> a Solids row to choose how many sides its base has</li>
        <li><b>Drag the small grip</b> at the right of a Solids row to place the same solid as an <b>eraser</b> -- aim it like anything else, then confirm the subtraction under Position &amp; Rotation</li>
        <li><b>Drag</b> a 2D shape from Shapes onto any object</li>
        <li><b>Click</b> an object to select it, then <b>drag</b> it to move it</li>
        <li><b>Shift-click</b> objects to gather them, then <b>Merge</b> under Scene</li>
        <li><b>Drag from empty space</b> for a selection box; it takes every object whose gizmo falls inside it</li>
        <li><b>Shift</b> while dragging the box adds its catch to what is already selected</li>
        <li>Merged solids become one object with one gizmo; undo takes them apart</li>
        <li>The <b>Scene</b> list is a priority order -- use a row's arrows to move it, and where two objects share a surface the higher one is drawn</li>
        <li><b>Export</b> writes the whole scene: .glb, .obj or .stl for a mesh, .step for a CAD solid</li>
        <li><b>Shift</b> while moving an object lifts it instead</li>
        <li><b>Drag</b> a gizmo arrow to move along that axis, snapping as it goes</li>
        <li><b>Right-drag</b> the same arrow to resize the object along it</li>
        <li><b>Drag</b> the gizmo ring to scale every dimension at once</li>
        <li><b>Right-drag</b> the ring to turn, about whichever axis faces you</li>
        <li>The <b>cut plane</b> carries the same gizmo; its ring sizes the guide</li>
        <li><b>Apply cut</b> and <b>Reset plane</b> appear on the island once it is armed</li>
        <li><b>Drag</b> a sketch to slide it across its own surface</li>
        <li>A selected sketch gets three arrows: two along the outline's own edges, one facing away from the face</li>
        <li><b>Right-drag</b> either edge arrow to stretch the outline along it</li>
        <li><b>Drag</b> the arrow facing away to set the depth -- push it back through the face to cut inward instead</li>
        <li>Its ring scales the outline, the same way an object's scales the solid</li>
        <li><b>Drag</b> the highlighted end face of an extrusion to lean it</li>
        <li><b>Snap</b> and <b>Cut</b> live on the <b>Tools</b> island over the scene</li>
        <li><b>Drag the island by its title</b> to move it -- it snaps flush to whichever edge or corner you drop it near -- and click the title to collapse it</li>
        <li><b>Orbit</b> with middle-drag, or <b>Alt</b> and left-drag; zoom to scroll</li>
        <li><b>Pan</b> with right-drag on empty space</li>
        <li><b>Delete</b> removes the selected sketch, or the object</li>
        <li><b>Right-click</b> an object for copy, paste, and Save as custom object</li>
        <li><b>Ctrl+C</b> / <b>Ctrl+V</b> copy the selected object and paste it beside itself</li>
        <li>The console on the right holds the scene: Clipboard, Solids, Shapes, Colour and Scene</li>
        <li><b>Colour</b> paints the selected objects: turn the ring for the hue, the slider for brightness, then <b>Apply</b></li>
        <li>Or type the colour straight into the <b>hex field</b> under Apply -- that is also the way to reach a muted one, since the ring carries hue alone</li>
        <li>Applied colours land on the <b>shelf</b> below; click one to load it back into the picker</li>
        <li>Selecting something slides its <b>position, rotation and size</b> into the bottom-right of the viewport; a selected sketch adds its own controls under them</li>
        <li>Saved objects live in <b>Clipboard</b>, at the top of the console; drag one back in</li>
        <li>Each tile turns on its own; <b>sweep across one</b> to spin it and look it over</li>
        <li>Three tiles show models at a time; <b>scroll the row sideways</b> for the rest</li>
      </ul>
    </NavTool>
  )
}

/**
 * Which unit lengths are SHOWN in.
 *
 * A panel-only tool, like Help: there is nothing here to switch on or off, so
 * the button opens the choice rather than toggling anything. It sits in the
 * island beside Snap because it belongs to the same family -- a setting you
 * reach for while looking at the model, not a property of any one solid.
 *
 * Discrete buttons rather than a dropdown, reusing the `seg` control the side
 * count already uses: three options, all of them one or two characters, and a
 * select would hide two of the three behind a click to save no space at all.
 *
 * Nothing in the document changes when this does. The geometry is scene units
 * whatever is on screen; see `units.ts`.
 */
export function UnitsTool() {
  const displayUnit = useTools((s) => s.displayUnit)
  const setDisplayUnit = useTools((s) => s.setDisplayUnit)

  return (
    <NavTool id="units" label="Units" icon={<UnitsIcon />} panelTitle="Units">
      <div className="tool-group">
        <div className="seg">
          {UNIT_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className={`seg-btn${displayUnit === mode ? ' seg-active' : ''}`}
              aria-pressed={displayUnit === mode}
              onClick={() => setDisplayUnit(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>
    </NavTool>
  )
}
