import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Quaternion, Vector3 } from 'three'
import { objectBounds } from '../geometry/assembly'
import type { SceneObject, Vec3 } from '../geometry/types'
import {
  selectedObject,
  selectedObjectId as primarySelection,
  useDoc,
} from '../store/docStore'
import { RULER_LENGTH, cutPlaneNormal, rulerLength, useTools } from '../store/toolStore'
import type { RulerFrame, TransformMode } from '../store/toolStore'
// The camera, read the way the corner compass reads it. This file is where the
// island's tools are defined; the island itself is a viewport component, and
// `compassViews` is plain arithmetic with no React and no renderer in it.
import { compass } from '../viewport/compassViews'
import { NumberField } from './Field'
import { NavTool } from './NavTool'
import {
  CutIcon,
  HelpIcon,
  MoveIcon,
  RotateIcon,
  RulerIcon,
  ScaleIcon,
  SnapIcon,
  UnitsIcon,
} from './navIcons'
import { UNIT_MODES, formatLength, fromDisplay } from '../units'

/**
 * The three tools that change what the gizmo IS, as a row of three.
 *
 * A PICKER rather than a pair of switches with an unnamed third state. Move is
 * where the gizmo rests, and leaving it off the panel made that state the
 * absence of two highlights -- which is a thing you have to work out rather
 * than read, and it left the row looking like two spare buttons above the
 * scene tools. One of the three is always lit, and it says which gizmo is on
 * screen without the user deducing it.
 *
 * Exactly one can be on, and no code enforces it: the store holds ONE mode, so
 * choosing any of them is choosing against the other two. Pressing the one you
 * are already in leaves you there -- both arms of the toggle below land on the
 * same value for Move, and for the other two "off" means Move.
 *
 * Written once and used three times, because they differ in two words each.
 */
function ModeTool({
  mode,
  label,
  icon,
}: {
  mode: TransformMode
  label: string
  icon: ReactNode
}) {
  const current = useTools((s) => s.transformMode)
  const setTransformMode = useTools((s) => s.setTransformMode)

  return (
    <NavTool
      label={label}
      icon={icon}
      active={current === mode}
      // Off lands on Move rather than on nothing: every target has somewhere to
      // be moved to, so there is always a gizmo, and the one that comes back is
      // the arrows and the plane quads.
      onToggle={(on) => setTransformMode(on ? mode : 'move')}
      // No hover bubble, which is the island's own rule and the same one Snap
      // and Cut follow: these are pressed constantly, and a paragraph that
      // appears every time the pointer crosses them is noise rather than help.
      // What each one draws, and the key that reaches it, are in Help.
    />
  )
}

/** Where the gizmo rests: three arrows to slide along, and the three plane
 *  quads between them to slide within. The tool the app opens in. */
export function MoveTool() {
  return <ModeTool mode="move" label="Move" icon={<MoveIcon />} />
}

/** Three rings, one per world plane, each turning about the axis it is normal
 *  to -- and the arrows step aside, since a turn is the one gesture that would
 *  carry them off. */
export function RotateTool() {
  return (
    <ModeTool mode="rotate" label="Rotate" icon={<RotateIcon />} />
  )
}

/** The ring for everything at once, and the arrows for one dimension at a
 *  time -- which is what the right button used to do. */
export function ScaleTool() {
  return (
    <ModeTool mode="scale" label="Scale" icon={<ScaleIcon />} />
  )
}

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
      // In the bar now, near its right edge, so the panel opens leftwards the
      // way Units, Export and Help do -- hanging off the left of the button it
      // would run past the window.
      align="right"
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

/** Clear air between a fresh ruler and the solid it was laid down beside.
 *  15 mm: wide enough to read as a gap rather than as a line stuck to a face,
 *  and narrow enough that the ruler is plainly about THAT object. */
const RULER_CLEARANCE = fromDisplay(15, 'mm')

/**
 * How near the eye a ruler may be laid down, whatever else this asks for.
 *
 * Only a camera standing inside the solid it is looking at can ask for nearer
 * -- the push below is off the object's own near face, so a five-metre part
 * seen from half a metre away wants the ruler somewhere behind the viewer's
 * head. One ruler-length out, a 50 mm line spans most of the view: as close as
 * a thing can come and still be a thing you can see all of.
 */
const RULER_STANDOFF = RULER_LENGTH

