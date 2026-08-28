import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import { Color, DoubleSide, Euler, Group, Mesh, Quaternion, Vector3 } from 'three'
import type { Intersection, Object3D, Raycaster } from 'three'
import type { GizmoAxis, GizmoHandle } from '../store/docStore'
import type { Vec3 } from '../geometry/types'
import { AXIS_COLORS } from './axisColors'
import { useTools } from '../store/toolStore'
import { useSceneColors } from './useSceneColors'
import type { TransformMode } from '../store/toolStore'

/**
 * Arrows, quads and rings, drawn at a point and turned into that point's own
 * frame.
 *
 * One component serves the selected object, a selected sketch, the cut plane
 * and a ruler's end, because the gestures are identical -- slide along an axis,
 * slide within a plane, turn about an axis, resize along one, scale the lot --
 * and only the thing on the other end differs. What the caller supplies is
 * where to draw it, which of those gestures its target actually has, and what
 * to do when a handle is grabbed.
 *
 * WHICH of them is on screen is the app-wide `transformMode`, read here rather
 * than passed down, so that choosing a tool changes every gizmo at once and no
 * caller can forget to pass it on. That is the one piece of state this
 * component knows about; everything else about it is props.
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
 *   - A selected object passes its own rotation IN SCALE and nothing in the
 *     other two, so its arrows ride it while they resize and stand in the world
 *     while they move. That split is `local` on `GizmoParts`, and the reasoning
 *     is under it.
 */

/**
 * WHAT EACH MODE PUTS ON SCREEN, and the reasoning that decided it.
 *
 * The gizmo used to carry every gesture at once: arrows that slid on the left
 * button and resized on the right, a ring that scaled on the left and turned on
 * the right, and three plane quads that came out only while Control was held,
 * because a billboarded circle crosses all three quads whatever the camera
 * angle and the two would have spent every gesture taking each other's presses.
 * Six gestures on four handles, two of them behind a mouse button nothing else
 * in the app uses and one behind a key.
 *
 * The modes unpick that. Each one draws the handles for ONE job, so every
 * handle has exactly one gesture and the left button is the only button:
 *
 *   move    the three arrows and all three plane quads, permanently -- the
 *           quads no longer wait behind Control, because the ring they used to
 *           fight for space with is not drawn in this mode at all.
 *   rotate  three rings, one per world plane, each turning about the axis it is
 *           normal to. No arrows: they point along the axes, and a turn is the
 *           one gesture that moves those axes, so they would sweep across the
 *           dial being read.
 *   scale   the ring, which scales every dimension at once, and the arrows
 *           again -- here each one resizes the dimension it points along, which
 *           is what the right button used to do. These arrows stand in the
 *           OBJECT's frame rather than the world's; see `local`.
 *
 * A gizmo shows a handle only where its target actually has that gesture: the
 * cut plane has no per-axis extent, so Scale gives it the ring alone, and a
 * ruler's end is a point, so it stays on Move whatever the mode says.
 */

/**
 * Which handles a mode calls for, before any one gizmo narrows it down.
 *
 * Pure, and exported, because this is the whole of what choosing a tool does to
 * the viewport and there is otherwise no way to state it without a camera, a
 * pointer and three React trees. What each gizmo then does with the answer
 * depends on what its target can be asked to do -- see the props.
 */
