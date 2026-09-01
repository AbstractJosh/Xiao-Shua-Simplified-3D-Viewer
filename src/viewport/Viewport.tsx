import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Euler, MOUSE, Mesh, Quaternion, Raycaster, Vector2, Vector3 } from 'three'
import type { BufferAttribute, Camera, LineSegments, MeshBasicMaterial } from 'three'
import {
  MAX_FACE_OFFSET,
  resizeAlongAxis,
  resizeShapeAlong,
  scaleShape,
} from '../geometry/dimensions'
import { assemblyAnchor, assemblyHalfExtent } from '../geometry/assembly'
import type { SnapTarget } from '../geometry/snap'
import { snapSinglePoint } from '../geometry/snap'
import {
  hostSurfaceFor,
  maxShapeSize,
  samePatch,
  slideAnchor,
  surfaceFor,
} from '../geometry/surfaces'
import type { SurfaceDef } from '../geometry/surfaces'
import { endFaceFrame } from '../geometry/prism'
import { outlineAxis } from '../geometry/outline'
import { toLocalPoint, toLocalRay, toWorldDir, toWorldPoint } from '../geometry/transform'
import type { SceneObject, Shape2D, SurfaceAnchor, Vec3 } from '../geometry/types'
import { solidLabel } from '../geometry/types'
import type { Drag, GizmoAxis, GizmoHandle } from '../store/docStore'
import { selectedObjectId as primarySelection, useDoc } from '../store/docStore'
import { useLibrary } from '../store/libraryStore'
import {
  CUT_POSITION_LIMIT,
  CUT_SIZE_MAX,
  CUT_SIZE_MIN,
  DAB_SPACING,
  armedBrush,
  flyingHere,
  useTools,
} from '../store/toolStore'
import type { StrokeBrush, TransformMode } from '../store/toolStore'
import { CutPlaneGizmo } from './CutPlaneGizmo'
import { GameControls } from './GameControls'
import { FlightSpeedReadout } from './FlightSpeedReadout'
import { BrushScopePanel } from './BrushScopePanel'
import { brushAllows } from './brushTarget'
import { STAGE_CAMERA, STAGE_MAX_DISTANCE, STAGE_MIN_DISTANCE, Stage } from './Stage'
import { RulerReadouts, Rulers } from './Rulers'
import type { ObjectHit } from './picking'
import {
  clearPointerTrail,
  ndcIn,
  pickAnchorAcrossObjects,
  pickAnchorOnObject,
  pickGroundPoint,
  pickPlanePoint,
  pointerClient,
  pointerNdc,
  takePointerTrail,
} from './picking'
import { PerfHud, PerfProbe } from './PerfHud'
import { PERF_ON } from './perfProbe'
import { dropCacheFor, releaseDropCache } from './dropCache'
import { ObjectMenu, useObjectMenu } from './ObjectMenu'
import type { DropCache } from './dropCache'
import { PlacingSolidPreview } from './PlacingSolidPreview'
import { AxisCompass, CompassControl } from './AxisCompass'
import type { Orbit } from './AxisCompass'
import { SelectionHud } from './SelectionHud'
import { ToolIsland } from './ToolIsland'
import { RotationDial } from './RotationDial'
import { SceneObjects } from './SceneObjects'
import { useSceneColors } from './useSceneColors'
import { MarqueeControl, MarqueeRect } from './SelectionMarquee'
import { MARQUEE_SLOP, boxSpan, useMarquee } from './marquee'
import { PlacingPreview } from './SketchLayer'
import {
  advanceTurn,
  axisTarget,
  axisTravel,
  beginAxisDrag,
  beginPlaneDrag,
  nearestViewAxis,
  planeTarget,
  planeTravel,
  pointerAngle,
  snapTurn,
  turnedPosition,
  turnedRotation,
  WORLD_FRAME,
} from './gizmoDrag'
import type { AxisGrab, PlaneGrab, TurnGrab } from './gizmoDrag'
import { clearModifiers, modifiers } from './modifiers'
import { PLANE_ROTATIONS } from './TransformGizmo'
import { clearRotationIndicator, rotationIndicator } from './rotationIndicator'
import {
  resolveAxisMove,
  resolveObjectMove,
  resolvePoint,
  resolveSolidDrop,
  snapIndicator,
  snapTargets,
} from './snapping'

/**
 * The slice of OrbitControls this file touches: everything the compass needs,
 * plus the one thing only this screen does -- decide which gesture each mouse
 * button asks for.
 *
 * BUILT ON `Orbit` rather than written out again. The ref goes to
 * `CompassControl`, so the two descriptions have to agree; spelling the shared
 * fields twice is how they stop agreeing, which is the case `Orbit`'s own note
 * is about. Adding a field there now reaches here without anyone remembering to
 * come and add it.
 *
 * Structural rather than the real class, because the ref is handed to drei's
 * component, which is typed loosely enough that naming the class here would buy
 * nothing. `enabled` and the buttons are both written imperatively -- `enabled`
 * because a drag has to stop the camera synchronously, inside the press that
 * started it, and the buttons because which one orbits is decided per press.
 */
type Controls = (NonNullable<Orbit> & {
  mouseButtons: { LEFT: MOUSE | null; MIDDLE: MOUSE | null; RIGHT: MOUSE | null }
}) | null
type Store = ReturnType<typeof useDoc.getState>
type DragOf<K extends Drag['kind']> = Extract<Drag, { kind: K }>

/** Matches the Inspector's face-offset range; the drag must not out-run it.
 *  Both now read the one definition in `dimensions.ts`. */
const FACE_OFFSET_LIMIT = MAX_FACE_OFFSET


const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/**
 * Where the pointer sat relative to the thing it grabbed, so the first frame of
 * a drag moves nothing.
 *
 * Module-level for the same reason `modifiers` and `snapIndicator` are: this is
 * read from a frame loop, and a store round trip per gesture would re-render
 * the scene mid-drag. It is NOT a field on the store's `Drag` union because the
 * press handlers that would fill it in live in other components -- so the
 * offset is measured on the drag's FIRST FRAME, which is the earliest moment
 * this loop can see, instead of at pointer-down.
 *
 * Keyed by what is being dragged and cleared the moment the gesture is not the
 * one that measured it: a stale offset would teleport the NEXT drag of the same
 * object, which is the very bug this exists to remove.
 */
type ObjectGrab = { objectId: string; vertical: boolean; offset: Vec3 }
type FaceGrab = { objectId: string; featureId: string; u: number; v: number }

/**
 * Where a gizmo drag started, and what its target looked like then.
 *
 * The starting BASE is kept, not just the starting number, so every frame
 * computes the answer from the grab rather than adding to the last frame's.
 * Accumulating would drift, and worse: once a dimension clamps at its limit,
 * an accumulating drag keeps adding travel that the clamp swallows, so the
 * pointer has to come all the way back before the solid moves again.
 */
/**
 * A sketch slide's pinned start: the anchor it began on, and the axis line in
 * WORLD space that the pointer is read against.
 *
 * Held for the same reason the object gizmo's grab is -- an origin that moved
 * with the thing it was moving would oscillate -- and pinned to the ANCHOR too,
 * so every frame re-derives the slide from where the sketch started rather than
 * accumulating tangent offsets whose frame has since rotated out from under
 * them on a curved host.
 */
type SketchGrab = {
  key: string
  anchor: SurfaceAnchor
  /** Null for the ring, which has no axis to read. */
  axis: AxisGrab | null
  /** Distance from the sketch's centre at grab time, for the ring. */
  radius: number
  shape: Shape2D
  /**
   * The outline's spin at the grab.
   *
   * The two tangent arrows lie along the OUTLINE's own axes rather than the
   * surface's, so the world line the pointer is read against depends on this --
   * and pinning it is what stops a ring turn landing between two frames of an
   * arrow drag from swinging the line the drag is being measured on.
   */
  rotation: number
  /** The depth the normal arrow started from, for the same reason. */
  depth: number
}

let sketchGrab: SketchGrab | null = null

/** The turn in progress, pinned like every other gesture's start. */
let turnGrab: TurnGrab | null = null
let turnKey = ''

type GizmoGrab = {
  key: string
  /**
   * The arrow gesture's pinned origin and parameter. Null for a ring drag,
   * which has no axis. See gizmoDrag.ts for why this is ONE value rather than
   * an origin read fresh each frame plus a separately remembered position.
   */
  axis: AxisGrab | null
  /**
   * The same thing for a plane handle: where the target sat and where the
   * pointer met the plane, both pinned. Null for every gesture that is not a
   * plane drag, exactly as `axis` is null for every one that is not an arrow.
   */
  plane: PlaneGrab | null
  /** Distance from the gizmo centre at grab time, for the ring. */
  radius: number
  /**
   * The whole object as it stood at the grab, not just its base: a merged one
   * is scaled as an assembly, and every frame recomputes that from here rather
   * than from the result of the last frame.
   */
  object: SceneObject | null
  /**
   * Half the object's reach along the grabbed axis, pinned. A merged object has
   * no single width to write, so its arrows scale the whole thing by how far
   * the pointer pulls the skin relative to where that skin started.
   */
  half: number
  size: number
}

let objectGrab: ObjectGrab | null = null
let faceGrab: FaceGrab | null = null
let gizmoGrab: GizmoGrab | null = null

/** Drop them all, except the one belonging to the gesture currently running. */
function clearGrabs(kind: Drag['kind'] = 'idle'): void {
  if (kind !== 'moving-object') objectGrab = null
  if (kind !== 'moving-face') faceGrab = null
  if (kind !== 'gizmo' && kind !== 'cut-gizmo' && kind !== 'ruler-gizmo') gizmoGrab = null
  if (kind !== 'sketch-gizmo') {
    sketchGrab = null
    sketchTurnKey = ''
  }
  if (kind !== 'gizmo' && kind !== 'cut-gizmo' && kind !== 'sketch-gizmo') {
    turnGrab = null
    turnKey = ''
    clearRotationIndicator()
  }
}

/**
 * The offset between an object and the pointer, measured once per gesture.
 *
 * Shift can be pressed and released mid-drag, and the two branches measure
 * against different planes, so switching between them re-measures rather than
 * carrying a number that means nothing in the other frame.
 */
function objectGrabOffset(objectId: string, vertical: boolean, measured: Vec3): Vec3 {
  if (
    objectGrab === null ||
    objectGrab.objectId !== objectId ||
    objectGrab.vertical !== vertical
  ) {
    objectGrab = { objectId, vertical, offset: measured }
  }
  return objectGrab.offset
}

/**
 * Snap targets belonging to ONE object. A sketch slides across its own host and
 * must catch that host's corners and edges -- the inverse of what the shared
 * `snapTargets(exclude)` filter offers, which is built for the gestures that
 * seek the rest of the scene.
 */
function ownTargets(objectId: string, exceptFeature?: string): SnapTarget[] {
  return snapTargets().filter((t) => {
    if (t.objectId !== objectId) return false
    if (t.kind !== 'centre') return true
    // The solid's own middle is INSIDE it, and a sketch slides on the skin. On
    // a thin plate that middle comes within reach of the surface, wins the
    // snap, and then classifies as no anchor at all -- so the sketch would
    // quietly stop snapping exactly where the plate is thinnest. Its FACE
    // middles are on the skin and are the ones worth having.
    if (t.of === 'solid') return false
    // A sketch must not offer its own middle either: that is the one target
    // guaranteed to be in reach, so the drag would be pulled straight back to
    // where it started the moment it moved off it.
    if (t.of === 'sketch') return t.featureId !== exceptFeature
    return true
  })
}

/** Drop point for a solid dragged in, resting on the grid under the pointer. */
function dragPlacingSolid(s: Store, raycaster: Raycaster, drop: DropCache): void {
  const ground = pickGroundPoint(raycaster)
  if (!ground) {
    // Off the ground plane entirely: show the drop as invalid rather than
    // sticking to the last good spot, so releasing here reads as a cancel.
    s.updatePlacingSolid(null)
    return
  }
  // Sought by the would-be object's own corners, not by its centre: a centre
  // snap can only ever pull a solid INTO a neighbour, where corners are what
  // let it land flush against one. The lift is what rests it on the grid, and
  // the snapper stays free to take it back off if the scene offers something
  // better to meet.
  const [x, y, z] = resolveSolidDrop(drop.geometry, [ground.x, drop.lift, ground.z])
  s.updatePlacingSolid([x, y, z])
}

