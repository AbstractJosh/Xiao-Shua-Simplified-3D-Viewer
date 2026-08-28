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
import {
  BRUSH_RADIUS_MAX,
  BRUSH_RADIUS_MIN,
  BRUSH_SMOOTH_MIN,
  CUT_POSITION_LIMIT,
  CUT_SIZE_MAX,
  CUT_SIZE_MIN,
  DEFAULT_CUT_PLANE,
  RULER_LENGTH,
  cutPlaneNormal,
  rulerLength,
  useTools,
} from '../store/toolStore'
import type { CutPlaneState, RulerFrame, TransformMode } from '../store/toolStore'
// The camera, read the way the corner compass reads it. This file is where the
// island's tools are defined; the island itself is a viewport component, and
// `compassViews` is plain arithmetic with no React and no renderer in it.
import { compass } from '../viewport/compassViews'
import { NumberField } from './Field'
import { NavTool } from './NavTool'
import {
  CutIcon,
  BlowtorchIcon,
  HelpIcon,
  MoveIcon,
  RotateIcon,
  RulerIcon,
  ScaleIcon,
  SculptIcon,
  SettingsIcon,
  SnapIcon,
} from './navIcons'
import { UNIT_MODES, formatLength, fromDisplay } from '../units'
import { THEMES, THEME_LABELS } from '../theme'

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
 * choosing any of them is choosing against the other two.
 *
 * NONE of them can be on either, which is the one state the row could not show
 * until recently. Pressing the lit Move button takes the handles off the object
 * altogether and leaves the whole row dark -- because a gizmo you did not ask
 * for gets in the way of the tools that work ON the surface rather than on the
 * object, and deselecting the solid is not an acceptable way to put it down.
 * See `gizmoHidden`. Rotate and Scale still put away to Move, so the ladder
 * from any tool to nothing is two presses.
 *
 * What a press MEANS is `pressTransformMode`, in the store, rather than worked
 * out here: the keyboard shortcuts do exactly the same thing, and the two would
 * drift the first time one was edited.
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
  const gizmoHidden = useTools((s) => s.gizmoHidden)
  const pressTransformMode = useTools((s) => s.pressTransformMode)

  return (
    <NavTool
      label={label}
      icon={icon}
      // Dark while the handles are down, all three of them, which is what says
      // the object is wearing no gizmo rather than wearing this one.
      active={!gizmoHidden && current === mode}
      // The argument is ignored: which way the press goes is the store's to
      // decide, and it depends on more than this button's own state.
      onToggle={() => pressTransformMode(mode)}
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

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/**
 * How much wider than the object the guide square comes up, as a fraction.
 *
 * A tenth: plainly proud of the thing it is about to sever from every angle,
 * without the blade being so much bigger than the part that the part is the
 * small thing in the picture.
 */
const CUT_OVERHANG = 1.1

/**
 * Where an armed blade should appear: through the middle of the selected
 * object, level, and wide enough to overhang it.
 *
 * The plane used to spawn at the world origin every time, which is the same
 * complaint `rulerFrame` answers for rulers and it is worse here. The scene is
 * five metres across, so a part built anywhere but the middle of it got a blade
 * that was off screen -- and the cut is fired from a button, not from the
 * gizmo, so the user could arm the tool, press Apply cut, and be told the plane
 * "does not pass all the way through" without ever having seen the plane.
 * Landing it on the object makes the default cut the one people mean: straight
 * through the middle of the thing they have selected.
 *
 * The object is the PRIMARY selection -- the head of the list, the one wearing
 * the gizmo, and already the one this tool CUTS. Placing the blade anywhere
 * else would put it through a solid the Apply button was not going to touch.
 *
 * LEVEL, not turned to face anything. Which way the blade lies is the one thing
 * the user aims by hand, and it is what "Reset plane" has always promised to
 * put back; only WHERE it starts was the problem being solved. A spawn that
 * also guessed a tilt would be a second answer to a question nobody asked.
 *
 * SIZE is taken off the box's diagonal rather than its width, so the square
 * still overhangs the object once the user tilts it -- a blade sized to the
 * footprint shrinks inside the part the moment it turns, and the guide stops
 * telling you where the cut lands. It never comes up smaller than the default,
 * which is a size already chosen to be grabbable.
 *
 * Measured off `objectBounds`, the same analytic box `rulerFrame` uses: a
 * feature standing proud of the primitive is not counted. For a spawn point
 * that is the right trade -- it costs no boolean solve, and the blade is a
 * thing you immediately drag by its gizmo anyway.
 *
 * Pure, and given the object rather than reading it, so `ui-check` can state
 * the rule without a document in front of it.
 */
export function cutPlaneSpawn(object: SceneObject | null): CutPlaneState {
  const box = object === null ? null : objectBounds(object)
  // No object, or one with no extent to sever: the middle of the scene, which
  // is where the blade has always come up.
  if (box === null || box.isEmpty()) return DEFAULT_CUT_PLANE

  const centre = box.getCenter(new Vector3())
  const span = box.getSize(new Vector3()).length()
  return {
    // Clamped to the same bound the gizmo drags against, so a spawn can never
    // put the plane somewhere the user is then unable to drag it back from.
    position: [
      clamp(centre.x, -CUT_POSITION_LIMIT, CUT_POSITION_LIMIT),
      clamp(centre.y, -CUT_POSITION_LIMIT, CUT_POSITION_LIMIT),
      clamp(centre.z, -CUT_POSITION_LIMIT, CUT_POSITION_LIMIT),
    ],
    rotation: [0, 0, 0],
    size: clamp(
      Math.max(span * CUT_OVERHANG, DEFAULT_CUT_PLANE.size),
      CUT_SIZE_MIN,
      CUT_SIZE_MAX
    ),
  }
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
      // Read at the press rather than subscribed to, exactly as the ruler reads
      // its frame: where the blade lands is only a question at the moment it is
      // armed, and a hook on the selection would re-render the island on every
      // click in the scene.
      onToggle={(on) => setCutActive(on, cutPlaneSpawn(selectedObject(useDoc.getState())))}
    />
  )
}

