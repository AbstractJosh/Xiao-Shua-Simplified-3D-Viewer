import { useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import { Color, DoubleSide, Euler, Group, Mesh, Quaternion, Vector3 } from 'three'
import type { Intersection, Object3D, Raycaster } from 'three'
import type { GizmoAxis, GizmoHandle } from '../store/docStore'
import type { Vec3 } from '../geometry/types'
import { AXIS_COLORS } from './axisColors'
import { rotationIndicator } from './rotationIndicator'
import { modifiers, planeHandles } from './modifiers'

/**
 * Three arrows and a ring, drawn at a point and turned into that point's own
 * frame.
 *
 * One component serves both the selected object and the cut plane because the
 * gesture is identical -- slide along an axis, resize along an axis, scale the
 * lot -- and only the thing on the other end differs. What the caller supplies
 * is where to draw it and what to do when a handle is grabbed; the gizmo itself
 * owns no state and knows nothing about documents or tools.
 *
 * WHICH FRAME the arrows stand in is the caller's to decide, and the callers
 * do not all agree, because the thing an arrow means differs:
 *
 *   - The cut plane passes NOTHING, for the reason a selected object does. Its
 *     arrows used to ride the blade's own tilt, so that local +Y was the
 *     normal -- but that put every nudge and every turn in a frame the last
 *     turn had just moved, and a blade is aimed at a scene measured in world
 *     X, Y and Z. The tilt still lives on the quad, which is the blade itself.
 *   - A sketch passes a quaternion built from the surface it lies on. Its
 *     arrows are U, V and the normal; there is nowhere else for them to be.
 *   - A selected object passes NOTHING, so the arrows stand in the world. Its
 *     arrows are directions to slide in and a ring to turn by, and those are
 *     worth more as a fixed reference than as a readout of the object's
 *     current angle -- axes that rode the object moved out from under the
 *     second half of every rotation gesture.
 *
 * The object's own frame has not stopped mattering; it has moved to where it
 * is actually needed. A right-drag still resizes one of the object's OWN
 * dimensions -- there is no such thing as a box that is wider along world X --
 * and Viewport's `nearestLocalAxis` maps the world arrow that was grabbed onto
 * the local dimension it most nearly runs along.
 */

/**
 * WHAT THE RING GIVES WAY TO. Three arrows move along one axis at a time, and
 * between them they can reach anywhere -- in two or three gestures. The move
 * people actually want is usually across a surface: slide this along the
 * ground, drop that down the face of a wall. That is one gesture in a plane and
 * two or three with arrows, and doing it with arrows means aiming at a
 * direction rather than at the place you are going.
 *
 * So Control swaps the ring for three quads, one per plane, and a drag on one
 * moves the target within it. The ring rather than a fourth handle standing
 * beside it because there is no room: a billboarded circle crosses all three
 * quads whatever the camera angle, so the two would spend every gesture taking
 * each other's presses. Behind a held key rather than always up for the same
 * reason -- the gizmo is small and already carries four handles, and the ring's
 * two gestures are not worth losing to make permanent room.
 */

const RING_COLOR = '#eceff4'

/** The turn that stands a +Y primitive up along each axis. Cylinders and cones
 *  are both built along +Y, so one Euler does for the shaft, the head and the
 *  hit volume alike. */
const AXIS_ROTATIONS: Vec3[] = [
  [0, 0, -Math.PI / 2],
  [0, 0, 0],
  [Math.PI / 2, 0, 0],
]

// Gizmo units: the whole thing is one unit long and then scaled to hold a
// roughly constant size on screen.
//
// Everything here is stouter than the arrow it draws used to be, because the
// gizmo now spans well under half the width it did: a shaft that reads fine at
// 170 pixels is a hairline at 70, so the proportions thicken as the whole
// shrinks rather than scaling with it.
const SHAFT_FROM = 0.17
const SHAFT_TO = 0.72
const SHAFT_RADIUS = 0.026
const HEAD_LENGTH = 0.28
const HEAD_RADIUS = 0.09
/** The invisible volume that actually catches the pointer, and the one number
 *  here that is about the hand rather than the eye. Far fatter than the arrow
 *  it wraps -- a 0.026-radius shaft is a three-pixel target -- and it grew when
 *  the gizmo shrank, so the thing stays as easy to grab as it was. */
const GRAB_RADIUS = 0.17

/**
 * The ring sits WELL inside the arrowheads and carries a thin hit band.
 *
 * At its first size it was a broad belt two thirds of the way out, straight
 * through the fattest part of the arrows' own grab volumes, and it took presses
 * meant for them. Pulling it in and thinning the band leaves the arrows a clear
 * run; where the two still cross -- unavoidable, since the ring is a circle
 * around three axes -- `ringRaycast` hands the tie to the arrow.
 */
const RING_RADIUS = 0.27
const RING_TUBE = 0.015
const GRAB_TUBE = 0.045

/**
 * The three plane handles: small quads standing in the corners between each
 * pair of arrows, which slide the target within that plane.
 *
 * They live in the ring's territory rather than out among the arrowheads, and
 * that is not an accident of layout -- they are the ring's understudy. Hold
 * Control and the ring gives way to these; let go and it comes back. The two
 * could not both be up at once anyway: a billboarded circle at radius 0.27
 * crosses all three quads whatever the camera angle, and one of the two would
 * be taking presses meant for the other from every direction.
 *
 * A square between 0.16 and 0.40 along each of its two axes, so its inner
 * corner clears the arrows' shafts and its outer one stops well short of the
 * heads. What that leaves overlapping is a sliver along each inner edge, inside
 * an arrow's own grab cylinder, and `planeRaycast` hands those to the arrow --
 * the same tie, broken the same way, as the ring's.
 */
const PLANE_FROM = 0.16
const PLANE_TO = 0.4
const PLANE_SIDE = PLANE_TO - PLANE_FROM
const PLANE_CENTRE = (PLANE_FROM + PLANE_TO) / 2

/**
 * The turn that stands a +Z-facing quad onto each plane, indexed by the axis
 * the plane is NORMAL to -- the companion to `AXIS_ROTATIONS` above, and chosen
 * the same way: each one puts the quad's own local +X and +Y onto the two
 * POSITIVE world axes the plane spans, so a quad drawn in its local first
 * quadrant lands in the world's.
 *
 * Which way the normal ends up pointing is not among the requirements. A plane
 * is drawn double-sided and a slide across it is the same slide from either
 * face, so the facing test below reads the normal through an absolute value and
 * two of these three happen to come out negative.
 */
export const PLANE_ROTATIONS: Vec3[] = [
  // Normal X: local X becomes world Z, local Y stays world Y.
  [0, -Math.PI / 2, 0],
  // Normal Y: local X stays world X, local Y becomes world Z.
  [Math.PI / 2, 0, 0],
  // Normal Z: already the world's own XY.
  [0, 0, 0],
]

/** The quad's outline, closed, in the local frame `PLANE_ROTATIONS` sets up.
 *  A module constant: drei's `Line` rebuilds its buffers whenever this changes
 *  identity, and nothing about a gizmo's own proportions ever does. */
const PLANE_BORDER = [
  new Vector3(PLANE_FROM, PLANE_FROM, 0),
  new Vector3(PLANE_TO, PLANE_FROM, 0),
  new Vector3(PLANE_TO, PLANE_TO, 0),
  new Vector3(PLANE_FROM, PLANE_TO, 0),
  new Vector3(PLANE_FROM, PLANE_FROM, 0),
]

/** Fill weights. Faint at rest, because three of these stand in the middle of
 *  the gizmo and a solid one would hide the very thing being moved; plainly
 *  lit under the pointer, because that is the only thing that says which of
 *  three overlapping quads a press is about to take. */
const PLANE_OPACITY = 0.22
const PLANE_HOVER_OPACITY = 0.46

/**
 * How square-on a plane has to be before it is worth offering.
 *
 * Seen edge-on a quad is a line: impossible to aim at, and a sliver that would
 * take presses meant for whatever is behind it. So a plane whose normal is
 * within about twelve degrees of perpendicular to the view stands down.
 *
 * Standing down is TWO things, not one. Hiding it stops it being drawn and
 * nothing else: neither three's raycaster nor R3F's event layer looks at
 * `visible`, so an invisible mesh with a handler on it goes on quietly winning
 * presses. Every handle that comes and goes here therefore also gates its own
 * handler, off the same flag that hid it.
 *
 * Looking straight down an axis this leaves exactly one plane up, which is the
 * right answer: from directly above, the ground is the only plane you can
 * meaningfully drag in.
 */
const PLANE_EDGE_ON = 0.2

/**
 * Apparent size. Scaled with camera distance so the gizmo holds roughly one
 * size on screen, clamped so it never swamps a small scene.
 *
 * At the opening camera this puts the whole gizmo at about three quarters of a
 * world unit -- comfortably inside a default 2-unit cube rather than reaching
 * past its corners, which is what the first pass did.
 *
 * The two clamps widened with `dimensions.ts`, at BOTH ends, because the
 * envelope grew at both: the floor fell tenfold with `MIN_DIMENSION`, so a
 * millimetre part does not get arrows a centimetre long, and the ceiling rose
 * with `MAX_SIZE`, so a five-metre part does not get a gizmo it swallows whole.
 * Both were already pinned at the old zoom limit rather than merely guarding
 * against it.
 */
const SCALE_PER_UNIT = 0.07
const SCALE_MIN = 0.014
const SCALE_MAX = 10

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/**
 * How far a hovered handle is lifted toward white.
 *
 * Subtle on purpose. The arrows are already fully saturated, so anything
 * stronger reads as a second colour rather than as the same handle lit up --
 * and the point of the highlight is only to answer "is the pointer on it", not
 * to draw the eye somewhere it was not already looking.
 */
const HOVER_LIFT = 0.4
const WHITE = new Color('#ffffff')

/** The hovered form of a handle colour, computed once per colour. */
const litCache = new Map<string, string>()
function lit(color: string): string {
  const cached = litCache.get(color)
  if (cached) return cached
  const value = `#${new Color(color).lerp(WHITE, HOVER_LIFT).getHexString()}`
  litCache.set(color, value)
  return value
}

/**
 * Drawn last, over everything.
 *
 * `renderOrder` does NOT propagate from a group to its children in three, so it
 * goes on every mesh rather than once on the root -- and the materials are
 * marked transparent even at full opacity, because that is what moves them into
 * the pass that runs after all the opaque geometry. Switching depth testing off
 * alone is not enough: an opaque gizmo still shares the opaque queue with the
 * solid, and whichever of the two happens to draw second wins the pixel.
 */
const DRAW_ON_TOP = 30

/**
 * The gizmo always wins the pointer, however deep inside a solid it sits.
 *
 * Without this the arrows are drawn on top -- they write no depth -- but lose
 * every click, because the event system sorts hits by distance and the gizmo
 * lives at the target's CENTRE, behind the front face of the very object it
 * belongs to. On a small solid the tips stick out and it half works, which is
 * the worst version: grabbable at the ends, dead in the middle, for no reason
 * the user can see. On anything larger than the gizmo it is dead everywhere.
 *
 * Scaling the reported distance rather than zeroing it keeps the gizmo's own
 * parts in their true order, so the ring and an arrow crossing it still resolve
 * to whichever is genuinely nearer.
 */
const PRIORITY_SCALE = 1e-6

/**
 * The ring's own, an order of magnitude weaker.
 *
 * Both still beat any real scene hit by a mile, but between themselves the
 * arrow always wins -- which is the whole point. A billboarded circle crosses
 * all three axes whatever the camera angle, so some overlap is unavoidable, and
 * the tie has to break the same way every time. It breaks toward the arrows:
 * they are the precise handles, and there is a lot more ring to grab elsewhere.
 */
const RING_PRIORITY_SCALE = 1e-5

/**
 * Exported for the ruler, which is drawn over the scene the way the gizmo is
 * and so has to win the pointer the same way. One definition of the trick
 * rather than a second copy of it a few files away; the constants that say HOW
 * strongly stay with each caller, since what they are ranking against differs.
 */
export function biasedRaycast(scale: number) {
  return function (this: Mesh, raycaster: Raycaster, intersects: Intersection[]): void {
    const own: Intersection[] = []
    Mesh.prototype.raycast.call(this, raycaster, own)
    for (const hit of own) {
      intersects.push({ ...hit, distance: hit.distance * scale })
    }
  }
}

const gizmoRaycast = biasedRaycast(PRIORITY_SCALE)
const ringRaycast = biasedRaycast(RING_PRIORITY_SCALE)
/** The planes take the ring's weight, because they take the ring's place: they
 *  beat any real scene hit and lose to an arrow, which is the same bargain and
 *  is wanted for the same reason -- the arrows are the precise handles, and
 *  there is plenty of quad to grab away from one. */
const planeRaycast = biasedRaycast(RING_PRIORITY_SCALE)

/**
 * Whether the plane handles are showing, which is also whether the ring is not.
 *
 * A plain function read from frame loops rather than React state, because the
 * key it answers to is held rather than clicked: routing Control through a
 * store would re-render the whole scene twice for every press of it. The
 * gizmo's own loop and each quad's read the same rule, so the ring and the
 * planes cannot both believe they are up.
 *
 * `swaps` is false for a gizmo with no ring to give up -- the ruler's -- where
 * the planes are simply the only handle of their kind and stand permanently.
 *
 * Exported for `interaction-check`, which pins the rule itself: this is the
 * whole of what Control does to the gizmo, and it is not otherwise reachable
 * without a camera and a pointer.
 */
export function planesUp(swaps: boolean): boolean {
  if (!swaps) return true
  // The latch is what keeps a gesture from losing its own handle when a finger
  // comes off the key part-way through the drag.
  return modifiers.ctrl || planeHandles.held
}

/** The drawn parts are decoration; the grab volumes below are what is aimed at.
 *  Leaving these pickable would let a two-pixel shaft steal a click from the
 *  fat cylinder wrapped around it. */
const noRaycast: Object3D['raycast'] = () => {}

function Arrow({
  axis,
  color,
  sizable,
  sizeOnly,
  onGrab,
}: {
  axis: GizmoAxis
  color: string
  sizable: boolean
  /** This arrow has no slide, so both buttons resize along it. See the prop. */
  sizeOnly: boolean
  onGrab: (handle: GizmoHandle, e: ThreeEvent<PointerEvent>) => void
}) {
  const rotation = AXIS_ROTATIONS[axis]
  const shaftLength = SHAFT_TO - SHAFT_FROM
  const grabLength = 1 - SHAFT_FROM
  const [hovered, setHovered] = useState(false)
  const shown = hovered ? lit(color) : color

  const press = (e: ThreeEvent<PointerEvent>) => {
    // Left slides the target along this axis, right resizes it along the same
    // axis. Two gestures on one handle rather than two sets of arrows: the
    // second set would double the clutter for an operation that is, spatially,
    // exactly the same drag.
    //
    // A size-only arrow answers both buttons with the same gesture. It is not a
    // handle that ignores a button -- which reads as broken -- but one where
    // there is no second thing to do: nothing slides along it.
    if (e.button === 0) onGrab({ mode: sizeOnly ? 'size' : 'move', axis }, e)
    else if (e.button === 2 && (sizable || sizeOnly)) onGrab({ mode: 'size', axis }, e)
  }

  return (
    <group rotation={new Euler(...rotation)}>
      <mesh
        position={[0, SHAFT_FROM + shaftLength / 2, 0]}
        renderOrder={DRAW_ON_TOP}
        raycast={noRaycast}
      >
        <cylinderGeometry args={[SHAFT_RADIUS, SHAFT_RADIUS, shaftLength, 8]} />
        <meshBasicMaterial
          color={shown}
          transparent
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* A cone's apex is its +Y end, so it already points down the axis. */}
      <mesh
        position={[0, SHAFT_TO + HEAD_LENGTH / 2, 0]}
        renderOrder={DRAW_ON_TOP}
        raycast={noRaycast}
      >
        <coneGeometry args={[HEAD_RADIUS, HEAD_LENGTH, 14]} />
        <meshBasicMaterial
          color={shown}
          transparent
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* The hit volume. `visible={false}` would take it out of raycasting
          along with the drawing, so it is drawn fully transparent instead. */}
      {/* Hover is tracked on the grab volume rather than on what is drawn,
          because the drawn parts are deliberately not pickable -- the same
          reason presses come from here. */}
      <mesh
        position={[0, SHAFT_FROM + grabLength / 2, 0]}
        raycast={gizmoRaycast}
        onPointerDown={press}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
        onContextMenu={(e) => e.nativeEvent.preventDefault()}
      >
        <cylinderGeometry args={[GRAB_RADIUS, GRAB_RADIUS, grabLength, 8]} />
        <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  )
}