/** A sketch dragged in from the console may land on any object in the scene. */
function dragPlacingSketch(s: Store, raycaster: Raycaster, meshes: Map<string, Mesh>): void {
  const hit = pickAnchorAcrossObjects(raycaster, s.doc, meshes)
  if (hit) s.updatePlacing(hit.objectId, hit.anchor)
  else s.updatePlacing(null, null)
}

/**
 * A snapped anchor for the sketch slide, or null when snapping has nothing to
 * offer and the plain pick should stand.
 *
 * Snapping happens on the raycast SURFACE POINT rather than on the anchor,
 * because an anchor lives in the surface's own parameter space where a corner
 * of the solid is not a distinguished value.
 */
function snappedSketchAnchor(
  object: SceneObject,
  raycaster: Raycaster,
  featureId?: string
): SurfaceAnchor | null {
  const tools = useTools.getState()
  if (!tools.snap) return null

  // Only the analytic surface can turn a point back into an anchor, so a
  // pointer out past the primitive's silhouette -- over derived geometry --
  // simply does not snap, and the plain pick carries the drag.
  const surface = surfaceFor(object.base)
  const hit = surface.raycast(toLocalRay(object.transform, raycaster.ray))
  if (!hit) return null

  const snap = snapSinglePoint(
    toWorldPoint(object.transform, hit.point),
    ownTargets(object.id, featureId),
    tools.snapDistance
  )
  if (!snap) return null

  // A snapped point sits exactly ON a corner or an edge, where the surface
  // legitimately cannot say which patch owns it -- and `anchorFromHit` does not
  // report the ambiguity, it breaks the tie by axis order. So the raw hit, which
  // is under the pointer and on the face the user is working, is the authority
  // on WHICH patch, and the probe is only accepted once it agrees with it.
  const raw = hit.point
  const rawAnchor = surface.anchorFromHit(raw)
  if (!rawAnchor) return null

  const local = toLocalPoint(object.transform, snap.point)
  // Absolute steps, not a fraction of the gap: the gap between the snapped
  // point and the raw hit can be a fraction of a millimetre -- smaller than the
  // tolerance the classifier works to -- and a fraction of that leaves the probe
  // still sitting on the ambiguous edge. Each step here clears that tolerance,
  // and 2e-3 of an object unit is invisible where a flipped face is not.
  // `normalize` leaves a zero vector alone, so a snap that landed on the raw hit
  // simply probes the same point four times and takes it.
  const dir = raw.clone().sub(local).normalize()
  for (const eps of [0, 2e-3, 8e-3, 0.03]) {
    const anchor = surface.anchorFromHit(local.clone().addScaledVector(dir, eps))
    if (anchor && samePatch(anchor, rawAnchor)) {
      snapIndicator.hit = snap
      return anchor
    }
  }
  // Nothing agreed: the plain unsnapped pick carries the drag, which is a
  // sketch that does not quite catch rather than one that teleports.
  return null
}

/** Slide an existing sketch across the surface it is anchored to. */
function dragSketch(
  s: Store,
  drag: DragOf<'moving'>,
  raycaster: Raycaster,
  meshes: Map<string, Mesh>
): void {
  const object = s.doc.objects.find((o) => o.id === drag.objectId)
  const feature = object?.features.find((f) => f.id === drag.id)
  if (!object || !feature) return

  // This branch owns the indicator outright: nothing else writes it here, so a
  // frame that fails to snap has to clear last frame's marker itself.
  snapIndicator.hit = null
  const plain = pickAnchorOnObject(raycaster, object, meshes.get(object.id) ?? null)
  const anchor = snappedSketchAnchor(object, raycaster, drag.id) ?? plain
  if (anchor) s.moveTo(anchor)
}

/** Slide a whole object: across the ground, or up and down while Shift is held. */
function dragObject(
  s: Store,
  drag: DragOf<'moving-object'>,
  raycaster: Raycaster,
  camera: Camera
): void {
  const object = s.doc.objects.find((o) => o.id === drag.objectId)
  if (!object) return
  const [px, py, pz] = object.transform.position

  const vertical = modifiers.shift

  let desired: Vec3
  if (vertical) {
    // Vertical move: a plane through the object that faces the camera but stays
    // upright, so world Y runs across it at full scale. Flattening the camera
    // direction is what keeps a near-top-down view from mapping one pixel of
    // pointer travel onto metres of height.
    const normal = camera.getWorldDirection(new Vector3()).setY(0)
    if (normal.lengthSq() < 1e-6) return
    const p = pickPlanePoint(raycaster, new Vector3(px, py, pz), normal.normalize())
    if (!p) return
    // Only the Y component means anything on this plane; the object does not
    // move laterally here, so the other two would only be noise.
    const grab = objectGrabOffset(drag.objectId, true, [0, py - p.y, 0])
    desired = [px, p.y + grab[1], pz]
  } else {
    const ground = pickGroundPoint(raycaster)
    if (!ground) return
    // Offset by where the object sat under the pointer when the drag began, so
    // grabbing a corner does not first teleport the centre under the cursor.
    // Height is preserved, or an object lifted with Shift would drop back to
    // the grid the moment it was nudged sideways.
    const grab = objectGrabOffset(drag.objectId, false, [px - ground.x, 0, pz - ground.z])
    desired = [ground.x + grab[0], py, ground.z + grab[2]]
  }

  s.moveObjectTo(resolveObjectMove(object.id, desired))
}

/** Slide a feature's created end face within its own plane. */
function dragFace(s: Store, drag: DragOf<'moving-face'>, raycaster: Raycaster): void {
  const object = s.doc.objects.find((o) => o.id === drag.objectId)
  const feature = object?.features.find((f) => f.id === drag.id)
  if (!object || !feature) return

  const host = hostSurfaceFor(object.base, feature.anchor)
  const frame = endFaceFrame(host, feature.anchor, feature)
  if (!frame) return

  const hit = pickPlanePoint(
    raycaster,
    toWorldPoint(object.transform, frame.origin),
    toWorldDir(object.transform, frame.normal).normalize()
  )
  if (!hit) return

  // The face's own object is excluded: it is always the nearest thing to the
  // face, so a face left free to catch it would weld itself to the solid it
  // grows out of and never reach anything else. Reading the result as two
  // in-plane dot products drops whatever component of the catch left the plane,
  // which is what keeps an off-plane target usable instead of unreachable.
  // `frame.origin` already carries the current offset, so what the dot products
  // measure is the CHANGE the pointer is asking for -- hence the accumulation.
  const local = toLocalPoint(object.transform, resolvePoint(hit, object.id)).sub(frame.origin)
  const u = local.dot(frame.inU)
  const v = local.dot(frame.inV)

  // The first frame's reading IS the grab: the frame origin already carries the
  // current offset, so the increment measured then is exactly how far the press
  // landed from the face centre. Subtracting it every frame makes the first one
  // a no-op -- so a click on the face writes nothing -- and every later one move
  // the face by the pointer's OWN travel instead of centring it on the cursor.
  if (
    faceGrab === null ||
    faceGrab.objectId !== drag.objectId ||
    faceGrab.featureId !== drag.id
  ) {
    faceGrab = { objectId: drag.objectId, featureId: drag.id, u, v }
  }

  const [offU, offV] = feature.faceOffset
  s.moveFaceTo([
    clamp(offU + u - faceGrab.u, -FACE_OFFSET_LIMIT, FACE_OFFSET_LIMIT),
    clamp(offV + v - faceGrab.v, -FACE_OFFSET_LIMIT, FACE_OFFSET_LIMIT),
  ])
}

/** The gizmo's axis directions in world space, in the target's own frame. */
function axisWorld(rotation: Vec3, axis: GizmoAxis): Vector3 {
  const dir = new Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0)
  return toWorldDir({ position: [0, 0, 0], rotation }, dir).normalize()
}

/**
 * Start or reuse the grab for this gesture.
 *
 * `key` names the gesture down to the handle, so switching from the X arrow to
 * the Y arrow -- which a user cannot do without releasing, but a redrawn scene
 * can -- re-measures rather than reading last handle's number as this one's.
 *
 * `measure` is a thunk because starting a drag can fail -- an axis seen
 * end-on has no readable parameter -- and because on every frame after the
 * first it must not run at all: re-measuring is precisely the drift this
 * pinned grab exists to prevent.
 */
function gizmoGrabFor(
  key: string,
  measure: () => Omit<GizmoGrab, 'key'> | null
): GizmoGrab | null {
  if (gizmoGrab === null || gizmoGrab.key !== key) {
    const measured = measure()
    if (!measured) return null
    gizmoGrab = { key, ...measured }
  }
  return gizmoGrab
}

/**
 * Read this frame's turn, starting the gesture if it has not begun.
 *
 * Shared by all three ring turns, which differ only in what they write the
 * angle to. The pointer is met on the camera-facing plane through the gizmo --
 * the plane the ring itself is drawn in -- and its angle round that plane is
 * what the turn measures. Null while the ray cannot reach that plane.
 */
function readTurn(
  key: string,
  raycaster: Raycaster,
  camera: Camera,
  centre: Vector3,
  rotation: Vec3,
  /** The target's ORIGIN, which is `centre` for everything but a merged object. */
  position: Vec3,
  /**
   * The frame whose three axes the turn may snap to, which is NOT always the
   * rotation the target starts from.
   *
   * They part company wherever the gizmo is drawn in a frame the target does
   * not carry. The object gizmo is exactly that case: its arrows stand in the
   * world, so its ring turns about world X, Y or Z, while `rotation` remains
   * the object's own Euler because that is what the turn is composed onto.
   */
  axisFrame: Vec3 = rotation,
  /**
   * WHICH RING was taken hold of, where the gizmo drew three of them.
   *
   * It changes the plane the sweep is read in, and that is the whole of the
   * difference between the two kinds of ring:
   *
   *   A NAMED ring lies in a fixed world plane, so the angle is read in that
   *   plane's own basis. Where the pointer meets the plane IS where the hand is
   *   on the ring, so the target follows it exactly, and the axis is the ring's
   *   own normal rather than a guess from where the camera is standing. It also
   *   comes out right from either side: seen from behind, a drag that looks
   *   clockwise on screen turns the target clockwise on screen, because the
   *   measurement never mentions the camera.
   *
   *   A BILLBOARDED ring has no plane of its own, so the sweep is read in the
   *   camera's and snapped to whichever of `axisFrame`'s three axes best faces
   *   the viewer -- which is the only way to turn a twist of the screen into a
   *   rotation about something nameable.
   */
  about: GizmoAxis | null = null
): { grab: TurnGrab; total: number } | null {
  // The basis the angle is measured in, and the axis it therefore turns about.
  // `facing` is handed to the dial, which draws its wedge in this same plane.
  const facing = about === null
    ? camera.quaternion.clone()
    : new Quaternion().setFromEuler(new Euler(...PLANE_ROTATIONS[about], 'XYZ'))
  const right = new Vector3(1, 0, 0).applyQuaternion(facing)
  const up = new Vector3(0, 1, 0).applyQuaternion(facing)
  // The plane's own normal, which for a named ring is the axis of the turn.
  // Taken as right x up rather than as the world axis the ring is named after:
  // `PLANE_ROTATIONS` is chosen to put local X and Y on the two POSITIVE world
  // axes the plane spans, and two of the three come out with their local Z
  // facing the other way as a result. Deriving the axis from the basis the
  // angle is read in keeps the two in step whichever way that fell, so a
  // positive sweep is a positive turn about it every time.
  const normal =
    about === null
      ? camera.getWorldDirection(new Vector3())
      : right.clone().cross(up).normalize()

  // A ring seen near enough edge-on has no reliable meeting point with the
  // pointer -- the ray runs along its plane, so a pixel of pointer movement
  // slides the hit metres across it. The gesture holds where it is rather than
  // lurching; there is a great deal of ring left to grab elsewhere, and the
  // camera is one drag away. Only the named rings can get into this state: the
  // billboarded one faces the viewer by construction.
  if (about !== null && Math.abs(raycaster.ray.direction.dot(normal)) < RING_EDGE_ON) {
    return null
  }

  const hit = pickPlanePoint(raycaster, centre, normal)
  if (!hit) return null
  const angle = pointerAngle(hit, centre, right, up)

  if (turnGrab === null || turnKey !== key) {
    turnKey = key
    turnGrab = {
      // Chosen once, at the grab: an axis re-picked each frame would swap
      // mid-turn as the frame it is picked from rotated past 45 degrees, and
      // the target would visibly jump onto a different axis part-way through
      // one gesture. (For a world frame the axes hold still and only orbiting
      // could swap them, but the rule costs nothing and covers both cases.)
      // A named ring has nothing to choose: it IS the axis.
      axis: about === null ? nearestViewAxis(axisFrame, normal).axis : normal.clone(),
      rotation,
      position,
      lastAngle: angle,
      total: 0,
    }
    rotationIndicator.centre.copy(centre)
    rotationIndicator.facing.copy(facing)
    rotationIndicator.startAngle = angle
  }

  // Snapped on the way out, never on the way in. `advanceTurn` keeps the raw
  // sweep on the grab, and everything downstream -- the rotation written to the
  // document, the position carried round the pivot, the dial's own readout --
  // reads the snapped number returned here, so the object sits exactly where
  // the wedge says it does.
  const total = snapTurn(advanceTurn(turnGrab, angle))
  rotationIndicator.active = true
  rotationIndicator.angle = total
  return { grab: turnGrab, total }
}

