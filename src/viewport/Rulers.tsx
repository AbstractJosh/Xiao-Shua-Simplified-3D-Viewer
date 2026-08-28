import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import { Mesh, Quaternion, Vector3 } from 'three'
import type { Object3D } from 'three'
import { useDoc } from '../store/docStore'
import { rulerLength, useTools } from '../store/toolStore'
import type { Ruler, RulerEnd } from '../store/toolStore'
import { formatLength } from '../units'
import { useSceneColors } from './useSceneColors'
import { TransformGizmo, biasedRaycast } from './TransformGizmo'

/**
 * The rulers laid over the scene, and the readouts that say what they measure.
 *
 * A ruler is two points and the line between them. It changes nothing about the
 * document -- which is why it lives in the tool store, out of undo, beside the
 * cut plane -- and the whole of the tool is the two ends being easy to put
 * exactly where you mean. So the ends catch the scene the way a dragged solid
 * does, through the same snapper and the same Snap switch, and the number rides
 * the middle of the line rather than sitting in a panel across the window from
 * the thing being measured.
 *
 * WHAT A SELECTED RULER LOOKS LIKE is the other half of it. Passive, it is a
 * thin yellow line: present, readable, and quiet enough that half a dozen of
 * them across a scene are still a scene rather than a diagram. Selected, it
 * thickens and takes yellow-and-black stripes -- the one thing on screen
 * wearing hazard tape, which is a signal no solid, gizmo or sketch in the app
 * competes with, so "which of these am I dragging" is answered at a glance from
 * any angle.
 */

/* The ruler's three colours -- the line, the dark half of its stripes, and the
   knob under the pointer -- are per theme and live in `sceneColors`, which also
   carries the reasoning that used to sit here. The line mirrors styles.css
   --ruler and is guarded by `ui-check` in every theme; the other two have no
   console counterpart. */

const IDLE_WIDTH = 1.6
const SELECTED_WIDTH = 5

/**
 * How often a stripe repeats along a selected ruler: every centimetre, so the
 * stripes are graduations as well as a highlight and a glance at one says
 * roughly how long it is before the readout is read at all.
 *
 * Capped in NUMBER as well as in size, because a two-metre ruler ruled every
 * centimetre is two hundred stripes -- finer than the line is wide at any
 * sensible zoom, and it turns into a solid yellow smear. Past the cap the
 * stripes stop being graduations and go back to being a highlight, which is the
 * job that still needs doing at that length.
 */
const STRIPE_PERIOD = 0.1
const MAX_STRIPES = 40

/** Apparent size for the end markers, the rule the gizmo and the snap marker
 *  both follow: scaled with camera distance so they hold one size on screen. */
const SCALE_PER_UNIT = 0.07
const SCALE_MIN = 0.014
const SCALE_MAX = 10

/** Marker radii, in the units the gizmo's own parts are written in. The knob
 *  that swaps ends is the bigger of the two drawn, because it is the only one
 *  ever aimed at; the volume that catches it is bigger again, and invisible. */
const DOT_RADIUS = 0.055
const KNOB_RADIUS = 0.1
const KNOB_GRAB = 0.16

/** The invisible tube along the line that catches a press on it. Thinner than a
 *  gizmo arrow's: a ruler is a hairline rather than a handle, and a fat tube
 *  would take presses meant for whatever it happens to lie across. */
const LINE_GRAB = 0.055

/**
 * Under the gizmo, over everything else.
 *
 * Rulers are annotations, and one drawn behind the solid it measures is a
 * measurement you have to orbit to read. But the gizmo standing on the end of
 * one has to stay on top of the ruler itself, so it keeps the higher number --
 * see `DRAW_ON_TOP` in TransformGizmo.
 */
const DRAW_OVER_SCENE = 26

/**
 * The ruler wins the pointer over the solids it crosses, for the same reason
 * the gizmo does: it is drawn over them, so a press that lands on what is
 * plainly on screen has to reach it. An order of magnitude weaker than the
 * gizmo's ring, so where a ruler passes through the arrows -- which it does
 * every time an end is dragged, since the arrows stand on that very end -- the
 * gizmo still takes the press.
 */
const RULER_PRIORITY = 1e-4
const rulerRaycast = biasedRaycast(RULER_PRIORITY)

/** The drawn line is decoration; the tube around it is what is aimed at. */
const noRaycast: Object3D['raycast'] = () => {}

/**
 * The line's own geometry, in the frame the group below sets up: from the
 * origin, one unit along +Y.
 *
 * A module constant, and the reason a ruler is drawn as a unit segment inside a
 * transformed group rather than as a line between two world points. drei's
 * `Line` rebuilds its GPU buffers whenever `points` changes identity, and an
 * end being dragged changes it every frame -- so a ruler drawn the obvious way
 * would allocate and upload a fresh line geometry sixty times a second. Turned
 * and stretched by its group instead, the geometry is uploaded once for the
 * life of the app and a drag moves a matrix.
 *
 * It also decides what the dash lengths mean: `computeLineDistances` measures in
 * the geometry's OWN space, so the stripe sizes below are fractions of a
 * ruler's length rather than absolute distances.
 */