/**
 * One plane handle: a translucent quad with a drawn edge, in the colour of the
 * axis it is normal to.
 *
 * Coloured by the normal rather than by the pair it spans, which is the CAD
 * convention and the honest one: the normal is the single direction the drag
 * will NOT move you in, so a red quad and a red arrow are two ways of saying
 * "X", one along it and one across it.
 *
 * It owns its own frame loop rather than being told when to show itself. What
 * it has to answer -- is Control down, and is this plane square-on enough to
 * aim at -- are both things that change without any prop changing, so a parent
 * pushing the answer down would have to re-render three quads on every frame of
 * an orbit.
 */
function PlaneHandle({
  axis,
  color,
  swaps,
  onGrab,
}: {
  /** The axis this plane is NORMAL to. See `PLANE_ROTATIONS`. */
  axis: GizmoAxis
  color: string
  /** Whether this gizmo has a ring for the planes to take the place of. */
  swaps: boolean
  onGrab: (handle: GizmoHandle, e: ThreeEvent<PointerEvent>) => void
}) {
  const root = useRef<Group>(null)
  const [hovered, setHovered] = useState(false)
  // Whether this quad is currently offered, read by its own handlers. A ref
  // rather than state because it is decided per frame from a held key and a
  // camera angle, neither of which is worth a render -- and because the press
  // that reads it arrives between renders anyway.
  const up = useRef(false)

  useFrame(({ camera }) => {
    const group = root.current
    if (!group) return
    // The quad's own +Z is its normal, which is exactly what
    // `PLANE_ROTATIONS` was chosen to arrange -- so the facing test is a
    // question the object can answer about itself, whatever frame the gizmo as
    // a whole is standing in.
    const normal = group.getWorldDirection(new Vector3())
    const facing = Math.abs(normal.dot(camera.getWorldDirection(new Vector3())))
    up.current = planesUp(swaps) && facing > PLANE_EDGE_ON && !rotationIndicator.active
    group.visible = up.current
    // A quad that went away under the pointer never gets its `pointerout`, so
    // the lift would stay on it and come back lit the next time it appeared.
    if (!up.current && hovered) setHovered(false)
  })

  return (
    <group ref={root} rotation={new Euler(...PLANE_ROTATIONS[axis])} visible={false}>
      {/* The fill IS the target: a quad is already a broad thing to aim at, so
          unlike the arrows and the ring it needs no invisible volume wrapped
          around it. */}
      <mesh
        position={[PLANE_CENTRE, PLANE_CENTRE, 0]}
        renderOrder={DRAW_ON_TOP}
        raycast={planeRaycast}
        onPointerDown={(e) => {
          // Hidden is not unpickable -- see `PLANE_EDGE_ON` -- so a quad that
          // is not being offered has to refuse the press itself. Refused by
          // returning rather than by stopping it, so it carries on to whatever
          // is genuinely under the pointer.
          if (!up.current) return
          // Left only. The right button turns and resizes everywhere else on
          // this gizmo, and a plane has neither -- so it is left to the camera
          // rather than answered with a third meaning.
          if (e.button === 0) onGrab({ mode: 'plane', axis }, e)
        }}
        onPointerOver={() => up.current && setHovered(true)}
        onPointerOut={() => setHovered(false)}
        onContextMenu={(e) => e.nativeEvent.preventDefault()}
      >
        <planeGeometry args={[PLANE_SIDE, PLANE_SIDE]} />
        <meshBasicMaterial
          color={hovered ? lit(color) : color}
          transparent
          opacity={hovered ? PLANE_HOVER_OPACITY : PLANE_OPACITY}
          side={DoubleSide}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* The edge, at full strength. A 22%-opacity square over a scene of warm
          grey is a smudge; the outline is what makes it read as a handle. */}
      <Line
        points={PLANE_BORDER}
        color={hovered ? lit(color) : color}
        lineWidth={1.5}
        transparent
        depthTest={false}
        depthWrite={false}
        renderOrder={DRAW_ON_TOP}
        raycast={noRaycast}
      />
    </group>
  )
}