/** The plane a ring drag measures its radius in: through the gizmo, facing the
 *  camera, which is the plane the ring is drawn in. */
function ringRadius(
  raycaster: Raycaster,
  camera: Camera,
  centre: Vector3
): number | null {
  const normal = camera.getWorldDirection(new Vector3())
  const hit = pickPlanePoint(raycaster, centre, normal)
  return hit ? hit.distanceTo(centre) : null
}

/**
 * How square-on a rotate ring has to be before its plane can be read.
 *
 * About three degrees: far enough from parallel that the meeting point is
 * stable, and shallow enough that all but the very last sliver of an edge-on
 * ring is still draggable. The plane quads stand down at a much wider angle
 * (`PLANE_EDGE_ON`), because a quad seen edge-on is an invisible sliver that
 * would go on taking presses -- a ring seen edge-on is a line you can plainly
 * see and deliberately aim at.
 */
const RING_EDGE_ON = 0.05

/**
 * The keys that pick a gizmo, and the whole of what they are.
 *
 * M, R and S are where every 3D application in the world puts these three, and
 * none of them was spoken for here -- the app's other shortcuts are all held
 * behind Control. Bare, therefore: a mode you reach for between every other
 * gesture is not worth a chord.
 *
 * M is the odd one, since Move is where the gizmo rests and the other two
 * already fall back to it. It earns its key anyway: that fallback is reached by
 * pressing the tool you are IN, so leaving Move nameless made it the one mode
 * you could not ask for -- from Rotate the way back was R, which is not the key
 * for the thing you want.
 *
 * M pressed while already in Move takes the handles OFF the object, the same
 * thing the lit Move button does -- so the key is a full toggle rather than a
 * no-op, and a gizmo standing over the surface you are brushing can be put down
 * without reaching for the island. See `pressTransformMode`, which is where
 * what a press means actually lives.
 */
export const MODE_KEYS: Record<string, TransformMode> = {
  m: 'move',
  r: 'rotate',
  s: 'scale',
}

/**
 * Slide or resize an object with its gizmo.
 *
 * Every gesture here is measured from the object's ASSEMBLY ANCHOR -- the centre
 * of the solids merged into it -- rather than from its host primitive's origin,
 * because that is where the gizmo is drawn and a gesture read from anywhere else
 * would not be the one the user grabbed. For an object with nothing merged into
 * it the anchor IS the origin, so none of this changes what a bare solid does.
 *
 * The anchor is recomputed each frame rather than pinned, and stays still while
 * it is used: a turn runs about it, and `scaleAssembly` translates the object so
 * a scale leaves it where it was. Only a MOVE carries it, which is the one
 * gesture whose measurement is already pinned to the grab's own origin.
 */
function dragGizmo(
  s: Store,
  drag: DragOf<'gizmo'>,
  raycaster: Raycaster,
  camera: Camera
): void {
  const object = s.doc.objects.find((o) => o.id === drag.objectId)
  if (!object) return

  const { rotation, position } = object.transform
  const anchor = assemblyAnchor(object)
  const centre = new Vector3(anchor[0], anchor[1], anchor[2])
  const key = `${drag.objectId}|${drag.handle.mode}|${drag.handle.axis}`

  if (drag.handle.mode === 'rotate') {
    // World axes, matching the arrows: the red ring turns about world X
    // whatever the object has since been turned to, so an object already at 30
    // degrees offers the same three rings as one straight out of the palette.
    // The ring that was grabbed IS the axis; `WORLD_FRAME` is what the fallback
    // would snap to if one ever arrived without one.
    const turn = readTurn(
      key,
      raycaster,
      camera,
      centre,
      rotation,
      position,
      WORLD_FRAME,
      drag.handle.axis === 'all' ? null : drag.handle.axis
    )
    if (!turn) return
    s.setObjectTransform(object.id, {
      // About the ring, not about the host's origin: a merged object has to spin
      // where the gizmo is, not orbit a point off to one side of it.
      position: turnedPosition(turn.grab, turn.total, anchor),
      rotation: turnedRotation(turn.grab, turn.total),
    })
    return
  }

  if (drag.handle.mode === 'plane') {
    // The plane the target slides in, pinned at the grab: a world axis for the
    // normal, and the anchor as it stood when the quad was taken hold of. Read
    // fresh from the live anchor each frame it would chase the very thing it is
    // moving -- the feedback loop gizmoDrag.ts opens with, in two dimensions
    // instead of one.
    const normal = axisWorld(WORLD_FRAME, drag.handle.axis)
    const grab = gizmoGrabFor(key, () => {
      const met = pickPlanePoint(raycaster, centre, normal)
      return (
        met && {
          axis: null,
          plane: beginPlaneDrag(met, anchor),
          radius: 0,
          object,
          half: 0,
          size: 0,
        }
      )
    })
    if (!grab?.plane || !grab.object) return

    const met = pickPlanePoint(raycaster, grab.plane.origin, normal)
    if (met === null) return
    const landed = planeTarget(grab.plane, planeTravel(grab.plane, met))
    const desired: Vec3 = [
      landed[0] - (anchor[0] - position[0]),
      landed[1] - (anchor[1] - position[1]),
      landed[2] - (anchor[2] - position[2]),
    ]

    // Snapped the way the BODY drag is, not the way an arrow is -- the free
    // corner seek, which may pull the solid a little out of the plane to meet
    // something. That is the same bargain dragging an object across the ground
    // already strikes, and for the same reason: a plane handle is aimed at a
    // PLACE rather than along a direction, so landing flush against a
    // neighbour is worth more than the plane held to the last micron. An arrow
    // is the opposite case and keeps `resolveAxisMove`, because there the one
    // coordinate is the whole of the promise.
    s.moveObjectTo(resolveObjectMove(object.id, desired))
    return
  }

  if (drag.handle.axis === 'all') {
    const radius = ringRadius(raycaster, camera, centre)
    if (radius === null) return
    const grab = gizmoGrabFor(key, () => ({
      axis: null,
      plane: null,
      radius,
      object,
      half: 0,
      size: 0,
    }))
    // A grab that landed on the exact centre has no radius to scale from, and
    // dividing by it would send the solid to infinity on the first frame.
    if (!grab || grab.radius < 1e-4 || !grab.object) return
    s.scaleObjectTo(grab.object, radius / grab.radius)
    return
  }

  // WHICH LINE THE POINTER IS MEASURED ALONG is whichever line the arrow was
  // drawn along, and the two modes draw them differently -- see `local` on
  // `GizmoParts`. A slide runs along a world axis; a resize runs along the
  // object's own, because the dimension it grows is the object's own.
  //
  // Read off the HANDLE rather than off the live mode. The handle is the
  // gesture's own record of what it was grabbed to do, so it cannot come to
  // disagree with the arrow the user actually has hold of -- where the mode is
  // a live reading that only stays put because the key handler refuses to
  // change it mid-drag, which is a guard in another file.
  const sizing = drag.handle.mode === 'size'
  const dir = axisWorld(sizing ? rotation : WORLD_FRAME, drag.handle.axis)
  // Which of the object's three dimensions that arrow grows. Now that the arrow
  // stands in the object's frame it IS the dimension -- the world arrow used to
  // be matched to whichever local axis it most nearly ran along, which was exact
  // at right angles and a guess at every angle in between.
  const sizeAxis = drag.handle.axis
  // `anchor` is read ONLY here, on the frame that starts the gesture. From then
  // on the grab's own origin is the axis, which is what keeps a still pointer
  // from walking the object back and forth -- see gizmoDrag.ts.
  const grab = gizmoGrabFor(key, () => {
    const axis = beginAxisDrag(raycaster.ray, anchor, dir)
    return (
      axis && {
        axis,
        plane: null,
        radius: 0,
        object,
        half: assemblyHalfExtent(object, sizeAxis),
        size: 0,
      }
    )
  })
  if (!grab?.axis || !grab.object) return

  const travel = axisTravel(grab.axis, raycaster.ray, dir)
  if (travel === null) return

  if (drag.handle.mode === 'size') {
    if (grab.object.parts.length === 0) {
      s.resizeObjectTo(resizeAlongAxis(grab.object.base, sizeAxis, travel))
      return
    }
    // A merged object cannot be resized along one axis: the parts are rotated
    // relative to each other and a `BaseSolid` carries no scale, so there is no
    // way to write the result down. The arrow still says how far, though, so it
    // scales the whole assembly by how far it pulled this axis's skin.
    if (grab.half < 1e-4) return
    s.scaleObjectTo(grab.object, (grab.half + travel) / grab.half)
    return
  }

  // The anchor is what the pointer is dragging, and the origin trails it by a
  // fixed offset -- fixed because a move leaves the rotation, and therefore the
  // whole assembly's shape, alone.
  const landed = axisTarget(grab.axis, dir, travel)
  const desired: Vec3 = [
    landed[0] - (anchor[0] - position[0]),
    landed[1] - (anchor[1] - position[1]),
    landed[2] - (anchor[2] - position[2]),
  ]

  // Snapped ALONG the axis only, so the arrow's whole promise -- that nothing
  // but this one coordinate changes -- survives the snap. The snapped result is
  // never fed back in: the next frame recomputes from the grab, so a catch
  // cannot drag the origin along with it.
  s.moveObjectTo(resolveAxisMove(object.id, desired, dir))
}

/**
 * Slide a sketch along one of its host surface's tangents.
 *
 * The gesture is the object gizmo's, read in a different space: the pointer is
 * measured against a straight world-space line, and the travel it yields is
 * then handed to the SURFACE, which decides where that lands on itself. On a
 * flat face those two are the same thing; on a sphere the tangent line leaves
 * the solid immediately and `slideAnchor` re-seats it, so the sketch follows
 * the curvature instead of flying off along the tangent.
 */