const SEGMENT = [new Vector3(0, 0, 0), new Vector3(0, 1, 0)]

/** What `SEGMENT` runs along, and so what the group has to turn onto the line. */
const SEGMENT_AXIS = new Vector3(0, 1, 0)

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/**
 * Where each ruler's readout has landed on screen, in CSS pixels from the canvas
 * corner, keyed by ruler id.
 *
 * The same seam the rotation readout uses, widened to a map because any number
 * of rulers can be on screen at once: the projection happens inside the canvas,
 * where the camera is, and the text is a plain DOM node outside it, because a
 * length wants to be crisp and upright at every camera angle -- which is exactly
 * what 3D text is bad at. Mutable and read from a rAF loop, so a drag moves a
 * number without re-rendering the scene to do it.
 */
export const rulerScreen = new Map<string, { x: number; y: number; on: boolean }>()

/** Which end of a ruler a press landed nearest, which is the end it takes. */
function nearestEnd(ruler: Ruler, point: Vector3): RulerEnd {
  const [a, b] = ruler.ends
  const da = point.distanceToSquared(new Vector3(a[0], a[1], a[2]))
  const db = point.distanceToSquared(new Vector3(b[0], b[1], b[2]))
  return db < da ? 1 : 0
}

/**
 * The stripe size for a ruler of this length, as a fraction of it.
 *
 * Exported because it is the whole of the rule, and `ui-check` can then state
 * that rule rather than transcribe one result of it: a stripe per centimetre
 * until there would be more than `MAX_STRIPES`, and evenly spaced from then on.
 */
export function stripeFraction(length: number): number {
  const stripes = clamp(Math.round(length / STRIPE_PERIOD), 1, MAX_STRIPES)
  // Half a period: a dash and the gap after it together make one stripe pair.
  return 0.5 / stripes
}

/**
 * One ruler: the line, the tube that catches a press on it, and a marker at
 * each end.
 *
 * Everything that moves per frame is written through a ref rather than through
 * React. The markers hold one size on screen, so they are rescaled every frame
 * from the camera distance, and the readout's screen position is projected here
 * for the DOM layer to pick up -- neither is a reason to re-render a scene.
 */