/**
 * The camera, as much of it as laying a ruler down needs.
 *
 * Structural, and satisfied by `compass` -- which is where the real one comes
 * from -- so a check can state the rule with a camera it made up rather than a
 * canvas it has to run.
 */
type CameraView = { facing: Quaternion; eye: Vector3; focus: Vector3 }

/**
 * Where a ruler laid down NOW should land, and which way it should lie: across
 * the view, in front of the selected object, facing the user.
 *
 * A ruler that spawned at the origin was a ruler you had to go and find. The
 * scene is five metres across and the thing being measured is usually nowhere
 * near the middle of it, so "add ruler" put a 50 mm line somewhere off screen
 * and the tool looked like it had done nothing.
 *
 * The object is the PRIMARY selection -- the one wearing the gizmo, the one the
 * cut aims at, the one this app means by "the selected object" everywhere else.
 * Shift-clicking a second solid does not move the ruler to it, for the same
 * reason it does not move the gizmo.
 *
 * THREE THINGS HAVE TO BE TRUE for a spawn to be one the user can see, and the
 * frame is built out of the camera because not one of them is a fact about the
 * world:
 *
 *  - It must not be BEHIND the object. The push runs along the view axis, out
 *    by the box's own extent along that axis plus a clearance, so every point
 *    of the ruler ends up nearer the eye than every point of the box -- from
 *    wherever the camera happens to be standing. Pushed along a fixed world
 *    axis instead, the ruler is in front of the solid from one side of it and
 *    buried inside it from the other.
 *  - It must not be END-ON. It runs along the camera's right, so it lies ACROSS
 *    the view at its full length. A ruler laid along world X is a dot on screen
 *    the moment the user looks down X, which is one click of the compass away.
 *  - The SECOND one must not hide behind the first. The lane steps up the
 *    screen, perpendicular to the view, so consecutive rulers stack up the
 *    picture rather than into it.
 *
 * Sideways it stays over the middle of the object: the push is purely along the
 * view, which moves nothing on screen, so the ruler lands ON the thing it was
 * asked for rather than beside it.
 *
 * With NOTHING SELECTED it goes to the point the camera orbits, which is the
 * middle of the viewport by construction -- the one place something can be put
 * with no scene to hang it off and still be certain it is on screen.
 *
 * What it does NOT promise is a clear line of sight past everything else: a
 * second solid parked between the camera and this one will cover the ruler, and
 * answering that would mean a raycast per spawn against the evaluated scene.
 * The object being measured is the one that would hide it, and that one it
 * clears exactly.
 *
 * Measured off `objectBounds`, which is analytic: a feature standing proud of
 * the primitive is not counted, so a ruler can spawn touching a boss. That is
 * the right trade for a spawn point -- it costs no boolean solve, and the ruler
 * is a thing you immediately drag by its ends anyway.
 *
 * Pure, and given the object and the camera rather than reading either, so
 * `ui-check` can state the rule without a document or a canvas.
 */
export function rulerFrame(object: SceneObject | null, camera: CameraView): RulerFrame {
  // The camera's own axes in world terms: its +X is the screen's right, its +Y
  // the screen's up, and it looks down its own -Z.
  const along = new Vector3(1, 0, 0).applyQuaternion(camera.facing)
  const step = new Vector3(0, 1, 0).applyQuaternion(camera.facing)
  const view = new Vector3(0, 0, -1).applyQuaternion(camera.facing)
  const frame = (at: Vector3): RulerFrame => ({
    anchor: [at.x, at.y, at.z],
    along: [along.x, along.y, along.z],
    step: [step.x, step.y, step.z],
  })

  const box = object === null ? null : objectBounds(object)
  // No object, or one with no extent to stand off from: the middle of the view.
  if (box === null || box.isEmpty()) return frame(camera.focus.clone())

  const centre = box.getCenter(new Vector3())
  const half = box.getSize(new Vector3()).multiplyScalar(0.5)
  // How far the box reaches from its own centre along the view axis -- the
  // exact support of a box in a direction, which is what makes "clear of it" a
  // guarantee rather than a guess.
  const reach =
    half.x * Math.abs(view.x) + half.y * Math.abs(view.y) + half.z * Math.abs(view.z)
  const depth = centre.clone().sub(camera.eye).dot(view)
  const wanted = Math.max(depth - reach - RULER_CLEARANCE, RULER_STANDOFF)
  // Along the view, so only the DEPTH changes: on screen the anchor stays put,
  // over the middle of the object.
  return frame(centre.addScaledVector(view, wanted - depth))
}