function dragSketchGizmo(
  s: Store,
  drag: DragOf<'sketch-gizmo'>,
  raycaster: Raycaster,
  camera: Camera
): void {
  const object = s.doc.objects.find((o) => o.id === drag.objectId)
  const feature = object?.features.find((f) => f.id === drag.id)
  if (!object || !feature) return

  const host = hostSurfaceFor(object.base, feature.anchor)
  const handle = drag.handle
  // A sketch's gizmo draws no plane quads -- see `planes` on TransformGizmo --
  // so this cannot arrive. Answered anyway rather than left to fall through
  // into the tangent branch below, which would read a plane's normal axis as
  // one of the outline's own directions and slide the sketch sideways.
  if (handle.mode === 'plane') return
  const key = `${drag.objectId}|${drag.id}|${handle.mode}|${handle.axis}`
  const centre = toWorldPoint(object.transform, host.frame(feature.anchor).origin)

  // A sketch turns about ONE axis -- the surface normal it lies against -- so
  // there is no axis to choose here, and `feature.rotation` is a single number
  // rather than an Euler triple. `readTurn` still measures it, because the
  // gesture and its dial are the same; only the axis it is told about differs,
  // and a sketch's is the one direction it has.
  if (handle.mode === 'rotate') {
    const normal = toWorldDir(object.transform, host.frame(feature.anchor).normal).normalize()
    const turn = readTurn(key, raycaster, camera, centre, [0, 0, 0], [
      centre.x,
      centre.y,
      centre.z,
    ])
    if (!turn) return
    // The measured sweep is in the CAMERA's plane; the sketch spins in its own.
    // Facing the normal away from the viewer flips which way round that is, so
    // the sign follows the normal rather than the outline turning backwards
    // whenever the face is seen from behind.
    const facing = camera.getWorldDirection(new Vector3()).dot(normal) > 0 ? -1 : 1
    s.rotateShapeTo(sketchGrabRotation(key, feature.rotation) + facing * turn.total)
    return
  }

  // Pinned on the first frame and never re-read: see SketchGrab.
  if (sketchGrab === null || sketchGrab.key !== key) {
    const pinned = {
      key,
      anchor: feature.anchor,
      shape: feature.shape,
      rotation: feature.rotation,
      depth: feature.depth,
    }
    if (handle.axis === 'all') {
      const radius = ringRadius(raycaster, camera, centre)
      if (radius === null) return
      sketchGrab = { ...pinned, axis: null, radius }
    } else {
      const dir = sketchAxisDir(object, host, feature.anchor, handle.axis, feature.rotation)
      const axis = beginAxisDrag(raycaster.ray, [centre.x, centre.y, centre.z], dir)
      if (!axis) return
      sketchGrab = { ...pinned, axis, radius: 0 }
    }
  }

  const grab = sketchGrab

  // The ring scales the outline in place -- it is the sketch's own size, not
  // its position, so nothing here touches the anchor.
  if (handle.axis === 'all' || !grab.axis) {
    const radius = ringRadius(raycaster, camera, centre)
    if (radius === null) return
    // A grab that landed on the exact centre has no radius to scale from, and
    // dividing by it would send the outline to infinity on the first frame.
    if (grab.radius < 1e-4) return
    s.resizeShapeTo(
      scaleShape(grab.shape, radius / grab.radius, maxShapeSize(object.base, grab.anchor))
    )
    return
  }

  const dir = sketchAxisDir(object, host, grab.anchor, handle.axis, grab.rotation)
  const travel = axisTravel(grab.axis, raycaster.ray, dir)
  if (travel === null) return

  // The third arrow. It is the only one whose drag changes what the SOLID is
  // rather than where the sketch sits on it: pull it away from the face and the
  // projection rises into a boss, push it back through and the same number goes
  // negative and sinks into a pocket. Zero on the way past is the flat
  // projection it started as, which is what makes the three one gesture.
  if (handle.axis === 2) {
    s.depthTo(grab.depth + travel)
    return
  }

  // Scale mode: stretch the outline along the arrow rather than sliding it.
  if (handle.mode === 'size') {
    s.resizeShapeTo(
      resizeShapeAlong(grab.shape, handle.axis, travel, maxShapeSize(object.base, grab.anchor))
    )
    return
  }

  // A slide is stored in the SURFACE's u and v, and the arrow points along the
  // OUTLINE's axes, so the travel is decomposed back onto the frame it is
  // written in. At rotation zero this is the identity and the two agree.
  const [au, av] = outlineAxis(handle.axis, grab.rotation)

  // Null means the slide has walked off the edge of its own patch. The sketch
  // holds its last position rather than wrapping onto the next face round the
  // corner -- which `clampAnchor`, inside `moveTo`, has usually pinned it short
  // of long before the raw point ever gets there.
  const next = slideAnchor(host, grab.anchor, travel * au, travel * av)
  if (next) s.moveTo(next)
}

/**
 * World direction of one of the sketch gizmo's three arrows.
 *
 * The tangent pair are the OUTLINE's axes -- the surface's u and v, spun by the
 * sketch's own rotation the same way `sampleOutline` spins the shape -- so an
 * arrow always lies along the edge of the thing it is about to stretch. The
 * third is the surface normal, which carries no spin: turning a sketch in its
 * own plane cannot tilt the face it lies on.
 */
function sketchAxisDir(
  object: SceneObject,
  host: SurfaceDef,
  anchor: SurfaceAnchor,
  axis: GizmoAxis,
  rotation: number
): Vector3 {
  const frame = host.frame(anchor)
  if (axis === 2) return toWorldDir(object.transform, frame.normal).normalize()

  const [au, av] = outlineAxis(axis, rotation)
  const local = frame.uDir.clone().multiplyScalar(au).addScaledVector(frame.vDir, av)
  return toWorldDir(object.transform, local).normalize()
}

/**
 * The sketch spin the current turn started from.
 *
 * A one-number equivalent of the pinned grabs above, and pinned for the same
 * reason: `rotateShapeTo` writes the value this is added to, so reading it live
 * would feed the result straight back into the measurement.
 */
let sketchTurnKey = ''
let sketchTurnStart = 0
function sketchGrabRotation(key: string, current: number): number {
  if (sketchTurnKey !== key) {
    sketchTurnKey = key
    sketchTurnStart = current
  }
  return sketchTurnStart
}

/** The same two gestures on the cut plane, which lives in the tool store. */
function dragCutGizmo(
  drag: DragOf<'cut-gizmo'>,
  raycaster: Raycaster,
  camera: Camera
): void {
  const tools = useTools.getState()
  const plane = tools.cutPlane
  const centre = new Vector3(plane.position[0], plane.position[1], plane.position[2])
  const key = `cut|${drag.handle.mode}|${drag.handle.axis}`

  if (drag.handle.mode === 'rotate') {
    // The plane's rotation IS its tilt, so the ring drives the same three
    // numbers the Tilt rows do -- one axis at a time, which is exactly the
    // move a blade wants and the hardest one to dial in by typing.
    //
    // WHICH axis is the ring that was grabbed, and the three stand in the world
    // frame, matching the arrows: a blade already tilted 30 degrees offers the
    // same three rings as a flat one, rather than three that rode the turn
    // before it.
    const turn = readTurn(
      key,
      raycaster,
      camera,
      centre,
      plane.rotation,
      plane.position,
      WORLD_FRAME,
      drag.handle.axis === 'all' ? null : drag.handle.axis
    )
    if (!turn) return
    tools.setCutPlane({ rotation: turnedRotation(turn.grab, turn.total) })
    return
  }

  if (drag.handle.mode === 'plane') {
    const normal = axisWorld(WORLD_FRAME, drag.handle.axis)
    const grab = gizmoGrabFor(key, () => {
      const met = pickPlanePoint(raycaster, centre, normal)
      return (
        met && {
          axis: null,
          plane: beginPlaneDrag(met, plane.position),
          radius: 0,
          object: null,
          half: 0,
          size: plane.size,
        }
      )
    })
    if (!grab?.plane) return

    const met = pickPlanePoint(raycaster, grab.plane.origin, normal)
    if (met === null) return
    const [x, y, z] = planeTarget(grab.plane, planeTravel(grab.plane, met))
    // Unsnapped and clamped, exactly as the arrows are: a blade is not a solid
    // and has no corners to seek, but it must not be dragged out of the scene.
    tools.setCutPlane({
      position: [
        clamp(x, -CUT_POSITION_LIMIT, CUT_POSITION_LIMIT),
        clamp(y, -CUT_POSITION_LIMIT, CUT_POSITION_LIMIT),
        clamp(z, -CUT_POSITION_LIMIT, CUT_POSITION_LIMIT),
      ],
    })
    return
  }

  if (drag.handle.axis === 'all') {
    const radius = ringRadius(raycaster, camera, centre)
    if (radius === null) return
    const grab = gizmoGrabFor(key, () => ({
      axis: null,
      plane: null,
      radius,
      object: null,
      half: 0,
      size: plane.size,
    }))
    if (!grab || grab.radius < 1e-4) return
    // The ring scales the guide square, which is the plane's only dimension.
    tools.setCutPlane({
      size: clamp((grab.size * radius) / grab.radius, CUT_SIZE_MIN, CUT_SIZE_MAX),
    })
    return
  }

  // A WORLD axis, exactly as the object gizmo's arrows are. The blade's own
  // normal is no longer one of the three, which is the trade: a tilted plane
  // is nudged in the frame the scene is measured in rather than in one that
  // tilts out from under the arrow between one drag and the next.
  const dir = axisWorld(WORLD_FRAME, drag.handle.axis)
  // The plane drifts exactly the way an object does, and for the same reason:
  // it is the thing being moved, so its live position cannot also be the origin
  // the pointer is measured against.
  const grab = gizmoGrabFor(key, () => {
    const axis = beginAxisDrag(raycaster.ray, plane.position, dir)
    return axis && { axis, plane: null, radius: 0, object: null, half: 0, size: plane.size }
  })
  if (!grab?.axis) return

  const travel = axisTravel(grab.axis, raycaster.ray, dir)
  if (travel === null) return

  // The plane is not a solid and has no corners to seek, so this one is not
  // snapped -- but it is still clamped to the range the Position field used to
  // offer, so the blade cannot be dragged out of the scene and lost.
  const [x, y, z] = axisTarget(grab.axis, dir, travel)
  tools.setCutPlane({
    position: [
      clamp(x, -CUT_POSITION_LIMIT, CUT_POSITION_LIMIT),
      clamp(y, -CUT_POSITION_LIMIT, CUT_POSITION_LIMIT),
      clamp(z, -CUT_POSITION_LIMIT, CUT_POSITION_LIMIT),
    ],
  })
}

/**
 * Slide one end of a ruler along an axis.
 *
 * The shortest of the gizmo drags, because an end is a POINT: there is no
 * rotation to compose onto, no dimension to grow, and no assembly anchor to
 * measure from. What is left is the pinned axis grab every other arrow uses,
 * and then the one thing that makes the tool worth having -- the landing point
 * is offered to the snapper before it is written down.
 *
 * Snapped as a free POINT rather than along the axis, which is the one place
 * this parts company with the object gizmo. That gizmo snaps along the arrow
 * alone, so a slide keeps its promise that nothing but one coordinate changes;
 * here the promise worth keeping is the other one. A ruler is for saying how far
 * it is from THIS corner to THAT one, and an end that stopped a fraction of a
 * millimetre short of the corner -- because the corner was not on the line the
 * arrow ran along -- would measure the wrong thing while the marker claimed
 * contact. So the end goes where the corner is, and the arrow that carried it
 * there follows it.
 *
 * Nothing is excluded from the search: a ruler belongs to no object, so every
 * corner, edge and face in the scene is fair game.
 */