export type GizmoParts = {
  /** The axis arrows stand. */
  arrows: boolean
  /** And a left-drag on one SLIDES rather than resizes. */
  slide: boolean
  /** The three plane quads stand. */
  planes: boolean
  /** The three axis rings stand. */
  rings: boolean
  /** The one billboarded ring stands. */
  ring: boolean
  /**
   * The arrows stand in the TARGET's own frame rather than the world's, for a
   * target that has one to stand in.
   *
   * AN ARROW THAT RESIZES IS ALREADY LOCAL WHATEVER IT IS DRAWN ALONG. A solid's
   * dimensions are its own -- there is no such thing as a box that is wider
   * along world X -- so a Scale drag was always going to change one of the
   * object's three, and a world arrow could only be MATCHED to whichever of them
   * it most nearly ran along. That match was exact at right angles and a guess
   * everywhere else: a box standing at 45 degrees offered two arrows that both
   * pointed between two of its sides, and neither said which one it would grow.
   * Ridden to the object, an arrow points down the side it resizes, and the
   * question does not arise.
   *
   * MOVE AND ROTATE STAY IN THE WORLD, and it is the same decision in both: a
   * slide is expressible along any direction at all, and a turn is the one
   * gesture that MOVES the axes, so handles that rode the object would sweep out
   * from under the second half of every rotation. Both are worth more as a fixed
   * reference than as a readout of the object's current angle -- which is what a
   * Scale arrow, alone among them, has to be.
   *
   * Nothing is claimed here about the rings or the quads. The billboarded ring
   * faces the camera and has no frame to be in; the three rotate rings and the
   * plane quads are drawn in the world, and this is false in the modes that
   * carry them.
   */
  local: boolean
}

export function gizmoParts(mode: TransformMode): GizmoParts {
  switch (mode) {
    case 'move':
      return {
        arrows: true,
        slide: true,
        planes: true,
        rings: false,
        ring: false,
        local: false,
      }
    case 'rotate':
      return {
        arrows: false,
        slide: false,
        planes: false,
        rings: true,
        ring: false,
        local: false,
      }
    case 'scale':
      return {
        arrows: true,
        slide: false,
        planes: false,
        rings: false,
        ring: true,
        local: true,
      }
  }
}

/* The ring's colour is per theme and lives in `sceneColors` as `gizmoRing`. It
   is the widget that inverts hardest after the compass: the brightest thing in
   the scene on a dark theme, and one of the darkest on a light one, because what
   it has to do is stand off the ground rather than be any particular colour. */

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
 * The rotate ball: three rings, well OUTSIDE where the scale ring sits.
 *
 * It can be, because nothing else is drawn in this mode -- no arrows to cross,
 * no quads to overlap -- so the rings take the room the arrows would have had
 * and end up a target the width of the whole gizmo rather than a circle a
 * quarter of the way in. That matters more here than anywhere else on the
 * gizmo: a ring seen near edge-on is a line a few pixels tall, and the bigger
 * the circle the longer the stretch of it that is still square-on to the
 * pointer.
 *
 * Stopping at 0.62 rather than 1 keeps the ball inside the dial the turn draws
 * (`RotationDial`, which lands at about nine tenths of this once both apparent
 * sizes are worked through), so the wedge reads as the ball's own fill rather
 * than as a disc thrown over the top of it.
 */
const BALL_RADIUS = 0.62
const BALL_TUBE = 0.02
/** Fatter than it looks, for the same reason the arrows' cylinders are: a
 *  0.02-tube ring is a two-pixel target at the size this is drawn at. */
const BALL_GRAB_TUBE = 0.07

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

/** The drawn parts are decoration; the grab volumes below are what is aimed at.
 *  Leaving these pickable would let a two-pixel shaft steal a click from the
 *  fat cylinder wrapped around it. */
const noRaycast: Object3D['raycast'] = () => {}

