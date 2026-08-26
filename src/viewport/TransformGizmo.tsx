import { useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { Color, Euler, Group, Mesh, Quaternion, Vector3 } from 'three'
import type { Intersection, Object3D, Raycaster } from 'three'
import type { GizmoAxis, GizmoHandle } from '../store/docStore'
import type { Vec3 } from '../geometry/types'
import { AXIS_COLORS } from './axisColors'
import { rotationIndicator } from './rotationIndicator'

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
 * WHICH FRAME the arrows stand in is the caller's to decide, and the three
 * callers do not agree, because the thing an arrow means differs:
 *
 *   - The cut plane passes its own rotation. Local +Y is the blade's normal,
 *     the one direction a blade wants to be nudged along, and an arrow that
 *     stopped tracking the tilt would stop pointing at it.
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
 * Apparent size. Scaled with camera distance so the gizmo holds roughly one
 * size on screen, clamped so it never swamps a small scene.
 *
 * At the opening camera this puts the whole gizmo at about three quarters of a
 * world unit -- comfortably inside a default 2-unit cube rather than reaching
 * past its corners, which is what the first pass did.
 */
const SCALE_PER_UNIT = 0.07
const SCALE_MIN = 0.14
const SCALE_MAX = 1.6

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

function biasedRaycast(scale: number) {
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

export function TransformGizmo({
  position,
  rotation,
  quaternion,
  axes = [0, 1, 2],
  sizeOnlyAxes = [],
  colors = AXIS_COLORS,
  ring = true,
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
          // Left scales, right turns -- the same left/right split the arrows
          // use, so one rule covers the whole gizmo.
          if (e.button === 0) grab({ mode: 'size', axis: 'all' }, e)
          else if (e.button === 2) grab({ mode: 'rotate', axis: 'all' }, e)
        }}
        onPointerOver={() => setRingHovered(true)}
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