function dragRulerGizmo(drag: DragOf<'ruler-gizmo'>, raycaster: Raycaster): void {
  const tools = useTools.getState()
  const ruler = tools.rulers.find((r) => r.id === drag.rulerId)
  // The ring is not drawn on a ruler, so `all` cannot be grabbed -- but the
  // handle type carries it, and answering it with nothing is cheaper than a
  // second handle type that differs by one case.
  if (!ruler || drag.handle.axis === 'all') return

  const end = ruler.ends[drag.end]
  const key = `ruler|${drag.rulerId}|${drag.end}|${drag.handle.mode}|${drag.handle.axis}`

  // A ruler's gizmo has no ring, so its quads are not behind Control -- they
  // stand permanently, and they are the handle that puts an end somewhere
  // rather than merely somewhere along a line.
  if (drag.handle.mode === 'plane') {
    const normal = axisWorld(WORLD_FRAME, drag.handle.axis)
    const at = new Vector3(end[0], end[1], end[2])
    const grab = gizmoGrabFor(key, () => {
      const met = pickPlanePoint(raycaster, at, normal)
      return (
        met && {
          axis: null,
          plane: beginPlaneDrag(met, end),
          radius: 0,
          object: null,
          half: 0,
          size: 0,
        }
      )
    })
    if (!grab?.plane) return

    const met = pickPlanePoint(raycaster, grab.plane.origin, normal)
    if (met === null) return
    const landed = planeTarget(grab.plane, planeTravel(grab.plane, met))
    // The same free point snap the arrows use, and for the same reason: the
    // end goes where the corner is.
    const caught = resolvePoint(new Vector3(landed[0], landed[1], landed[2]))
    tools.setRulerEnd(drag.rulerId, drag.end, [caught.x, caught.y, caught.z])
    return
  }

  const dir = axisWorld(WORLD_FRAME, drag.handle.axis)

  // The end drifts exactly the way an object does, and for the same reason: it
  // is the thing being moved, so its live position cannot also be the origin
  // the pointer is measured against. See gizmoDrag.ts.
  const grab = gizmoGrabFor(key, () => {
    const axis = beginAxisDrag(raycaster.ray, end, dir)
    return axis && { axis, plane: null, radius: 0, object: null, half: 0, size: 0 }
  })
  if (!grab?.axis) return

  const travel = axisTravel(grab.axis, raycaster.ray, dir)
  if (travel === null) return

  const landed = axisTarget(grab.axis, dir, travel)
  const caught = resolvePoint(new Vector3(landed[0], landed[1], landed[2]))
  tools.setRulerEnd(drag.rulerId, drag.end, [caught.x, caught.y, caught.z])
}

/**
 * Where the last dab of the stroke in flight landed, in its object's own space,
 * and where on screen the pointer was when the last frame read it.
 *
 * The stroke's only memory, and the two halves answer the two questions a brush
 * asks between frames: how far the marks have got, and where the hand went to
 * get there.
 *
 * `lastDab` spaces the dabs out -- the pointer reports many times per brush
 * width, and laying a dab on every one of them would make how fast you drag the
 * thing that decides how deep the groove goes. See `DAB_SPACING`.
 *
 * `lastNdc` is where the FILL starts. It is the one number the pointer trail
 * cannot supply: the trail holds the samples since the last frame, and the
 * segment that has to be filled runs from where the previous frame left off to
 * the first of them.
 *
 * Module-level refs rather than drag state because they change several times a
 * second and never need to be rendered -- the same reason the gizmo grabs and
 * the snap indicator live out here. Dropped the instant the gesture is not a
 * stroke, so the next press starts by laying one down rather than measuring
 * against wherever the last stroke happened to end.
 */
let lastDab: Vector3 | null = null
let lastNdc: Vector2 | null = null

/**
 * Drop the stroke in flight.
 *
 * Called for every frame the gesture is not a stroke, which is where a stroke
 * ENDS -- there is no other moment that sees it. So the next press starts by
 * laying a dab down rather than measuring against wherever the last stroke
 * happened to finish, and the path goes with it: a trail kept across a camera
 * orbit would have the first frame of the next stroke fill in along wherever
 * the hand had been in between, and melt a line across it.
 */
export function forgetStroke(): void {
  lastDab = null
  pauseStroke()
}

/**
 * Keep the stroke, lose the path.
 *
 * For a pointer that has left the canvas mid-stroke -- out over the console, or
 * off the window. The gesture is still alive and the last dab still says where
 * the marks have got to, but where the hand went while it was away is the one
 * thing the app has no record of. Filling in from where it went out to wherever
 * it comes back would melt a line along a path nobody drew, so the return is
 * treated as what it is: a jump, and a single dab where it lands.
 */
export function pauseStroke(): void {
  lastNdc = null
  clearPointerTrail()
}

/** The scope question, asked of a hit. See `brushAllows` for the rule itself. */
function brushTarget(s: Store, hit: ObjectHit | null): string | null {
  if (!hit) return null
  const scope = useTools.getState().brushScope
  return brushAllows(s.doc, s.selectedObjectIds, scope, hit.objectId)
    ? hit.objectId
    : null
}

/**
 * The most dabs one frame of a stroke may lay.
 *
 * A ceiling on the CATCHING UP, not on the stroke. Filling a gap costs a
 * raycast and a dab per step, and the gap is however far the pointer got since
 * the last frame -- so a frame the browser lost to a collection, a window drag
 * or a laptop waking up hands this a jump of any size at all, and without a
 * limit the frame after a stall would try to melt a line across the whole scene
 * and stall in its turn.
 *
 * Set well above what a real flick produces. A pointer crossing the canvas in a
 * fifth of a second at 60 Hz moves about a sixth of the way per frame, which on
 * a brush sized to what it is aimed at is a handful of steps; thirty-two is the
 * runaway, not the fast hand.
 */
const MAX_FRAME_DABS = 32

/**
 * How near the last mark a filled-in dab may land before it is dropped as a
 * pile-up rather than a step.
 *
 * The fill aims for a dab every `DAB_SPACING`, so a step that lands much nearer
 * than that did not come from the arithmetic -- it came from the surface, which
 * is not the straight line the steps were measured along. Over a shoulder or
 * into a hollow two evenly spaced places on screen are not evenly spaced on the
 * object, and a dab on top of the one before it only deepens it.
 *
 * Just under one, rather than one, because the ordinary evenly-spaced step
 * lands at the spacing itself and must not be thrown away by a float's worth of
 * rounding.
 */
const DAB_CROWD = 0.9

/**
 * How many places along a path are tried, looking for the object, on the frame
 * neither end of the stroke was over it. See `dragErode`.
 */
const PATH_PROBES = 12

/**
 * Points a fixed fraction of a screen-space path apart, BY ARC LENGTH, starting
 * one stride in.
 *
 * Along the path rather than across it: the path is the samples the pointer
 * actually reported, so a flick that curved comes back curved and the dabs are
 * laid where the hand went, instead of on the chord between the two places two
 * frames happened to catch it. Straight-line interpolation is what turns a fast
 * circle into a polygon -- the same artefact as the beading, one level up.
 *
 * A STRIDE RATHER THAN AN EVEN DIVISION, and it is the difference between the
 * marks being a spacing apart and merely being evenly spread. A frame covers
 * whatever ground it covers, which is not a whole number of spacings; dividing
 * it evenly puts the dabs slightly closer together than the spacing every
 * frame, which is the drag-slowly-bite-harder bug the spacing exists to
 * prevent, arriving by the back door. So the steps are laid at the spacing and
 * the remainder is simply left: the next frame measures its own gap from the
 * last mark and takes the leftover up with it.
 */
function samplePath(path: Vector2[], stride: number, count: number): Vector2[] {
  const span: number[] = []
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const d = path[i].distanceTo(path[i - 1])
    span.push(d)
    total += d
  }

  const out: Vector2[] = []
  if (total <= 0) return out
  for (let n = 1; n <= count; n++) {
    let want = total * stride * n
    let i = 0
    while (i < span.length - 1 && want > span[i]) {
      want -= span[i]
      i++
    }
    out.push(path[i].clone().lerp(path[i + 1], span[i] > 0 ? Math.min(want / span[i], 1) : 1))
  }
  return out
}

/**
 * Hold the armed brush against whatever is under the pointer, and fill in
 * everything it passed over on the way.
 *
 * A STROKE IS A PATH, NOT A SAMPLE. This runs once a frame, and it used to lay
 * one dab wherever it found the pointer -- so how far apart the marks landed
 * was how far the pointer had travelled since the last frame, which is the
 * user's speed times the app's frame time. Drag slowly and the dabs overlapped
 * into the groove `DAB_SPACING` promises; flick, and they landed a diameter or
 * more apart and the tool drew a row of separate spherical dents with the
 * surface between them untouched. All of that is the sampling. The brush was
 * never discontinuous; the reading of the hand was.
 *
 * So the frame is handed the whole path -- `takePointerTrail`, which keeps the
 * samples the platform received between frames rather than only the newest --
 * and walks it, laying a dab every `DAB_SPACING` of the way. The stroke a user
 * gets is then the same stroke whichever speed they drew it at and whatever the
 * frame rate was, which is what the spacing was always meant to guarantee and
 * only ever guaranteed for a slow hand.
 *
 * IT WALKS THE SCREEN AND RAYCASTS EVERY STEP rather than interpolating between
 * the two ends in the object's own space, because the straight line between two
 * points ON a surface runs UNDER it. Anywhere curved, the chord dives into the
 * solid -- and a dab is a sphere about its centre, so one sunk below the
 * surface bites deeper than the one the user aimed and on a thin wall burns
 * through where nothing was pointed. Stepping across the screen and asking the
 * geometry where each step lands keeps every dab of the fill on the surface,
 * for the same reason the frame's own dab is put where the ray hits.
 *
 * How MANY steps comes from the object and not from the screen: the gap between
 * the last mark and this one, in the object's own units, over the spacing.
 * Pixels would make the fill depend on the zoom.
 *
 * The dabs land where the RAY HITS, which is the surface as it stands this
 * frame rather than the shape the object started as -- so the brush follows the
 * material as it moves, down under the torch and up under the sculpt tool, and
 * a stroke held in one place goes on working instead of being left hovering
 * over its own crater or buried under its own bead. Within a frame the mesh
 * does not change, so a fill is measured against the one surface the whole of
 * that frame's travel was aimed at.
 *
 * They are stored in the object's LOCAL space, like every other coordinate in
 * the document, so a groove survives the object being moved and turned
 * afterwards.
 *
 * A pointer that wanders off the object mid-stroke simply lays nothing down.
 * The gesture stays alive, because the alternative -- ending the stroke -- would
 * make a drag across a gap into two undo steps.
 */