/**
 * The torch, and the three numbers that describe what it does.
 *
 * A tool with both a switch and a panel, the shape the Ruler already has:
 * pressing the button arms it, which is the frequent act and stays one click,
 * and the caret opens the settings, which are the rare act. Nobody should have
 * to open a panel to start melting something.
 *
 * The three numbers are genuinely three different questions and none of them
 * can stand in for another. SIZE is how much of the model the brush covers --
 * the thing you change constantly, between a corner and a whole face. HEAT is
 * how fast one pass bites, which is the difference between a scorch you can
 * feather and a gouge you commit to. SMOOTHING is what KIND of mark it leaves:
 * at zero the brush sinks the surface and leaves it as faceted as it found it,
 * which reads as sandblasting, and at full it lets the surface flow into
 * itself, which is the molten look the tool exists for.
 *
 * The values are read at the moment each dab is laid down and stored ON the dab
 * -- see `ErodeDab` -- so turning the heat up does not retroactively deepen the
 * groove you cut a minute ago.
 *
 * Arming it puts the sculpt tool down, and no code here says so: the store
 * holds ONE brush. See `BrushTool`.
 */
export function ErodeTool() {
  const armed = useTools((s) => s.brushTool === 'torch')
  const radius = useTools((s) => s.erodeRadius)
  const sizeUnit = useTools((s) => s.erodeSizeUnit)
  const heat = useTools((s) => s.erodeHeat)
  const smooth = useTools((s) => s.erodeSmooth)
  const setBrushTool = useTools((s) => s.setBrushTool)
  const setErodeRadius = useTools((s) => s.setErodeRadius)
  const setErodeSizeUnit = useTools((s) => s.setErodeSizeUnit)
  const setErodeHeat = useTools((s) => s.setErodeHeat)
  const setErodeSmooth = useTools((s) => s.setErodeSmooth)

  return (
    <NavTool
      id="erode"
      label="Blowtorch"
      icon={<BlowtorchIcon />}
      active={armed}
      onToggle={(on) => setBrushTool(on ? 'torch' : null)}
      panelTitle="Blowtorch"
    >
      <div className="tool-group">
        {/* A length, and one of the two in the app that do NOT follow the
            app-wide unit -- it carries its own picker and starts in
            centimetres.

            The brush runs from 1 mm to 1.25 m, so under `auto`, which is what
            the app is set to out of the box, one drag of this slider crosses
            both of `resolveUnit`'s switching points: the number goes 9.9, then
            1.00, then 99.9, then 1.00, while the hand never changes direction.
            That is `auto` doing its job -- it is a rule for READING a length at
            any magnitude -- and it is the wrong job here, because this control
            sets one. A scale that renumbers itself under the pointer cannot be
            aimed. See `erodeSizeUnit`.

            The other two are pure ratios and carry no unit at all, which is why
            only this one is marked. */}
        <NumberField
          ownUnit={{ unit: sizeUnit, onChange: setErodeSizeUnit }}
          label="Brush size"
          value={radius}
          min={BRUSH_RADIUS_MIN}
          max={BRUSH_RADIUS_MAX}
          step={0.01}
          onChange={setErodeRadius}
        />
        <NumberField
          label="Heat"
          value={heat}
          min={0}
          max={1}
          step={0.05}
          onChange={setErodeHeat}
        />
        {/* The floor is not zero, and it is geometry rather than taste: a
            point melted with no flow at all collapses the ring around it and
            grows a spur. See BRUSH_SMOOTH_MIN. */}
        <NumberField
          label="Smoothing"
          value={smooth}
          min={BRUSH_SMOOTH_MIN}
          max={1}
          step={0.05}
          onChange={setErodeSmooth}
        />
      </div>
    </NavTool>
  )
}