/**
 * The rulers in the scene, and the button that adds one.
 *
 * A tool with BOTH a switch and a panel, which no other tool in the island has:
 * pressing the button engages the tool and lays the first ruler down, so the
 * commonest thing anyone wants from it -- one ruler, now -- is a single click
 * and never opens anything. The caret beside it opens the list, which is where
 * the second and third come from, and where any of them is deleted.
 *
 * The list is the tool's memory made visible. Rulers are small and get left
 * lying across a scene, and one dragged behind a solid is a thing you can no
 * longer find by looking -- so every one of them has a row here, saying what it
 * reads, with a press to bring its handles back and a cross to take it away.
 */
export function RulerTool() {
  const rulerActive = useTools((s) => s.rulerActive)
  const rulers = useTools((s) => s.rulers)
  const selectedRuler = useTools((s) => s.selectedRuler)
  const displayUnit = useTools((s) => s.displayUnit)
  const setRulerActive = useTools((s) => s.setRulerActive)
  const addRuler = useTools((s) => s.addRuler)
  const removeRuler = useTools((s) => s.removeRuler)
  const selectRuler = useTools((s) => s.selectRuler)

  // Read at the press rather than subscribed to: where the ruler goes is only
  // ever a question at the moment one is laid down, and a hook on either would
  // re-render the island on every click in the scene and every frame of an
  // orbit. `compass` is the camera as anything outside the canvas sees it --
  // this button is a DOM sibling of the canvas exactly as the compass widget
  // is, and neither has a camera of its own to read.
  const frame = () => rulerFrame(selectedObject(useDoc.getState()), compass)

  return (
    <NavTool
      id="ruler"
      label="Ruler"
      icon={<RulerIcon />}
      active={rulerActive}
      onToggle={(on) => setRulerActive(on, frame())}
      panelTitle="Rulers"
    >
      <div className="tool-group">
        <button type="button" className="nav-action" onClick={() => addRuler(frame())}>
          Add ruler
        </button>

        {rulers.length === 0 ? (
          // Said out loud rather than left as an empty box. The list is also
          // the answer to "where did my ruler go", and a blank panel does not
          // distinguish "none" from "not loaded".
          <p className="nav-note ruler-empty">No rulers yet.</p>
        ) : (
          <ul className="ruler-list">
            {rulers.map((ruler, i) => {
              const chosen = selectedRuler?.id === ruler.id
              return (
                <li
                  key={ruler.id}
                  className={`ruler-row${chosen ? ' ruler-row-on' : ''}`}
                >
                  {/* Selecting from here keeps whichever end is already in
                      hand, so pressing the row of the ruler you are working on
                      does not throw the gizmo back to the far end of it. */}
                  <button
                    type="button"
                    className="ruler-pick"
                    aria-pressed={chosen}
                    onClick={() =>
                      selectRuler({ id: ruler.id, end: chosen ? selectedRuler.end : 0 })
                    }
                  >
                    <span className="ruler-name">{`Ruler ${i + 1}`}</span>
                    <span className="ruler-reading">
                      {formatLength(rulerLength(ruler), displayUnit)}
                    </span>
                  </button>

                  <button
                    type="button"
                    className="ruler-remove"
                    title={`Delete ruler ${i + 1}`}
                    aria-label={`Delete ruler ${i + 1}`}
                    onClick={() => removeRuler(ruler.id)}
                  >
                    <svg viewBox="0 0 10 10" aria-hidden>
                      <path
                        d="M2.5 2.5 L7.5 7.5 M7.5 2.5 L2.5 7.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </NavTool>
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
        <li><b>Units</b>, beside Export, chooses what every length is shown in -- mm, cm, or auto per value; the model itself never changes</li>
        <li><b>Shift</b> while moving an object lifts it instead</li>
        <li>The gizmo comes in three, chosen at the top of the <b>Tools</b> island: <b>Move</b>, where it rests, <b>Rotate</b> and <b>Scale</b>. Each draws the handles for its own job, and every one of them is a left-drag</li>
        <li><b>Move</b>: <b>drag</b> an arrow to slide along that axis, snapping as it goes</li>
        <li>Or <b>drag</b> one of the three plane quads -- XY, XZ, YZ -- to slide within that plane. One seen edge-on stands down, so from straight above only the ground is offered</li>
        <li><b>Rotate</b> (<b>R</b>): three rings, one per plane. Drag the red, green or blue one to turn about X, Y or Z; the wedge reads the sweep out in degrees and it lands on every 45</li>
        <li><b>Scale</b> (<b>S</b>): drag the ring to scale every dimension at once, or an arrow to resize the one dimension it points along</li>
        <li>One of the three is always on: pressing <b>Rotate</b> or <b>Scale</b> again puts you back on <b>Move</b>, which is where the app opens</li>
        <li>The <b>cut plane</b> carries the same gizmo -- arrows to aim it, rings to tilt it -- and in Scale its ring sizes the guide square</li>
        <li><b>Apply cut</b> and <b>Reset plane</b> appear on the island once it is armed</li>
        <li><b>Drag</b> a sketch to slide it across its own surface</li>
        <li>A selected sketch gets three arrows: two along the outline's own edges, one facing away from the face</li>
        <li>In <b>Scale</b>, drag either edge arrow to stretch the outline along it</li>
        <li><b>Drag</b> the arrow facing away to set the depth -- push it back through the face to cut inward instead</li>
        <li>Its ring scales the outline, the same way an object's scales the solid; in <b>Rotate</b> it gets ONE ring, since a sketch spins in its own face and nowhere else</li>
        <li><b>Drag</b> the highlighted end face of an extrusion to lean it</li>
        <li>The <b>Ruler</b> tool lays a 50 mm measuring line across the view, in front of the selected object; its readout rides the middle of it</li>
        <li><b>Click a ruler</b> to select it -- it thickens into yellow and black stripes and the end you pressed nearest takes the arrows</li>
        <li><b>Press the knob</b> at the other end to move the arrows there; each end snaps to corners and edges as you drag it</li>
        <li>A ruler's end is a point, so its gizmo stays on Move whichever tool is up -- there is nothing about a point to turn or to scale</li>
        <li><b>Delete</b> removes the selected ruler; the <b>caret beside Ruler</b> opens the list, to add more or delete one with its red cross</li>
        <li><b>Move</b>, <b>Rotate</b>, <b>Scale</b>, <b>Ruler</b> and <b>Cut</b> live on the <b>Tools</b> island over the scene; <b>Snap</b> is in the top bar beside <b>Units</b>, since it is a rule every drag obeys rather than a gizmo</li>
        <li><b>Drag the island by its title</b> to move it -- it snaps flush to whichever edge or corner you drop it near -- and click the title to collapse it</li>
        <li><b>Orbit</b> with middle-drag, or <b>Alt</b> and left-drag; zoom to scroll</li>
        <li><b>Drag the corner compass</b> to orbit by hand -- half a turn across the widget, rotation only</li>
        <li><b>Click</b> one of its balls or cube faces instead to fly square-on to that view</li>
        <li><b>Pan</b> with right-drag on empty space</li>
        <li><b>Delete</b> removes the selected ruler, or the selected sketch, or the object</li>
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
 * the button opens the choice rather than toggling anything.
 *
 * In the BAR, immediately right of Export, rather than on the island over the
 * scene where it started. The island holds MODES -- Snap, Ruler, Cut -- each
 * aimed at the solid under the pointer and each changing what the next drag
 * does. A unit changes no gesture and no geometry: it re-reads every length in
 * the app at once, which is document-wide, like the three controls it now sits
 * among. Beside Export specifically because the two answer one question from
 * either side of it -- what are these numbers in, on screen and in the file.
 *
 * Being in the bar is also what makes its menu drop DOWN from the button, the
 * way Export's does. On the island it had to open sideways, across the scene,
 * because a panel hanging below would have covered the buttons under it in the
 * column; see the `.tool-island .nav-panel` rules.
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
    // Opens leftwards like everything else in this cluster: the panel is wider
    // than the button and there is no room to its right.
    <NavTool id="units" label="Units" icon={<UnitsIcon />} panelTitle="Units" align="right">
      {/* Named so the panel can size itself to three two-character buttons
          rather than to the 268px a snap field or a ruler list wants. The
          width lives in CSS, keyed off what the panel HOLDS -- the same way
          Help's is -- so a panel stays a panel and nothing here has to pass a
          flag about its own layout. */}
      <div className="tool-group units-modes">
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