export function dragErode(
  s: Store,
  drag: DragOf<'erode'>,
  raycaster: Raycaster,
  meshes: Map<string, Mesh>,
  camera: Camera,
  canvas: HTMLElement
): void {
  const object = s.doc.objects.find((o) => o.id === drag.objectId)
  if (!object) return
  // Whichever brush is up, and its own three numbers -- see `armedBrush`. The
  // direction the dab is written with is the DRAG's, not this one's, so a
  // stroke stays one kind of mark end to end.
  const brush = armedBrush(useTools.getState())
  if (!brush) return
  const spacing = brush.radius * DAB_SPACING

  /** Where a point on screen lands on the object being worked, if it does. */
  const landing = (ndc: Vector2): Vector3 | null => {
    raycaster.setFromCamera(ndc, camera)
    // Across every object, then filtered to the one the stroke started on.
    // Asking only about that object would let the brush reach through a solid
    // standing in front of it and melt the far one, which is not what the user
    // is looking at.
    const hit = pickAnchorAcrossObjects(raycaster, s.doc, meshes)
    if (!hit || hit.objectId !== drag.objectId) return null
    return toLocalPoint(object.transform, hit.point)
  }

  const lay = (at: Vector3): void => {
    lastDab = at.clone()
    s.erodeAt([at.x, at.y, at.z], brush.radius, brush.force, brush.smooth, brush.round)
  }

  /** A place on the object, put back on screen. */
  const onScreen = (at: Vector3): Vector2 => {
    const ndc = toWorldPoint(object.transform, at).project(camera)
    return new Vector2(ndc.x, ndc.y)
  }

  /**
   * How far apart, on screen, two dabs a spacing apart would look from a given
   * place on the object.
   *
   * Measured ACROSS the view -- the camera's own right, stepped by the spacing
   * -- so it is the size of a dab as the user sees it, at the depth the stroke
   * is working, under whatever zoom and perspective are in force. It is the one
   * way to step a path over ground the geometry says nothing about.
   */
  const screenSpacing = (from: Vector3): number => {
    const across = new Vector3()
      .setFromMatrixColumn(camera.matrixWorld, 0)
      .multiplyScalar(spacing)
    const world = toWorldPoint(object.transform, from)
    const here = world.clone().project(camera)
    const there = world.add(across).project(camera)
    return Math.hypot(here.x - there.x, here.y - there.y)
  }

  // The frame's path: where the stroke had got to, then every sample since.
  // Converted against one rect, because that is a layout read and there may be
  // a dozen of them.
  //
  // IT BEGINS AT THE LAST MARK rather than at the last frame's pointer, and the
  // two are not the same place: a frame lays its dabs at the spacing and stops,
  // which leaves the pointer a little past the last of them. Measuring the fill
  // from where the pointer got to would spend that remainder every frame, so a
  // hand moving slowly enough to leave one dab per frame would leave them a
  // little further apart than a hand moving quickly -- the beading again, small
  // enough to be a rate rather than a row of dents. Anchored at the mark, the
  // remainder is simply carried: the next frame measures its own gap from
  // there and takes it up.
  //
  // `lastNdc` is what says the path is CONTINUOUS -- see `pauseStroke`. Without
  // it the anchor would draw a line from the last mark to wherever the pointer
  // reappeared.
  const rect = canvas.getBoundingClientRect()
  const anchor = lastNdc && lastDab ? onScreen(lastDab) : lastNdc
  const path: Vector2[] = anchor ? [anchor.clone()] : []
  const trail = takePointerTrail()
  for (let i = 0; i < trail.length; i += 2) {
    const p = ndcIn(rect, trail[i], trail[i + 1])
    if (p) path.push(p)
  }
  // Where the pointer is now, for the frame no move event reached: a brush held
  // still still has to go on biting.
  const now = ndcIn(rect, pointerClient.x, pointerClient.y)
  const last = path[path.length - 1]
  if (now && !(last && now.equals(last))) path.push(now)

  const end = path[path.length - 1]
  if (!end) return
  lastNdc = end.clone()

  const target = landing(end)
  const previous = lastDab

  // Nothing to walk, only a place. The first frame of a stroke, or one that has
  // just come back from off the canvas with no record of where the hand went
  // while it was away -- see `pauseStroke`. One dab where the pointer is, if it
  // is on anything, which is what this did for every frame before the fill
  // existed.
  if (path.length < 2) {
    if (target && (!previous || previous.distanceTo(target) >= spacing)) lay(target)
    return
  }

  let travel = 0
  for (let i = 1; i < path.length; i++) travel += path[i].distanceTo(path[i - 1])
  if (travel <= 0) return

  // HOW FAR ALONG THE PATH ONE DAB IS, as a fraction of it.
  //
  // Ordinarily from the object: the gap between the last mark and where the
  // frame ended, in the object's own units, is exactly the ground to be
  // covered, and pixels would make the fill change with the zoom.
  //
  // A frame can end nowhere, though -- a flick that carried off the edge of the
  // object, or clean past a small one, so that NEITHER end of it is over
  // anything. That is not an edge case but the beading in its worst form: the
  // whole crossing happened between two frames, and a tool that reads only the
  // ends of it leaves the object untouched by a stroke drawn straight across
  // it. So the path is probed for somewhere it does touch and the spacing is
  // carried onto the SCREEN there: the same question asked of the projection
  // instead of the geometry.
  let stride: number
  if (target && previous) {
    const gap = previous.distanceTo(target)
    // A pointer that has not moved a dab's worth. The gate is the spacing
    // itself, and it is what keeps a slow drag from biting harder than a quick
    // one -- the same promise the fill keeps from the other end.
    if (gap < spacing) return
    stride = spacing / gap
  } else if (target) {
    // The stroke's first mark. There is nothing behind it to fill in from.
    return lay(target)
  } else {
    let from = previous
    // Stopped at the first place that touches, rather than mapped over the
    // whole set: each probe is a raycast against every object in the scene.
    for (let n = 1; !from && n <= PATH_PROBES; n++) {
      const [probe] = samplePath(path, n / (PATH_PROBES + 1), 1)
      if (probe) from = landing(probe)
    }
    if (!from) return
    const reach = screenSpacing(from)
    if (!(reach > 0)) return
    stride = reach / travel
  }

  for (const step of samplePath(path, stride, Math.min(Math.floor(1 / stride), MAX_FRAME_DABS))) {
    // Asked of the geometry per step rather than trusted from the count,
    // because the fill follows the SURFACE and the surface is not the straight
    // line the steps were measured along. A step can land nowhere at all, where
    // there is nothing to mark, or -- see `DAB_CROWD` -- on top of the mark
    // before it.
    const at = landing(step)
    if (!at || (lastDab && lastDab.distanceTo(at) < spacing * DAB_CROWD)) continue
    lay(at)
  }
}

/**
 * The armed brush, drawn where it would bite: a sphere the size of the tool.
 *
 * ITS COLOUR IS WHICH BRUSH IT IS, and two of the three are the app's existing
 * pair rather than a new one: red for material going away, which is what the
 * eraser ghost and the scope panel's tint already mean, and green for material
 * arriving, which is what a pushed-out face already means. A user does not have
 * to learn a second vocabulary to tell those two apart mid-stroke, and the
 * corner panel is tinted to match, so the two things on screen that say what is
 * armed say it the same way.
 *
 * THE SMOOTHER IS THE THIRD COLOUR, and it has to be a third rather than a
 * borrowed one: it neither takes material away nor puts any on, and wearing
 * either of those would be the ghost promising the wrong thing every time it
 * came up. It is a cool neutral -- see `round` in `sceneColors` -- which is the
 * one thing in this scene's vocabulary that says "changes the shape without
 * adding or subtracting", and it is deliberately not the accent, which already
 * means selected.
 *
 * All of them read from the theme rather than written out here, because the
 * scene has one set of colours per theme and a literal in a viewport component
 * is exactly the drift `sceneColors.ts` exists to stop.
 *
 * Translucent, and drawn through whatever is in front of it, so you can see how
 * far into the solid the sphere reaches rather than only the cap facing you:
 * how much of the surface it works is the thing the size control is actually
 * setting.
 *
 * IT GOES AWAY THE MOMENT THE STROKE STARTS. While a brush is being held
 * against something, the only thing worth looking at is the surface changing,
 * and a ball sitting on top of exactly the spot being worked hides it. The
 * pointer stays, which is all the aiming a gesture already in progress needs.
 *
 * It also goes away over anything the scope will not let the brush touch, so
 * "Selected only" is legible before a press rather than after one that did
 * nothing.
 */
function BrushGhost({ meshes }: { meshes: RefObject<Map<string, Mesh>> }) {
  const scene = useSceneColors()
  const tool = useTools((s) => s.brushTool)
  const erodeRadius = useTools((s) => s.erodeRadius)
  const sculptRadius = useTools((s) => s.sculptRadius)
  const smootherRadius = useTools((s) => s.smootherRadius)
  // Subscribed rather than taken from `armedBrush`, which builds a fresh object
  // per call and so can never settle as a selector. Each brush keeps its own
  // size -- see `sculptRadius` -- so all three are read and one is chosen.
  const radius =
    tool === 'sculpt' ? sculptRadius : tool === 'smoother' ? smootherRadius : erodeRadius
  const { camera, gl } = useThree()
  const raycaster = useMemo(() => new Raycaster(), [])
  const ghost = useRef<Mesh>(null)

  useFrame(() => {
    const mesh = ghost.current
    if (!mesh) return
    const s = useDoc.getState()
    if (!tool || s.drag.kind === 'erode') {
      mesh.visible = false
      return
    }
    const ndc = pointerNdc(gl.domElement)
    if (!ndc) {
      mesh.visible = false
      return
    }
    raycaster.setFromCamera(ndc, camera)
    const hit = pickAnchorAcrossObjects(raycaster, s.doc, meshes.current)
    const target = brushTarget(s, hit)
    mesh.visible = target !== null
    if (!hit || target === null) return
    mesh.position.copy(hit.point)
    mesh.scale.setScalar(radius)
  })

  return (
    <mesh ref={ghost} visible={false} renderOrder={19}>
      <sphereGeometry args={[1, 24, 16]} />
      <meshBasicMaterial
        color={tool === 'sculpt' ? scene.out : tool === 'smoother' ? scene.round : scene.in}
        transparent
        opacity={0.28}
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  )
}

/**
 * Drives all five drag gestures from a single per-frame raycast.
 *
 * Reads the store imperatively rather than by subscription: this runs every
 * frame during a drag, and re-subscribing on each document change would remount
 * the whole loop mid-gesture.
 */
function Interaction({ meshes }: { meshes: RefObject<Map<string, Mesh>> }) {
  const { camera, gl } = useThree()
  const raycaster = useMemo(() => new Raycaster(), [])
  // Solving a template's booleans and sampling its corners costs real work, and
  // the template never changes mid-gesture, so both are measured once -- into a
  // cache the ghost reads too, so the two cannot disagree about where the drop
  // is going. Freed rather than dropped, here and again if the canvas goes away
  // mid-drag: the geometry's GPU buffers outlive its wrapper.
  useEffect(() => releaseDropCache, [])

  useFrame(() => {
    const s = useDoc.getState()
    // Hoisted to a const so the narrowing below survives into the branches;
    // TypeScript discards it for a mutable property reference.
    const drag = s.drag
    // This loop is the only place that sees every gesture end, so it is where
    // the per-gesture caches are dropped -- before the early returns below,
    // which a released drag takes on its way out.
    clearGrabs(drag.kind)
    if (drag.kind !== 'erode') forgetStroke()
    if (drag.kind !== 'placing-solid') releaseDropCache()
    if (drag.kind === 'idle') {
      snapIndicator.hit = null
      return
    }

    const ndc = pointerNdc(gl.domElement)
    if (!ndc) {
      // Off-canvas: show the placement as invalid rather than sticking to the
      // last good spot, so releasing here reads as a cancel.
      if (drag.kind === 'placing') s.updatePlacing(null, null)
      else if (drag.kind === 'placing-solid') s.updatePlacingSolid(null)
      // A stroke keeps its marks but forgets its path -- see `pauseStroke`.
      else if (drag.kind === 'erode') pauseStroke()
      snapIndicator.hit = null
      return
    }
    raycaster.setFromCamera(ndc, camera)

    switch (drag.kind) {
      case 'placing-solid':
        dragPlacingSolid(s, raycaster, dropCacheFor(drag.template))
        return
      case 'placing':
        dragPlacingSketch(s, raycaster, meshes.current)
        return
      case 'moving':
        dragSketch(s, drag, raycaster, meshes.current)
        return
      case 'moving-object':
        dragObject(s, drag, raycaster, camera)
        return
      case 'moving-face':
        dragFace(s, drag, raycaster)
        return
      case 'gizmo':
        dragGizmo(s, drag, raycaster, camera)
        return
      case 'sketch-gizmo':
        dragSketchGizmo(s, drag, raycaster, camera)
        return
      case 'cut-gizmo':
        dragCutGizmo(drag, raycaster, camera)
        return
      case 'ruler-gizmo':
        dragRulerGizmo(drag, raycaster)
        return
      case 'erode':
        dragErode(s, drag, raycaster, meshes.current, camera, gl.domElement)
        return
    }
  })

  return null
}

/** Where the current drag has caught, drawn through everything in front of it. */
function SnapMarker() {
  const scene = useSceneColors()
  // Built per render rather than at module scope, because it is per theme now.
  // A vertex snap is an addition and a face snap should look like the sketch it
  // is about to become, which is why these are --out and the sketch colour
  // rather than three shades chosen for this marker alone.
  const snapColors: Record<SnapTarget['kind'], string> = {
    vertex: scene.out,
    edge: scene.accent,
    face: scene.sketchIdle,
    // A centre is an alignment rather than a piece of material, so it wears the
    // colour the scene already uses for measuring rather than a fourth hue
    // invented for this marker.
    centre: scene.ruler,
  }
  const marker = useRef<Mesh>(null)

  useFrame(({ camera }) => {
    const mesh = marker.current
    if (!mesh) return
    // Read imperatively for the same reason the loop above does: this changes
    // many times per gesture, and React state at that rate is the cost the
    // whole imperative pattern exists to avoid.
    const hit = useDoc.getState().drag.kind === 'idle' ? null : snapIndicator.hit
    mesh.visible = hit !== null
    if (!hit) return

    mesh.position.copy(hit.point)
    // Scaled with distance so it holds roughly one size on screen: at the far
    // end of the zoom range a fixed-radius blob is a single pixel, and this is
    // the only sign the user gets that a snap fired at all.
    mesh.scale.setScalar(clamp(camera.position.distanceTo(hit.point) * 0.016, 0.002, 1.4))
    ;(mesh.material as MeshBasicMaterial).color.set(snapColors[hit.target.kind])
  })

  return (
    <mesh ref={marker} visible={false} renderOrder={20}>
      <sphereGeometry args={[1, 12, 8]} />
      <meshBasicMaterial
        color={snapColors.vertex}
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  )
}