/**
 * The sculpt tool: the same brush, drawing material on instead of taking it
 * away.
 *
 * THE TORCH'S PANEL WITH ONE WORD CHANGED, and that is the point rather than an
 * economy. The two tools are one piece of geometry with a sign in front of it
 * -- a bead this raises is exactly as tall as the dish the torch sinks at the
 * same three settings -- so a user who has learned what Size and Smoothing do
 * to a groove already knows what they do to a ridge, and a second vocabulary
 * would be teaching them the same thing twice.
 *
 * The word that changes is HEAT, which becomes STRENGTH. It is the same number
 * in the same range and it lands in the same field of the same dab; what it is
 * not is hot. Naming it Heat here would be the icon problem in words -- a
 * metaphor carried over from the tool next door into one where it means
 * nothing.
 *
 * SMOOTHING has the same floor, for the mirror of the same reason: a bead
 * raised with no flow at all pushes the surface out faster than the mesh can
 * spread to carry it, and what stands up is a spike rather than a ridge. See
 * BRUSH_SMOOTH_MIN.
 *
 * Its own three values rather than the torch's -- see `sculptRadius` -- so
 * swapping tools does not resize the brush under your hand.
 */
export function SculptTool() {
  const armed = useTools((s) => s.brushTool === 'sculpt')
  const radius = useTools((s) => s.sculptRadius)
  const sizeUnit = useTools((s) => s.sculptSizeUnit)
  const strength = useTools((s) => s.sculptStrength)
  const smooth = useTools((s) => s.sculptSmooth)
  const setBrushTool = useTools((s) => s.setBrushTool)
  const setSculptRadius = useTools((s) => s.setSculptRadius)
  const setSculptSizeUnit = useTools((s) => s.setSculptSizeUnit)
  const setSculptStrength = useTools((s) => s.setSculptStrength)
  const setSculptSmooth = useTools((s) => s.setSculptSmooth)

  return (
    <NavTool
      id="sculpt"
      label="Sculpt"
      icon={<SculptIcon />}
      active={armed}
      onToggle={(on) => setBrushTool(on ? 'sculpt' : null)}
      panelTitle="Sculpt"
    >
      <div className="tool-group">
        {/* Pinned to its own unit for the reason the torch's is, and pinned
            separately so the two can be read in whatever suits each. See
            `erodeSizeUnit`. */}
        <NumberField
          ownUnit={{ unit: sizeUnit, onChange: setSculptSizeUnit }}
          label="Brush size"
          value={radius}
          min={BRUSH_RADIUS_MIN}
          max={BRUSH_RADIUS_MAX}
          step={0.01}
          onChange={setSculptRadius}
        />
        <NumberField
          label="Strength"
          value={strength}
          min={0}
          max={1}
          step={0.05}
          onChange={setSculptStrength}
        />
        <NumberField
          label="Smoothing"
          value={smooth}
          min={BRUSH_SMOOTH_MIN}
          max={1}
          step={0.05}
          onChange={setSculptSmooth}
        />
      </div>
    </NavTool>
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
        // Reset means "put it back where arming would drop it", which is the
        // selected object -- not the world origin. Anything else and the button
        // that undoes your aiming would carry the blade off the part you were
        // aiming it at, which is the one place you were sure to want it.
        title={
          selectedObjectId === null
            ? 'Return the plane to the middle of the scene, level'
            : 'Return the plane to the selected object, level'
        }
        onClick={() => resetCutPlane(cutPlaneSpawn(selectedObject(useDoc.getState())))}
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
 * The button that opens the manual.
 *
 * Nothing but a button now. It used to be a `NavTool` with sixty sentences
 * folded into its panel; the sentences moved to `HelpScreen`, which takes the
 * window rather than a 330px column -- see that file for why a document does
 * not fit in a dropdown.
 *
 * It still goes through `NavTool` and still owns the `help` panel id, and that
 * is the point rather than a leftover. `NavTool` with no children draws no
 * panel and the press falls through to `setOpenPanel`, so the screen opens off
 * the SAME one field every other panel in the bar uses. Escape, click-outside
 * and the headless drive in `ui-check` all keep working without learning that
 * one of the panels is now a window.
 */
export function HelpTool() {
  return <NavTool id="help" label="Help" icon={<HelpIcon />} />
}

/**
 * The two states of the outline switch, in the order the segment shows them.
 *
 * On first, matching every other row in the panel: the segments in here read
 * left to right from the default outwards, and the default is lines on.
 *
 * A list rather than two hand-written buttons, so the row is built by the same
 * `map` the units and the themes are and cannot drift into a different button.
 * It stays local -- unlike `THEMES` and `UNIT_MODES`, which are exported
 * because the geometry and the stylesheet have to agree with them, this is two
 * labels for one boolean and nothing outside the panel needs them.
 */
const OUTLINE_CHOICES = [
  { on: true, label: 'On', title: 'Draw the edge lines around every solid' },
  { on: false, label: 'Off', title: 'Hide them and show the surfaces bare' },
] as const

/**
 * Everything about how the app is READ rather than what it contains.
 *
 * A panel-only tool, like Help: there is nothing here to switch on or off, so
 * the cog opens the choices rather than toggling anything.
 *
 * WHY THESE TOGETHER. A unit and a theme are the same kind of thing, and it
 * took having a second one to see it: neither touches the document. The geometry
 * is scene units whatever is on screen and whatever palette is around it, so a
 * millimetre and a dark background are both facts about this viewer rather than
 * about the model -- which is exactly what a preferences menu is for. Units had
 * been living in the bar as a button of its own, next to Export, on the argument
 * that the two answer "what are these numbers in" from either side. That is
 * still true; it is just a weaker claim than being the same kind of setting as
 * everything else in here, and the bar has one fewer button for it.
 *
 * Outlines is the third of exactly that kind and the one that proves the rule
 * was worth writing down: it changes what the scene LOOKS like and changes
 * nothing about what is in it, so it belongs here rather than on the island
 * with the tools that act on the model. See `showOutlines`.
 *
 * Last in the row, right of Help. The cluster runs from the most document-
 * specific to the least -- export it, snap it, undo it, learn it, configure the
 * app around it -- and settings is the only thing here that is still true of the
 * next document you open.
 *
 * Discrete buttons rather than dropdowns, reusing the `seg` control the side
 * count already uses: every option in here is one or two words, and a select
 * would hide all but one of them behind a click to save no space at all.
 */
export function SettingsTool() {
  const displayUnit = useTools((s) => s.displayUnit)
  const setDisplayUnit = useTools((s) => s.setDisplayUnit)
  const theme = useTools((s) => s.theme)
  const setTheme = useTools((s) => s.setTheme)
  const showOutlines = useTools((s) => s.showOutlines)
  const setShowOutlines = useTools((s) => s.setShowOutlines)

  return (
    // Opens leftwards like everything else in this cluster, and more so than
    // anything else in it: this is the last button in the bar, so a panel
    // hanging off its left edge is the only one that stays on screen.
    <NavTool
      id="settings"
      label="Settings"
      icon={<SettingsIcon />}
      panelTitle="Settings"
      align="right"
    >
      {/* Named so the panel can size itself to two rows of short buttons rather
          than to the 268px a snap field or a ruler list wants. The width lives
          in CSS, keyed off what the panel HOLDS -- the same way Help's is -- so
          a panel stays a panel and nothing here has to pass a flag about its
          own layout. */}
      <div className="settings-groups">
        <div className="tool-group units-modes">
          <p className="subhead">Units</p>
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

        {/* One theme today, and it is still drawn as a chooser rather than as a
            line of text saying "Dark". A control that shows the state it is in
            is honest at one option and needs no rewriting at two; a label would
            have to become a control the moment the second palette lands, and
            until then it would not even say that the choice exists. */}
        <div className="tool-group theme-modes">
          <p className="subhead">Theme</p>
          <div className="seg">
            {THEMES.map((name) => (
              <button
                key={name}
                type="button"
                className={`seg-btn${theme === name ? ' seg-active' : ''}`}
                aria-pressed={theme === name}
                onClick={() => setTheme(name)}
              >
                {THEME_LABELS[name]}
              </button>
            ))}
          </div>
        </div>

        {/* A yes-or-no, and still a segment rather than a checkbox or a slider
            switch. Two reasons, and the second is the one that decided it. It
            keeps the panel one kind of control, so three rows read as three
            answers to the same shape of question instead of a menu with a
            gadget bolted to the bottom. And it names both states: `On | Off`
            with one lit says what the alternative IS, which a lone tickbox
            leaves you to infer from an empty square. */}
        <div className="tool-group outline-modes">
          <p className="subhead">Outlines</p>
          <div className="seg">
            {OUTLINE_CHOICES.map((choice) => (
              <button
                key={choice.label}
                type="button"
                className={`seg-btn${showOutlines === choice.on ? ' seg-active' : ''}`}
                aria-pressed={showOutlines === choice.on}
                title={choice.title}
                onClick={() => setShowOutlines(choice.on)}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </NavTool>
  )
}