export function TransformGizmo({
  position,
  rotation,
  quaternion,
  axes = [0, 1, 2],
  sizeOnlyAxes = [],
  colors = AXIS_COLORS,
  ring = true,
  planes = true,
  size = 1,
  sizable = true,
  controlsRef,
  onGrab,
}: {
  position: Vec3
  /** The target's frame as Euler XYZ. Ignored when `quaternion` is given. */
  rotation?: Vec3
  /**
   * The frame as a quaternion, for a basis that is not a document rotation --
   * a surface's tangent frame, which arrives as three vectors rather than three
   * angles and would have to be converted twice to go through `rotation`.
   */
  quaternion?: Quaternion
  /**
   * Which arrows to draw. A sketch gets all three, but its third is not a
   * direction to move in: see `sizeOnlyAxes`.
   */
  axes?: GizmoAxis[]
  /**
   * Arrows with no slide of their own, where BOTH buttons resize.
   *
   * The sketch gizmo's normal arrow is the case: a sketch cannot move off the
   * surface it is anchored to, so there is no slide along that direction -- but
   * how far it sweeps ALONG it is exactly a size, and it is the one number the
   * arrow was added to drag.
   */
  sizeOnlyAxes?: GizmoAxis[]
  colors?: readonly string[]
  ring?: boolean
  /**
   * Whether this gizmo offers the three plane handles at all.
   *
   * On everywhere the target is a free point or a free solid, which is every
   * caller but one. A SKETCH opts out: it is anchored to a surface and slides
   * in that surface's own u and v, so there is no such thing as moving it
   * through the world's XZ plane -- its two tangent arrows already are the two
   * directions it can go, and a quad spanning a world pair would be a handle
   * for a motion the document cannot express.
   *
   * Where there is a `ring`, the planes take its place while Control is held.
   * Where there is not -- the ruler's gizmo, whose end is a point with nothing
   * to scale or turn -- they are the only handle of their kind and stand
   * permanently, since there is nothing for them to be swapped with.
   */
  planes?: boolean
  /** Multiplier on the apparent size, for gizmos that annotate small things. */
  size?: number
  /**
   * Whether the arrows resize on a right-drag. False for the cut plane, which
   * has no per-axis extent to change -- its one dimension is the guide square,
   * and that belongs to the ring.
   */
  sizable?: boolean
  controlsRef: RefObject<{ enabled: boolean } | null>
  onGrab: (handle: GizmoHandle) => void
}) {
  const root = useRef<Group>(null)
  const arrows = useRef<Group>(null)
  const ringBand = useRef<Mesh>(null)
  const ringGrab = useRef<Mesh>(null)
  const [ringHovered, setRingHovered] = useState(false)
  /** Whether the planes have taken the ring's place this frame. See below. */
  const swapped = useRef(false)

  useFrame(({ camera }) => {
    const group = root.current
    if (!group) return
    // Same trick as the snap marker: hold roughly one size on screen, or the
    // gizmo is a speck at one end of the zoom range and a cage at the other.
    const distance = camera.position.distanceTo(group.getWorldPosition(new Vector3()))
    group.scale.setScalar(clamp(distance * SCALE_PER_UNIT, SCALE_MIN, SCALE_MAX) * size)
    // The ring is the one handle with no direction, so it is drawn facing the
    // viewer rather than lying in some plane the user then has to orbit to see.
    // Its hit volume is a sibling rather than a child -- a torus parented to a
    // torus would inherit the band's own tube scale -- so it is turned here too
    // rather than drifting off the ring it is meant to catch.
    if (ringBand.current) ringBand.current.quaternion.copy(camera.quaternion)
    if (ringGrab.current) ringGrab.current.quaternion.copy(camera.quaternion)

    // The arrows step aside for a turn. They point along the axes, and a turn
    // is the one gesture that moves those axes -- leaving them up would have
    // three arrows sweeping across the dial that is being read.
    if (arrows.current) arrows.current.visible = !rotationIndicator.active

    // And the ring steps aside for the planes, which is the whole of the swap:
    // the quads decide for themselves whether to appear, and this is the same
    // question asked the other way round, so the two cannot both be up.
    //
    // Hiding the torus is only half of standing down. Nothing in three or in
    // R3F's event layer consults `visible`, so an unseen grab torus would go on
    // winning presses aimed at the quad drawn over it -- and the two sit at
    // the same radius, so it would win a good share of them. The flag is kept
    // for the handler to read as well.
    swapped.current = planes && planesUp(true)
    if (ringBand.current) ringBand.current.visible = !swapped.current
    if (ringGrab.current) ringGrab.current.visible = !swapped.current
    if (swapped.current && ringHovered) setRingHovered(false)
  })

  const grab = (handle: GizmoHandle, e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    // Held for the length of the drag, so a finger coming off Control part-way
    // through does not take the quad out from under the gesture using it. The
    // viewport drops it when the gesture ends, which is the one place that sees
    // every gesture end.
    if (handle.mode === 'plane') planeHandles.held = true
    // OrbitControls listens on the canvas directly, so a React-level
    // stopPropagation never reaches it -- and on the right button it would
    // otherwise pan the camera through the whole gesture.
    if (controlsRef.current) controlsRef.current.enabled = false
    onGrab(handle)
  }

  return (
    // Drawn through everything: the gizmo sits at the target's centre, which
    // for any solid larger than the gizmo is inside it. Depth-tested, it would
    // simply never be seen.
    <group ref={root} position={position}>
      {/* One or the other: a quaternion basis wins where it is given, because
          the frame it came from was never a set of Euler angles. */}
      <group
        ref={arrows}
        rotation={quaternion ? undefined : new Euler(...(rotation ?? [0, 0, 0]))}
        quaternion={quaternion}
      >
        {axes.map((axis) => (
          <Arrow
            key={axis}
            axis={axis}
            color={colors[axis] ?? AXIS_COLORS[axis]}
            sizable={sizable}
            sizeOnly={sizeOnlyAxes.includes(axis)}
            onGrab={grab}
          />
        ))}
      </group>

      {/* In a frame of their own rather than inside `arrows`, although they
          share its rotation: the arrows are hidden wholesale during a turn and
          the quads answer a different question about when to show themselves.
          Same basis either way -- a plane is spanned by two of the very axes
          the arrows point along, so it can stand nowhere else. */}
      {planes && (
        <group
          rotation={quaternion ? undefined : new Euler(...(rotation ?? [0, 0, 0]))}
          quaternion={quaternion}
        >
          {axes.map((axis) => (
            <PlaneHandle
              key={axis}
              axis={axis}
              color={colors[axis] ?? AXIS_COLORS[axis]}
              swaps={ring}
              onGrab={grab}
            />
          ))}
        </group>
      )}

      {ring && (
      <mesh ref={ringBand} renderOrder={DRAW_ON_TOP} raycast={noRaycast}>
        <torusGeometry args={[RING_RADIUS, RING_TUBE, 8, 48]} />
        <meshBasicMaterial
          color={ringHovered ? lit(RING_COLOR) : RING_COLOR}
          transparent
          opacity={ringHovered ? 1 : 0.8}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      )}

      {ring && (
      <mesh
        ref={ringGrab}
        raycast={ringRaycast}
        onPointerDown={(e) => {
          // Stood down for the planes: refuse rather than stop, so the press
          // reaches the quad that has taken this ring's place.
          if (swapped.current) return
          // Left scales, right turns -- the same left/right split the arrows
          // use, so one rule covers the whole gizmo.
          if (e.button === 0) grab({ mode: 'size', axis: 'all' }, e)
          else if (e.button === 2) grab({ mode: 'rotate', axis: 'all' }, e)
        }}
        onPointerOver={() => !swapped.current && setRingHovered(true)}
        onPointerOut={() => setRingHovered(false)}
        onContextMenu={(e) => e.nativeEvent.preventDefault()}
      >
        <torusGeometry args={[RING_RADIUS, GRAB_TUBE, 6, 32]} />
        <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
      </mesh>
      )}
    </group>
  )
}