/**
 * The lines drawn between two middles that have lined up.
 *
 * THE OTHER HALF OF THE SNAP INDICATOR, and it has to be a second component
 * because it draws a second kind of thing. `SnapMarker` above marks a POINT
 * that was landed on; this draws the RELATIONSHIP between two points that were
 * not landed on at all -- an object whose middle now shares a coordinate with
 * another object's middle, on one axis or two, with the rest of it wherever the
 * pointer left it. There is no contact to mark, and a dot at one end names one
 * of the two things involved.
 *
 * Without it the alignment is invisible: the object shifts a little on its own
 * and nothing on screen says why, which reads as a drag that drifts. See
 * `alignCentres`.
 *
 * ONE FIXED BUFFER FOR THREE SEGMENTS, rewritten in place every frame. There
 * can never be more -- there are three axes -- and a geometry reallocated per
 * frame mid-drag is exactly the cost the imperative pattern in this file
 * exists to avoid. `setDrawRange` hides the segments that are not in use, so an
 * alignment on one axis draws one line rather than three with two collapsed to
 * nothing at the origin.
 */
function SnapGuides() {
  const scene = useSceneColors()
  const lines = useRef<LineSegments>(null)
  // Three segments, two ends each, three numbers an end.
  const points = useMemo(() => new Float32Array(3 * 2 * 3), [])

  useFrame(() => {
    const mesh = lines.current
    if (!mesh) return
    const guides = useDoc.getState().drag.kind === 'idle' ? [] : snapIndicator.guides
    mesh.visible = guides.length > 0
    if (guides.length === 0) return

    for (let i = 0; i < guides.length && i < 3; i += 1) {
      const at = i * 6
      points[at] = guides[i].a.x
      points[at + 1] = guides[i].a.y
      points[at + 2] = guides[i].a.z
      points[at + 3] = guides[i].b.x
      points[at + 4] = guides[i].b.y
      points[at + 5] = guides[i].b.z
    }
    const attribute = mesh.geometry.getAttribute('position') as BufferAttribute
    attribute.needsUpdate = true
    mesh.geometry.setDrawRange(0, Math.min(guides.length, 3) * 2)
  })

  return (
    <lineSegments ref={lines} visible={false} renderOrder={20}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[points, 3]} />
      </bufferGeometry>
      {/* Through everything in front of it, like the marker: the two middles
          are INSIDE their solids, so a guide that respected depth would be a
          line you could never see either end of. Dashed would be truer to what
          a guide is, but a dashed line needs its distances computed per frame
          on a geometry that moves every frame -- so it wears the measuring
          colour instead, which is the same thing the centre marker wears and
          says the same thing about what it is. */}
      <lineBasicMaterial
        color={scene.ruler}
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
        transparent
        opacity={0.8}
      />
    </lineSegments>
  )
}

function Scene({
  controlsRef,
  meshes,
}: {
  controlsRef: RefObject<Controls>
  meshes: RefObject<Map<string, Mesh>>
}) {
  const dragging = useDoc((s) => s.drag.kind !== 'idle')
  const game = useTools(flyingHere)

  return (
    <>
      {/* The room itself -- background, lights, ground -- shared with every
          other screen's viewport. See `Stage`. */}
      <Stage />

      <SceneObjects meshes={meshes} controlsRef={controlsRef} />
      <PlacingPreview />
      <PlacingSolidPreview />
      <CutPlaneGizmo controlsRef={controlsRef} />
      <Rulers controlsRef={controlsRef} />
      <RotationDial />
      <SnapMarker />
      <SnapGuides />
      {/* Inside the canvas because it is the camera it reports on and flies.
          What it draws is a canvas of its own, outside -- see `AxisCompass`. */}
      <CompassControl controlsRef={controlsRef} />
      <BrushGhost meshes={meshes} />
      <Interaction meshes={meshes} />
      {/* Inside the canvas because it projects each object's gizmo through the
          camera to decide what the box caught. What it draws is outside. */}
      <MarqueeControl />
      {/* Reads the renderer's own counters once a frame and writes them into
          `perf`. Mounted conditionally rather than self-gating, so that with
          the probe off there is not even a frame callback to skip. */}
      {PERF_ON && <PerfProbe />}

      {/* Mounted only while the mode is on, so with it off there is not a
          listener or a frame callback left in the app that could have changed
          how the camera behaves. It goes AFTER the compass so that a step taken
          during a compass flight is the last word on where the camera is --
          the flight recomputes the position from the target every frame, and
          this carries both. See `GameControls`. */}
      {game && <GameControls controlsRef={controlsRef} />}

      <OrbitControls
        ref={controlsRef as never}
        makeDefault
        enabled={!dragging}
        enableDamping
        dampingFactor={0.12}
        minDistance={STAGE_MIN_DISTANCE}
        maxDistance={STAGE_MAX_DISTANCE}
        // The wheel changes how FAST you fly in game mode rather than how close
        // you are standing, so the rig's own zoom stands down -- otherwise one
        // notch would be answered twice, and the camera would creep forward
        // every time the speed was set. See `onWheel` in `GameControls`.
        enableZoom={!game}
      />
    </>
  )
}

function hintFor(
  kind: Drag['kind'],
  valid: boolean,
  solid: string,
  handle: GizmoHandle | null,
  /** Which brush is mid-stroke, for the one kind that has three of them. */
  brush: StrokeBrush | null
): string {
  switch (kind) {
    case 'idle':
      return ''
    case 'placing-solid':
      return valid ? `Release to drop the ${solid}` : 'Move over the grid to drop'
    case 'placing':
      return valid ? 'Release to place the sketch' : 'Move over an object to place'
    case 'moving':
      return 'Sliding the sketch across its surface'
    case 'moving-object':
      return 'Moving the object -- hold Shift to move it vertically'
    case 'moving-face':
      return 'Sliding the created face'
    case 'erode':
      if (brush === 'sculpt') {
        return 'Drawing material onto the surface -- go over it again to build it up'
      }
      // The one line here that says what a tool will NOT do, and it is the
      // thing about this brush a user has to be told once: it arrives at a
      // radius and stays there, so the instinct the other two teach -- go over
      // it again -- is the wrong one.
      if (brush === 'smoother') {
        return 'Rounding the corners off -- they stop at the radius Strength asks for'
      }
      return 'Melting the surface -- go over it again to sink it further'
    case 'gizmo':
    case 'cut-gizmo':
      return gizmoHint(handle)
    case 'ruler-gizmo':
      return rulerHint(handle)
    case 'sketch-gizmo':
      return sketchHint(handle)
  }
}

/**
 * What each of the sketch gizmo's handles is doing.
 *
 * Its own function rather than a branch inside `gizmoHint`, because the two
 * gizmos share a shape and not a vocabulary: an object's arrows name world
 * axes, and a sketch's name the outline's own directions and the face it lies
 * on. Reusing one hint for both would have to say "X" where the user is looking
 * at an amber arrow lying along the edge of a rectangle.
 */
function sketchHint(handle: GizmoHandle | null): string {
  if (!handle) return ''
  // Unreachable -- a sketch gizmo draws no quads -- and answered so the U/V
  // naming below is never handed a plane's normal axis to name.
  if (handle.mode === 'plane') return ''
  if (handle.mode === 'rotate') return 'Turning the sketch'
  if (handle.axis === 'all') return 'Resizing the sketch'
  if (handle.axis === 2) {
    return 'Setting the depth -- push back through the face to cut inward'
  }
  const name = handle.axis === 0 ? 'U' : 'V'
  return handle.mode === 'size'
    ? `Resizing the sketch along ${name}`
    : `Sliding the sketch along ${name}`
}

/**
 * What a ruler's arrow is doing.
 *
 * Its own line rather than a branch in `gizmoHint`, for the reason the sketch's
 * is: the gesture is shared but the vocabulary is not. An object's arrow moves
 * an object, and this one moves a point that is half of a measurement -- and it
 * says the ends catch, because catching is the whole reason to drag one rather
 * than type two coordinates.
 */
function rulerHint(handle: GizmoHandle | null): string {
  if (!handle || handle.axis === 'all') return ''
  const caught = 'it snaps to corners and edges'
  return handle.mode === 'plane'
    ? `Moving the ruler end in the ${PLANE_NAMES[handle.axis]} plane -- ${caught}`
    : `Moving the ruler end along ${AXIS_NAMES[handle.axis]} -- ${caught}`
}

/**
 * The two axes a plane handle leaves free, named by the axis it is normal to.
 *
 * The handle is indexed by its normal -- the one direction it will not move you
 * in -- because that is the promise it makes; what a user is looking at is the
 * pair, so the readout says the pair.
 */
const PLANE_NAMES = ['YZ', 'XZ', 'XY'] as const

function gizmoHint(handle: GizmoHandle | null): string {
  if (!handle) return ''
  if (handle.mode === 'rotate') {
    return handle.axis === 'all'
      ? 'Turning about the axis nearest the camera'
      : `Turning about ${AXIS_NAMES[handle.axis]} -- it lands on every 45 degrees`
  }
  if (handle.mode === 'plane') return `Moving in the ${PLANE_NAMES[handle.axis]} plane`
  if (handle.axis === 'all') return 'Scaling every dimension at once'
  const name = AXIS_NAMES[handle.axis]
  return handle.mode === 'move' ? `Moving along ${name}` : `Resizing along ${name}`
}

const AXIS_NAMES = ['X', 'Y', 'Z'] as const

/**
 * The angle, in degrees, pinned beside the dial it belongs to.
 *
 * A plain DOM node rather than text in the scene: it is a number that wants to
 * stay upright, legible and the same size however the camera is turned, which
 * is exactly what 3D text is bad at. The dial hands it a screen position every
 * frame; this only has to move it.
 *
 * Driven by rAF and written straight into the DOM, for the same reason the snap
 * readout is -- it changes as fast as the pointer moves, and React state at
 * that rate is the cost this whole imperative seam exists to avoid.
 */