function RulerBody({
  ruler,
  active,
}: {
  ruler: Ruler
  /** Which end holds the gizmo, or null when this ruler is not selected. */
  active: RulerEnd | null
}) {
  const markers = useRef<(Mesh | null)[]>([null, null])
  const knobGrabs = useRef<(Mesh | null)[]>([null, null])
  const tube = useRef<Mesh>(null)
  const [hovered, setHovered] = useState<RulerEnd | null>(null)
  const selectRuler = useTools((s) => s.selectRuler)
  const scene = useSceneColors()

  const [a, b] = ruler.ends
  const from = new Vector3(a[0], a[1], a[2])
  const to = new Vector3(b[0], b[1], b[2])
  const span = to.clone().sub(from)
  const length = span.length()

  useFrame(({ camera, size }) => {
    // One reading per ruler, taken at its middle. The two ends are usually
    // within a few centimetres of each other, and markers at visibly different
    // sizes on one short line read as a perspective cue rather than as two
    // things that are the same size.
    const middle = from.clone().add(to).multiplyScalar(0.5)
    const scale = clamp(
      camera.position.distanceTo(middle) * SCALE_PER_UNIT,
      SCALE_MIN,
      SCALE_MAX
    )
    for (const mesh of markers.current) mesh?.scale.setScalar(scale)
    for (const mesh of knobGrabs.current) mesh?.scale.setScalar(scale)
    // Only the two cross-section axes: the tube's LENGTH is the ruler's, and
    // the group it sits in already sets that.
    if (tube.current) {
      tube.current.scale.x = scale
      tube.current.scale.z = scale
    }

    // Projected here, where the camera is, and read by the DOM chip outside the
    // canvas. `z > 1` is the ruler behind the viewer, where the projection wraps
    // round and would otherwise plant the number on the wrong side of the
    // screen. `project` writes in place, so this consumes the vector.
    const ndc = middle.project(camera)
    let slot = rulerScreen.get(ruler.id)
    if (!slot) {
      slot = { x: 0, y: 0, on: false }
      rulerScreen.set(ruler.id, slot)
    }
    slot.on = ndc.z <= 1
    slot.x = ((ndc.x + 1) / 2) * size.width
    slot.y = ((1 - ndc.y) / 2) * size.height
  })

  // A ruler dragged onto itself has no direction to be turned onto, and a
  // quaternion built from a zero vector comes out NaN -- which takes the whole
  // group off screen rather than merely drawing nothing.
  if (length < 1e-9) return null

  const quaternion = new Quaternion().setFromUnitVectors(
    SEGMENT_AXIS,
    span.clone().divideScalar(length)
  )
  const dash = stripeFraction(length)

  // The end nearest the press takes the gizmo, whether the press landed on the
  // line or on the knob at that end. One rule for both, so swapping ends is
  // "press the other end" rather than "find the right handle".
  const press = (e: ThreeEvent<PointerEvent>, end: RulerEnd) => {
    // The right button pans the camera everywhere else in the viewport, and a
    // ruler lying across the scene must not be a hole in that.
    if (e.button !== 0) return
    e.stopPropagation()
    selectRuler({ id: ruler.id, end })
  }

  return (
    <>
      <group position={from} quaternion={quaternion} scale={[1, length, 1]}>
        {/* Selected: a dark band with yellow marks along it. TWO lines rather
            than one striped material, because a line material carries one
            colour and its dash pattern shows whatever is BEHIND the gaps --
            which over this scene's background is nothing at all. The band
            underneath is what makes the gaps read as black stripes rather than
            as holes. */}
        {active !== null && (
          <Line
            points={SEGMENT}
            color={scene.rulerStripe}
            lineWidth={SELECTED_WIDTH}
            transparent
            depthTest={false}
            depthWrite={false}
            renderOrder={DRAW_OVER_SCENE}
            raycast={noRaycast}
          />
        )}

        <Line
          points={SEGMENT}
          color={scene.ruler}
          lineWidth={active !== null ? SELECTED_WIDTH : IDLE_WIDTH}
          dashed={active !== null}
          dashSize={dash}
          gapSize={dash}
          transparent
          depthTest={false}
          depthWrite={false}
          renderOrder={DRAW_OVER_SCENE + 1}
          raycast={noRaycast}
        />

        {/* What actually catches a press. A unit cylinder, so the group's own
            stretch gives it the ruler's length and only its cross-section has
            to be rescaled per frame to hold a constant width on screen. */}
        <mesh
          ref={tube}
          position={[0, 0.5, 0]}
          raycast={rulerRaycast}
          onPointerDown={(e) => press(e, nearestEnd(ruler, e.point))}
        >
          <cylinderGeometry args={[LINE_GRAB, LINE_GRAB, 1, 6]} />
          <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
        </mesh>
      </group>

      {/* The ends, OUTSIDE the stretched group: it scales one axis and not the
          other two, so a sphere parented to it would be drawn as an egg on any
          ruler that is not exactly one unit long. */}
      {([0, 1] as const).map((end) => {
        const at = end === 0 ? from : to
        // The end holding the gizmo needs no handle of its own -- the arrows are
        // the handle, and they converge on this very point -- so it keeps the
        // small dot every ruler end wears. The other end is the one thing here
        // that IS aimed at, so it is drawn as something to press.
        const grabbable = active !== null && active !== end
        return (
          <group key={end} position={at}>
            <mesh
              ref={(mesh) => {
                markers.current[end] = mesh
              }}
              renderOrder={DRAW_OVER_SCENE + 2}
              raycast={noRaycast}
            >
              <sphereGeometry args={[grabbable ? KNOB_RADIUS : DOT_RADIUS, 12, 8]} />
              <meshBasicMaterial
                color={grabbable && hovered === end ? scene.rulerLit : scene.ruler}
                transparent
                depthTest={false}
                depthWrite={false}
                toneMapped={false}
              />
            </mesh>

            {/* Drawn fully transparent rather than hidden. Hiding a mesh does
                not unpick it -- neither three nor R3F consults `visible` when
                raycasting -- so an invisible knob would go on taking presses
                from the end that is supposed to have them. It is mounted only
                while it is wanted instead, which does. */}
            {grabbable && (
              <mesh
                ref={(mesh) => {
                  knobGrabs.current[end] = mesh
                }}
                raycast={rulerRaycast}
                onPointerDown={(e) => press(e, end)}
                onPointerOver={() => setHovered(end)}
                onPointerOut={() => setHovered(null)}
              >
                <sphereGeometry args={[KNOB_GRAB, 8, 6]} />
                <meshBasicMaterial
                  transparent
                  opacity={0}
                  depthTest={false}
                  depthWrite={false}
                />
              </mesh>
            )}
          </group>
        )
      })}
    </>
  )
}

/**
 * A shade smaller than the object gizmo, for the reason the sketch gizmo is: a
 * ruler end is a detail laid over the scene rather than the scene itself, and
 * arrows reaching as far as the ones that move a whole solid would say the two
 * gestures were the same size of act. Not smaller still -- these are the only
 * handles the tool has.
 */