function Arrow({
  axis,
  color,
  sizeOnly,
  onGrab,
}: {
  axis: GizmoAxis
  color: string
  /**
   * This arrow does not slide: it resizes, on either button.
   *
   * Two things arrive here. In Scale mode EVERY arrow is one, which is the
   * mode. And in any mode, an arrow whose target has no slide along it is one
   * -- the sketch gizmo's normal arrow, which cannot leave the face it is
   * anchored to but can sweep along it. See `sizeOnlyAxes`.
   */
  sizeOnly: boolean
  onGrab: (handle: GizmoHandle, e: ThreeEvent<PointerEvent>) => void
}) {
  const rotation = AXIS_ROTATIONS[axis]
  const shaftLength = SHAFT_TO - SHAFT_FROM
  const grabLength = 1 - SHAFT_FROM
  const [hovered, setHovered] = useState(false)
  const shown = hovered ? lit(color) : color

  const press = (e: ThreeEvent<PointerEvent>) => {
    // LEFT does the one thing this arrow is for, which the mode has already
    // decided: slide along the axis in Move, resize along it in Scale.
    //
    // The right button used to carry the resize, on the same arrow, in every
    // mode there was -- one handle with two gestures on it, told apart by a
    // button nothing else in the app uses. Scale mode is where that gesture
    // lives now, so a right press here is left to the camera instead, which is
    // what it does everywhere else in the viewport.
    //
    // A size-only arrow still answers both, because there is no second thing
    // for the right button to mean on it and a handle that ignored a button
    // reads as broken.
    if (e.button === 0) onGrab({ mode: sizeOnly ? 'size' : 'move', axis }, e)
    else if (e.button === 2 && sizeOnly) onGrab({ mode: 'size', axis }, e)
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
 * it has to answer -- is this plane square-on enough to aim at -- changes with
 * the camera and with no prop at all, so a parent pushing the answer down would
 * have to re-render three quads on every frame of an orbit. WHETHER the quads
 * are offered in the first place is the mode's business, and the mode is a
 * render: this component is not built at all outside Move.
 */
function PlaneHandle({
  axis,
  color,
  onGrab,
}: {
  /** The axis this plane is NORMAL to. See `PLANE_ROTATIONS`. */
  axis: GizmoAxis
  color: string
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
    up.current = facing > PLANE_EDGE_ON
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
          // Left only, which is now the whole gizmo's rule: one handle, one
          // gesture, on the button everything else in the viewport uses.
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

/**
 * One of the rotate ball's three rings: a circle lying in a world plane, which
 * turns the target about the axis that plane is normal to.
 *
 * It stands in `PLANE_ROTATIONS` -- the same three Eulers the plane quads use,
 * and for the same reason. A quad and a ring in the same plane are the same
 * statement about which two axes are in play, so there is one table of turns
 * rather than two that have to be kept in step, and the colour follows the same
 * convention: named by the NORMAL, which for a ring is the axis it spins about.
 *
 * Drawn whole, front half and back. Hiding the far side is the usual CAD
 * flourish and it is not free -- the ring is drawn over everything, so there is
 * no depth test to hide anything with -- and it would take away the one thing
 * that makes a near-edge-on ring grabbable at all, which is the length of it
 * still crossing the pointer.
 */
function RotateRing({
  axis,
  color,
  onGrab,
}: {
  /** The axis this ring turns ABOUT, which its plane is normal to. */
  axis: GizmoAxis
  color: string
  onGrab: (handle: GizmoHandle, e: ThreeEvent<PointerEvent>) => void
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <group rotation={new Euler(...PLANE_ROTATIONS[axis])}>
      <mesh renderOrder={DRAW_ON_TOP} raycast={noRaycast}>
        <torusGeometry args={[BALL_RADIUS, BALL_TUBE, 8, 64]} />
        <meshBasicMaterial
          color={hovered ? lit(color) : color}
          transparent
          opacity={hovered ? 1 : 0.85}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* The hit volume, drawn transparent rather than hidden: `visible` takes
          a mesh out of the drawing and leaves it in the raycast. */}
      <mesh
        raycast={ringRaycast}
        onPointerDown={(e) => {
          // Left only. There is no second gesture on a ring any more -- that
          // was the old right-drag turn, and turning is now what the whole
          // mode is for -- so the right button is left to the camera.
          if (e.button === 0) onGrab({ mode: 'rotate', axis }, e)
        }}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
        onContextMenu={(e) => e.nativeEvent.preventDefault()}
      >
        <torusGeometry args={[BALL_RADIUS, BALL_GRAB_TUBE, 6, 40]} />
        <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
      </mesh>
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
  turns = ring ? 'axes' : false,
  planes = true,
  size = 1,
  sizable = true,
  mode,
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
  /**
   * Whether this gizmo has the billboarded ring, which is Scale's uniform
   * handle. Off for the ruler, whose end is a point: there is nothing about a
   * point to make bigger.
   */
  ring?: boolean
  /**
   * How this target turns, which decides what Rotate draws:
   *
   *   'axes'    three rings, one per world plane. For anything with a full
   *             orientation to set -- an object, the cut plane -- where the
   *             choice of axis is the first half of the gesture.
   *   'facing'  one billboarded ring, for a target with exactly ONE axis to
   *             turn about. A sketch is the case: it spins in the surface it
   *             lies on and nowhere else, so there is no axis to choose and a
   *             ball of three would offer two turns it cannot make.
   *   false     it does not turn at all. A ruler's end is a point.
   *
   * Defaulted off `ring` because the two say the same thing about a point:
   * nothing to scale, nothing to turn.
   */
  turns?: 'axes' | 'facing' | false
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
   * Where they are offered they stand permanently in Move -- there is nothing
   * left for them to be swapped with, since the ring that used to want their
   * room is drawn in another mode now.
   */
  planes?: boolean
  /** Multiplier on the apparent size, for gizmos that annotate small things. */
  size?: number
  /**
   * Whether the arrows can resize AT ALL, which is what decides whether Scale
   * draws them. False for the cut plane, which has no per-axis extent to
   * change -- its one dimension is the guide square, and that belongs to the
   * ring -- so Scale gives the plane the ring alone rather than three arrows
   * that would answer a press with nothing.
   */
  sizable?: boolean
  /**
   * Which mode this gizmo is in, overriding the one the tool island holds.
   *
   * Every gizmo follows the app-wide mode by default, which is the point of it.
   * The RULER pins itself to `move`: its end is a point, so Rotate and Scale
   * have no handle to give it, and following the mode would leave a selected
   * ruler wearing no gizmo at all for as long as another tool was up.
   */
  mode?: TransformMode
  controlsRef: RefObject<{ enabled: boolean } | null>
  onGrab: (handle: GizmoHandle) => void
}) {
  const root = useRef<Group>(null)
  const ringBand = useRef<Mesh>(null)
  const ringGrab = useRef<Mesh>(null)
  const [ringHovered, setRingHovered] = useState(false)
  const ringColor = useSceneColors().gizmoRing

  // The app-wide mode, unless this gizmo pins its own. Subscribed rather than
  // read, because a change of mode changes what is drawn -- which is the one
  // thing about this component that IS worth a render.
  const appMode = useTools((s) => s.transformMode)
  const parts = gizmoParts(mode ?? appMode)

  // Which arrows this mode actually offers. In Move, all of them. In Scale,
  // only those with a dimension behind them: an arrow whose target has nothing
  // to resize along it is a handle that answers a press with nothing, and the
  // cut plane's three are exactly that.
  const shownAxes = parts.slide
    ? axes
    : axes.filter((axis) => sizable || sizeOnlyAxes.includes(axis))

  // Whether the billboarded ring is up at all, in either of its two jobs.
  const ringUp = parts.ring || (parts.rings && turns === 'facing')

  // A ring that left the screen under the pointer -- because the tool changed
  // beneath it -- never gets its `pointerout`, so the lift would stay on and it
  // would come back lit the next time a mode called for it. The arrows, the
  // quads and the three rotate rings need no such thing: each is its own
  // component and its hover state dies with it.
  useEffect(() => {
    if (!ringUp) setRingHovered(false)
  }, [ringUp])

  useFrame(({ camera }) => {
    const group = root.current
    if (!group) return
    // Same trick as the snap marker: hold roughly one size on screen, or the
    // gizmo is a speck at one end of the zoom range and a cage at the other.
    const distance = camera.position.distanceTo(group.getWorldPosition(new Vector3()))
    group.scale.setScalar(clamp(distance * SCALE_PER_UNIT, SCALE_MIN, SCALE_MAX) * size)
    // The uniform ring is the one handle with no direction, so it is drawn
    // facing the viewer rather than lying in some plane the user then has to
    // orbit to see. Its hit volume is a sibling rather than a child -- a torus
    // parented to a torus would inherit the band's own tube scale -- so it is
    // turned here too rather than drifting off the ring it is meant to catch.
    //
    // The rotate ball's rings are the opposite case and are turned by nothing:
    // each one lies in a fixed world plane, because WHICH plane is the half of
    // the gesture the ring exists to state.
    if (ringBand.current) ringBand.current.quaternion.copy(camera.quaternion)
    if (ringGrab.current) ringGrab.current.quaternion.copy(camera.quaternion)
  })

  const grab = (handle: GizmoHandle, e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
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
      {parts.arrows && (
        <group
          rotation={quaternion ? undefined : new Euler(...(rotation ?? [0, 0, 0]))}
          quaternion={quaternion}
        >
          {shownAxes.map((axis) => (
            <Arrow
              key={axis}
              axis={axis}
              color={colors[axis] ?? AXIS_COLORS[axis]}
              // In Scale every arrow resizes; in Move only the ones with no
              // slide of their own do.
              sizeOnly={!parts.slide || sizeOnlyAxes.includes(axis)}
              onGrab={grab}
            />
          ))}
        </group>
      )}

      {/* In a frame of their own rather than inside the arrows' group,
          although they share its rotation: the two answer different questions
          about when to show themselves, and a quad hidden for being edge-on
          must not take an arrow with it. Same basis either way -- a plane is
          spanned by two of the very axes the arrows point along, so it can
          stand nowhere else. */}
      {planes && parts.planes && (
        <group
          rotation={quaternion ? undefined : new Euler(...(rotation ?? [0, 0, 0]))}
          quaternion={quaternion}
        >
          {axes.map((axis) => (
            <PlaneHandle
              key={axis}
              axis={axis}
              color={colors[axis] ?? AXIS_COLORS[axis]}
              onGrab={grab}
            />
          ))}
        </group>
      )}

      {/* The rotate ball. In the WORLD's own frame, not the target's: the
          rings are a fixed reference to turn against, and rings that rode the
          target would be carried off by the first half of every gesture --
          exactly the trouble the arrows were taken out of the object's frame
          to avoid. Both callers that ask for 'axes' draw their arrows in the
          world too, so the two agree by construction. */}
      {parts.rings &&
        turns === 'axes' &&
        ([0, 1, 2] as const).map((axis) => (
          <RotateRing
            key={axis}
            axis={axis}
            color={colors[axis] ?? AXIS_COLORS[axis]}
            onGrab={grab}
          />
        ))}

      {/* The single-axis case: one ring, facing the viewer, for a target whose
          axis is not a choice. Drawn by the same pair of meshes the uniform
          ring uses -- see below -- because the two are the same billboarded
          circle and differ only in what a press on them means. */}
      {ringUp && (
        <>
          <mesh ref={ringBand} renderOrder={DRAW_ON_TOP} raycast={noRaycast}>
            <torusGeometry args={[RING_RADIUS, RING_TUBE, 8, 48]} />
            <meshBasicMaterial
              color={ringHovered ? lit(ringColor) : ringColor}
              transparent
              opacity={ringHovered ? 1 : 0.8}
              depthTest={false}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>

          <mesh
            ref={ringGrab}
            raycast={ringRaycast}
            onPointerDown={(e) => {
              // Left only, and what it does is whichever of the two gestures
              // this ring is standing for. The right button used to turn from
              // here; Rotate is where that lives now.
              if (e.button !== 0) return
              grab(parts.ring ? { mode: 'size', axis: 'all' } : { mode: 'rotate', axis: 'all' }, e)
            }}
            onPointerOver={() => setRingHovered(true)}
            onPointerOut={() => setRingHovered(false)}
            onContextMenu={(e) => e.nativeEvent.preventDefault()}
          >
            <torusGeometry args={[RING_RADIUS, GRAB_TUBE, 6, 32]} />
            <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
          </mesh>
        </>
      )}
    </group>
  )
}