function RotationReadout() {
  const chip = useRef<HTMLDivElement>(null)
  // A ring turn is a gesture, and gestures are rare; the readout is on screen
  // for a second or two at a time. Subscribed so the loop exists only while one
  // is running -- unconditionally, it spent the session writing
  // `style.display = 'none'` onto the same hidden node sixty times a second.
  const turning = useDoc((s) => s.drag.kind === 'gizmo')

  useEffect(() => {
    if (!turning) return
    let frame = 0
    let shown = ''
    const tick = () => {
      const node = chip.current
      if (node) {
        const on = rotationIndicator.active
        // Toggled through style rather than by unmounting: this runs sixty
        // times a second and must not churn the React tree to show a number.
        node.style.display = on ? 'block' : 'none'
        if (on) {
          const text = `${((rotationIndicator.angle * 180) / Math.PI).toFixed(1)}°`
          if (text !== shown) {
            node.textContent = text
            shown = text
          }
          node.style.transform =
            `translate(${rotationIndicator.screen.x}px, ${rotationIndicator.screen.y}px)`
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      // The loop is what hides the chip, so leaving without it would strand
      // whatever the last frame wrote.
      if (chip.current) chip.current.style.display = 'none'
    }
  }, [turning])

  return <div className="rotation-chip" ref={chip} style={{ display: 'none' }} />
}

/** Tells the user what the current gesture will do when released. */
function DragHint() {
  // Selected as primitives, not as `s.drag`: the drag object is replaced on
  // every frame of a placement, and subscribing to it would re-render this
  // overlay sixty times a second for text that changes twice a gesture.
  const kind = useDoc((s) => s.drag.kind)
  const valid = useDoc((s) =>
    s.drag.kind === 'placing'
      ? s.drag.anchor !== null
      : s.drag.kind === 'placing-solid'
        ? s.drag.position !== null
        : true
  )
  // Named for what is in hand, eraser included: the ghost went red the moment
  // one was picked up, and a line reading "drop the sphere" under a red shape
  // is the hint disagreeing with the picture about what release will do.
  const solid = useDoc((s) => {
    if (s.drag.kind !== 'placing-solid') return ''
    const name = solidLabel(s.drag.template.base).toLowerCase()
    return s.drag.template.erase ? `${name} eraser` : name
  })
  const handle = useDoc((s) => {
    if (s.drag.kind === 'gizmo' || s.drag.kind === 'cut-gizmo') return s.drag.handle
    if (s.drag.kind === 'ruler-gizmo') return s.drag.handle
    // A sketch drag carries a bare axis rather than a handle; the hint only
    // needs to tell the ring from the arrows.
    if (s.drag.kind === 'sketch-gizmo') return s.drag.handle
    return null
  })
  // Read off the DRAG rather than off the armed tool, so the line describes the
  // stroke in flight -- see the `erode` drag's `brush`. Null for every other
  // gesture, which is what `hintFor` switches on.
  const brush = useDoc((s) => (s.drag.kind === 'erode' ? s.drag.brush : null))
  // The marquee is not one of the document's drags -- drawing a box edits
  // nothing -- so it is asked about separately. Both selectors collapse to a
  // value that changes a handful of times per gesture rather than per move.
  const marqueeing = useMarquee((s) => s.box !== null && boxSpan(s.box) >= MARQUEE_SLOP)
  const caught = useDoc((s) => s.selectedObjectIds.length)
  const readout = useRef<HTMLSpanElement>(null)

  // The snap readout is written straight into the DOM for the same reason the
  // frame loop reads the store imperatively: it changes as fast as the pointer
  // moves, and it is one line of text.
  useEffect(() => {
    if (kind === 'idle') return
    let frame = 0
    let shown = ''
    const tick = () => {
      // A turn reports its angle rather than what it caught -- it catches
      // nothing, and the number is the one thing the pie cannot give exactly.
      const hit = snapIndicator.hit
      const text = rotationIndicator.active
        ? `${((rotationIndicator.angle * 180) / Math.PI).toFixed(1)}°`
        : hit
          ? `Snapped to ${hit.target.kind}`
          : ''
      if (text !== shown && readout.current) {
        readout.current.textContent = text
        shown = text
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [kind])

  if (marqueeing) {
    return (
      <div className="viewport-hint">
        {caught === 0
          ? 'Nothing in the box yet -- it catches an object by its centre'
          : `${caught} object${caught === 1 ? '' : 's'} selected -- hold Shift to add to the selection`}
      </div>
    )
  }

  if (kind === 'idle') return null

  return (
    <div className={`viewport-hint${valid ? '' : ' viewport-hint-bad'}`}>
      {hintFor(kind, valid, solid, handle, brush)}
      <span className="snap-readout" ref={readout} />
    </div>
  )
}

export function Viewport() {
  const controlsRef = useRef<Controls>(null)
  const meshes = useRef<Map<string, Mesh>>(new Map())
  const selectObject = useDoc((s) => s.selectObject)
  // Subscribed rather than read imperatively, because it changes the CURSOR --
  // a React-rendered attribute, so it has to come through a render.
  // Either brush: the crosshair is about a brush being aimed, not about which.
  const brushArmed = useTools((s) => s.brushTool !== null)

  // The gesture ends wherever the pointer happens to be -- including outside
  // the window -- so completion is owned by a global listener, not the canvas.
  useEffect(() => {
    const finish = () => {
      const s = useDoc.getState()
      if (s.drag.kind === 'placing-solid') s.commitPlacingSolid()
      else if (s.drag.kind === 'placing') s.commitPlacing()
      else if (s.drag.kind !== 'idle') s.endDrag()
      snapIndicator.hit = null
      // The frame loop clears these too, but a press that lands before the next
      // frame would inherit them -- and a grab offset from the previous gesture
      // is exactly the teleport it exists to prevent.
      clearGrabs()
      if (controlsRef.current) controlsRef.current.enabled = true
    }

    const track = (e: KeyboardEvent | PointerEvent) => {
      // Read off whatever event is to hand rather than from a keydown alone,
      // because a window that regains focus with the key already down never
      // sees the press.
      modifiers.shift = e.shiftKey
    }

    /**
     * Which mouse button orbits, re-decided before every press.
     *
     * The left button used to orbit from empty space; the selection box now
     * starts there, and two gestures cannot share one button. So orbit moves to
     * the MIDDLE button, and stays reachable on the left with Alt held for the
     * mice and trackpads that have no middle button to press. Panning is
     * untouched on the right.
     *
     * Written on every press rather than once at mount for two reasons: the
     * controls are created inside the canvas and the ref is empty when this
     * effect first runs, and Alt is a per-press question, since OrbitControls
     * reads this map at pointer-down and never again during the drag.
     *
     * Capture phase on the window, so it lands before the controls' own
     * listener on the canvas sees the same press.
     */
    const armCamera = (e: PointerEvent) => {
      const controls = controlsRef.current
      if (!controls) return
      controls.mouseButtons.LEFT = e.altKey ? MOUSE.ROTATE : null
      controls.mouseButtons.MIDDLE = MOUSE.ROTATE
      // GAME CONTROLS TAKE THE RIGHT BUTTON, which is the one gesture the two
      // schemes cannot both have: holding right is how you look about, and a
      // pan running underneath it would slide the whole scene sideways every
      // time you turned your head. Panning is not replaced by anything, because
      // in that mode it has nothing to do -- walking is what moves you now, and
      // A and D strafe exactly where a pan used to. Read per press rather than
      // once, so switching the mode is felt on the very next press.
      controls.mouseButtons.RIGHT = flyingHere(useTools.getState()) ? null : MOUSE.PAN
    }
    // A window that loses focus never sees the keyup, so a flag would stay
    // stuck on and the next object drag would go vertical -- or the next gizmo
    // come up wearing planes -- out of nowhere.
    const blur = clearModifiers

    const onKey = (e: KeyboardEvent) => {
      track(e)
      const s = useDoc.getState()
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'TEXTAREA')
      ) {
        return
      }

      if (e.key === 'Escape') {
        // A marquee in flight is cancelled rather than committed, and the
        // selection it was drawn over is put back -- it applies its catch live,
        // so by now the selection it started from is gone.
        const marquee = useMarquee.getState()
        if (marquee.box) {
          s.selectObjects(marquee.base)
          marquee.clear()
          return
        }
        s.endDrag()
        clearGrabs()
        useObjectMenu.getState().closeMenu()
        s.selectObject(null)
        // The ruler stays, its handles go. Escape has always meant "put that
        // down", and the one thing it must not do is throw away a measurement
        // that took two snapped ends to place -- that is what the cross in the
        // ruler list is for.
        useTools.getState().selectRuler(null)
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // WHAT DELETE TAKES is whatever is currently wearing the handles, and
        // the branches are in that order.
        //
        // A selected ruler goes first, because a selected ruler holds the only
        // gizmo on screen -- it takes the gizmo from the object, and pressing
        // an object hands it back -- so it is unambiguously the thing being
        // worked on. This is the one way to delete one without going to the
        // list, and it is the way anyone reaches for first, since Delete
        // already removes everything else you can select in this app.
        //
        // Then a feature, which is the finer selection of the two below it:
        // deleting the whole object out from under a selected sketch would be
        // a surprise.
        const ruler = useTools.getState().selectedRuler
        const selected = primarySelection(s)
        if (ruler) {
          useTools.getState().removeRuler(ruler.id)
        } else if (selected && s.selectedFeatureId) {
          s.removeFeature(selected, s.selectedFeatureId)
        } else if (selected) {
          // The WHOLE selection, not just the one wearing the gizmo. A marquee
          // over six solids is one gesture and reads as one thing; clearing it
          // with six presses of the same key would be six undo steps for what
          // the user did once.
          s.removeObjects(s.selectedObjectIds)
        }
      } else if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.key.toLowerCase() in MODE_KEYS
      ) {
        // Ignored mid-gesture. The mode decides which handles exist at all, so
        // switching one out from under a drag in flight would leave the gesture
        // running against a gizmo that had left the screen -- and the turn or
        // the resize would carry on, invisibly, until the button came up.
        if (s.drag.kind !== 'idle') return
        // AND IGNORED WHILE THE CAMERA IS DRIVEN FROM THE KEYBOARD. S is the
        // key that walks backwards, and it cannot also be the one that puts
        // Scale on the gizmo -- a user backing away from a solid would resize
        // it. Taking all three rather than the one that collides is deliberate:
        // a scheme where two of the three letter shortcuts survive and the
        // third silently means something else is worse to learn than one where
        // the letters are simply the camera's while you are flying. The three
        // buttons on the island do the same job and are always there. See
        // `gameControls`.
        if (flyingHere(useTools.getState())) return
        const wanted = MODE_KEYS[e.key.toLowerCase()]
        const { pressTransformMode } = useTools.getState()
        // Deferred whole to the store, which is the only place that knows
        // what a press means -- the buttons on the island call the same action,
        // so the key and the click cannot drift apart.
        pressTransformMode(wanted)
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        // Whole objects only. A sketch is not something the clipboard can put
        // down on its own -- it needs a face to sit on -- so a copy with one
        // selected takes the solid that hosts it, which is the object the user
        // is looking at either way.
        const selected = primarySelection(s)
        const object = selected && s.doc.objects.find((o) => o.id === selected)
        if (object) {
          e.preventDefault()
          useLibrary.getState().copyObject(object)
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        const { clipboard } = useLibrary.getState()
        if (clipboard) {
          e.preventDefault()
          s.pasteObject(clipboard)
        }
      }
    }

    window.addEventListener('pointerdown', armCamera, true)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('pointermove', track, { passive: true })
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', track)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointerdown', armCamera, true)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('pointermove', track)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', track)
      window.removeEventListener('blur', blur)
    }
  }, [])

  return (
    // Right-drag is a gizmo gesture here, and a native context menu popping up
    // mid-drag would take the pointer away from it. Suppressed on the whole
    // viewport rather than on the handles alone, because the menu opens on
    // pointer-UP -- by which time the pointer has usually left the arrow.
    // The crosshair is the whole of what the pointer looks like with the torch
    // armed, and it stays through the stroke -- while the brush is in use the
    // ghost stands down and the cursor is all the aiming there is.
    <div
      className={`viewport${brushArmed ? ' viewport-brush' : ''}`}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Canvas
        // Where a camera stands in this room, shared with every other screen:
        // see `STAGE_CAMERA`.
        camera={STAGE_CAMERA}
        // A 200,000:1 frustum is far past what a 24-bit depth buffer resolves,
        // so the log buffer is not an optimisation here but the thing that
        // keeps faces from tearing.
        //
        // And no alpha channel. React-three-fiber asks for one by default, so
        // the drawing buffer carries a fourth component the page then composites
        // the whole canvas through -- for a scene that paints an opaque ground
        // colour over every pixel before anything else draws. See `Stage`, which
        // attaches it. Nothing on screen changes; a full-screen blend per frame
        // stops happening.
        gl={{ logarithmicDepthBuffer: true, alpha: false }}
        dpr={[1, 2]}
        // The left button is the marquee's, and it clears the selection itself
        // on a press that drew no box -- so only the other buttons are answered
        // here, and the two can never both fire on one gesture.
        onPointerMissed={(e) => {
          if (e.button !== 0) selectObject(null)
          // Whichever button: a press that reached nothing in the scene reached
          // no ruler either, and a selected ruler holds the only gizmo on
          // screen -- so there has to be a way to put it down that is not
          // hunting for its row in a panel. The rulers themselves stay.
          useTools.getState().selectRuler(null)
        }}
      >
        <Scene controlsRef={controlsRef} meshes={meshes} />
      </Canvas>
      <ToolIsland />
      <BrushScopePanel />
      {/* Top-middle, over the scene and clear of everything else: the island is
          in a corner, the compass in another, and the drag hint sits along the
          bottom. See `FlightSpeedReadout`. */}
      <FlightSpeedReadout />
      <AxisCompass />
      <SelectionHud />
      <MarqueeRect />
      <RotationReadout />
      <RulerReadouts />
      <DragHint />
      <PerfHud />
      <ObjectMenu />
    </div>
  )
}