const RULER_GIZMO_SCALE = 0.7

/**
 * Every ruler in the scene, and the gizmo on the one end that has it.
 *
 * The gizmo is the object gizmo with things taken away rather than a second one
 * written: no ring and no resize, because a ruler end is a POINT -- there is
 * nothing to scale and no frame to turn. What is left is three arrows and three
 * quads that move a point, which is the whole of what an end does. All of it is
 * `TransformGizmo`'s own props, so the ruler adds no case to it.
 *
 * It is also pinned to Move, which is the one thing it does NOT take from the
 * app-wide mode. Rotate and Scale have no handle to give a point, so following
 * along would leave a selected ruler wearing nothing at all for as long as
 * either tool was up -- and the quads, which put an end anywhere on a face in
 * one gesture, are worth more to a ruler than to anything else in the app.
 */
export function Rulers({
  controlsRef,
}: {
  controlsRef: RefObject<{ enabled: boolean } | null>
}) {
  const rulerActive = useTools((s) => s.rulerActive)
  const rulers = useTools((s) => s.rulers)
  const selectedRuler = useTools((s) => s.selectedRuler)
  const startRulerGizmo = useDoc((s) => s.startRulerGizmo)

  // Nothing on screen to project to, so nothing for the DOM chips to follow.
  // Cleared rather than left stale, or a ruler hidden mid-frame leaves its
  // number hanging over the scene.
  if (!rulerActive) {
    for (const slot of rulerScreen.values()) slot.on = false
    return null
  }

  const selected = rulers.find((r) => r.id === selectedRuler?.id) ?? null

  return (
    <>
      {rulers.map((ruler) => (
        <RulerBody
          key={ruler.id}
          ruler={ruler}
          active={ruler.id === selectedRuler?.id ? selectedRuler.end : null}
        />
      ))}

      {selected && selectedRuler && (
        <TransformGizmo
          position={selected.ends[selectedRuler.end]}
          ring={false}
          sizable={false}
          // Pinned to Move, whatever tool the island has up. An end is a POINT:
          // there is nothing about it to turn and nothing to make bigger, so
          // following the mode would leave a selected ruler wearing no gizmo at
          // all for as long as Rotate or Scale was chosen -- and the arrows are
          // the only way to place an end by hand.
          mode="move"
          size={RULER_GIZMO_SCALE}
          controlsRef={controlsRef}
          onGrab={(handle) => startRulerGizmo(selected.id, selectedRuler.end, handle)}
        />
      )}
    </>
  )
}

/**
 * The lengths, as text pinned to the middle of each ruler.
 *
 * A DOM node per ruler outside the canvas, positioned from what `RulerBody`
 * projected. The LIST comes from React, because rulers are added and deleted a
 * handful of times a session; everything that changes at the speed of a drag --
 * where the chip sits, and what it says -- is written straight into the node
 * from a rAF loop, which is the bargain the rotation readout already strikes
 * and for the same reason.
 */
export function RulerReadouts() {
  const rulerActive = useTools((s) => s.rulerActive)
  const rulers = useTools((s) => s.rulers)
  const selectedRuler = useTools((s) => s.selectedRuler)
  const chips = useRef(new Map<string, HTMLDivElement | null>())

  useEffect(() => {
    let frame = 0
    const shown = new Map<string, string>()
    const tick = () => {
      // Read imperatively for the reason the frame loop in Viewport is: this
      // runs sixty times a second over a store the loop is only reading.
      const { rulers: live, displayUnit } = useTools.getState()
      for (const ruler of live) {
        const node = chips.current.get(ruler.id)
        if (!node) continue
        const slot = rulerScreen.get(ruler.id)
        // Hidden through style rather than by unmounting: see above.
        node.style.display = slot?.on ? 'block' : 'none'
        if (!slot?.on) continue
        // Two translates: the projected pixel, then half the chip's own size
        // back, which is what centres a box of text whose width nobody knows
        // until it has been laid out.
        node.style.transform = `translate(${slot.x}px, ${slot.y}px) translate(-50%, -50%)`
        const text = formatLength(rulerLength(ruler), displayUnit)
        if (shown.get(ruler.id) !== text) {
          node.textContent = text
          shown.set(ruler.id, text)
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  if (!rulerActive) return null

  return (
    <>
      {rulers.map((ruler) => (
        <div
          key={ruler.id}
          className={`ruler-chip${ruler.id === selectedRuler?.id ? ' ruler-chip-on' : ''}`}
          ref={(node) => {
            if (node) chips.current.set(ruler.id, node)
            else chips.current.delete(ruler.id)
          }}
          // Placed by the loop above on its first frame, and hidden until then
          // -- otherwise every new ruler's number flashes in the top-left
          // corner before it lands where the ruler is.
          style={{ display: 'none' }}
        />
      ))}
    </>
  )
}
