import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Grid, OrbitControls } from '@react-three/drei'
import { MOUSE, Mesh, Raycaster, Vector3 } from 'three'
import type { Camera, MeshBasicMaterial } from 'three'
import {
  MAX_FACE_OFFSET,
  maxShapeSize,
  resizeAlongAxis,
  resizeShapeAlong,
  scaleShape,
} from '../geometry/dimensions'
import { assemblyAnchor, assemblyHalfExtent } from '../geometry/assembly'
import type { SnapTarget } from '../geometry/snap'
import { snapSinglePoint } from '../geometry/snap'
import { hostSurfaceFor, samePatch, slideAnchor, surfaceFor } from '../geometry/surfaces'
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
  useTools,
} from '../store/toolStore'
import { CutPlaneGizmo } from './CutPlaneGizmo'
import { RulerReadouts, Rulers } from './Rulers'
import {
  pickAnchorAcrossObjects,
  pickAnchorOnObject,
  pickGroundPoint,
  pickPlanePoint,
  pointerNdc,
} from './picking'
import { dropCacheFor, releaseDropCache } from './dropCache'
import { ObjectMenu, useObjectMenu } from './ObjectMenu'
import type { DropCache } from './dropCache'
import { PlacingSolidPreview } from './PlacingSolidPreview'
import { AxisCompass, CompassControl } from './AxisCompass'
import { SelectionHud } from './SelectionHud'
import { ToolIsland } from './ToolIsland'
import { RotationDial } from './RotationDial'
import { SceneObjects } from './SceneObjects'
import { MarqueeControl, MarqueeRect } from './SelectionMarquee'
import { MARQUEE_SLOP, boxSpan, useMarquee } from './marquee'
import { PlacingPreview } from './SketchLayer'
import {
  advanceTurn,
  axisTarget,
  axisTravel,
  beginAxisDrag,
  beginPlaneDrag,
  nearestLocalAxis,
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
import { clearModifiers, modifiers, planeHandles } from './modifiers'
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
 * The slice of OrbitControls this file touches: whether it is listening, and
 * which gesture each mouse button asks it for.
 *
 * Structural rather than the real class, because the ref is handed to drei's
 * component, which is typed loosely enough that naming the class here would buy
 * nothing. Both fields are written imperatively -- `enabled` because a drag has
 * to stop the camera synchronously, inside the press that started it, and the
 * buttons because which one orbits is decided per press.
 */
type Controls = {
  enabled: boolean
  mouseButtons: { LEFT: MOUSE | null; MIDDLE: MOUSE | null; RIGHT: MOUSE | null }
  /** The point the camera orbits, which a pan moves. Read by the compass, whose
   *  flights turn about whatever the user is actually looking at. */
  target: Vector3
  /** Made to re-read the camera after something else has moved it. */
  update: () => void
} | null
type Store = ReturnType<typeof useDoc.getState>
type DragOf<K extends Drag['kind']> = Extract<Drag, { kind: K }>

/** Matches the Inspector's face-offset range; the drag must not out-run it.
 *  Both now read the one definition in `dimensions.ts`. */
const FACE_OFFSET_LIMIT = MAX_FACE_OFFSET

/**
 * The grid sits a hair BELOW y = 0 even though objects rest exactly on it:
 * coplanar with a box's bottom face it z-fights across the whole footprint.
 */
const GRID_Y = -0.002

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
function ownTargets(objectId: string): SnapTarget[] {
  return snapTargets().filter((t) => t.objectId === objectId)
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
function snappedSketchAnchor(object: SceneObject, raycaster: Raycaster): SurfaceAnchor | null {
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
    ownTargets(object.id),
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
  const anchor = snappedSketchAnchor(object, raycaster) ?? plain
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
  axisFrame: Vec3 = rotation
): { grab: TurnGrab; total: number } | null {
  const facing = camera.quaternion.clone()
  const right = new Vector3(1, 0, 0).applyQuaternion(facing)
  const up = new Vector3(0, 1, 0).applyQuaternion(facing)
  const normal = camera.getWorldDirection(new Vector3())

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
      axis: nearestViewAxis(axisFrame, normal).axis,
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
    // World axes, matching the arrows: the ring turns about whichever of X, Y
    // and Z most faces the camera -- equivalently, it turns IN whichever world
    // plane most faces the camera. An object already turned 30 degrees offers
    // the same three choices as one straight out of the palette.
    const turn = readTurn(key, raycaster, camera, centre, rotation, position, WORLD_FRAME)
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

  // The arrow points along a WORLD axis, so that is the line the pointer is
  // measured against and the direction a slide runs in.
  const dir = axisWorld(WORLD_FRAME, drag.handle.axis)
  // A resize cannot follow it there. A solid's dimensions are its own -- there
  // is no "wider along world X" for a box standing at an angle -- so the world
  // arrow is matched to the local axis it most nearly runs along, and that is
  // the one that grows. See `nearestLocalAxis`.
  const sizeAxis = nearestLocalAxis(rotation, dir)
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
      scaleShape(grab.shape, radius / grab.radius, maxShapeSize(object.base))
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

  // Right-drag: stretch the outline along the arrow rather than sliding it.
  if (handle.mode === 'size') {
    s.resizeShapeTo(
      resizeShapeAlong(grab.shape, handle.axis, travel, maxShapeSize(object.base))
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
    // WHICH axis is picked in the world frame, matching the arrows: a blade
    // already tilted 30 degrees offers the same three choices as a flat one,
    // rather than three that rode the turn before it.
    const turn = readTurn(
      key,
      raycaster,
      camera,
      centre,
      plane.rotation,
      plane.position,
      WORLD_FRAME
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
    }
  })

  return null
}

const SNAP_COLORS: Record<SnapTarget['kind'], string> = {
  vertex: '#5fd68a',
  edge: '#59a5ff',
  face: '#f0a848',
}

/** Where the current drag has caught, drawn through everything in front of it. */
function SnapMarker() {
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
    ;(mesh.material as MeshBasicMaterial).color.set(SNAP_COLORS[hit.target.kind])
  })

  return (
    <mesh ref={marker} visible={false} renderOrder={20}>
      <sphereGeometry args={[1, 12, 8]} />
      <meshBasicMaterial
        color={SNAP_COLORS.vertex}
        depthTest={false}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
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

  return (
    <>
      <color attach="background" args={['#0e1013']} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[6, 9, 5]} intensity={2.1} />
      <directionalLight position={[-6, 3, -5]} intensity={0.7} color="#8fb4ff" />

      {/* Grid colours are lifted well clear of the #0e1013 background: at the
          original values the ground read as empty space. Major lines carry a
          cool cast so they separate from the warm-grey solids, and the fade is
          gentler so the plane still reads out toward the horizon.

          TWO grids, each divided ten ways, because one cannot serve a world
          that runs from a millimetre to five metres. A single grid fine enough
          to count centimetres against turns to moire the moment you pull back
          far enough to see a whole wall; one coarse enough to survive that has
          nothing to say when you are shaping a 5 mm boss.

          So the near grid rules centimetres into decimetres and fades out at
          about a metre and a half, and the far one takes over ruling
          decimetres into metres. Zoom in and the ground gets finer; zoom out
          and it gets coarser, and at every zoom a major square is a round
          number you can count in.

          The fine grid sits a hair ABOVE the coarse one so that where their
          lines coincide -- every 1 unit, which is a section of one and a cell
          of the other -- the finer of the two wins outright rather than the
          pair z-fighting along every decimetre. */}
      <Grid
        position={[0, GRID_Y + 0.0005, 0]}
        args={[24, 24]}
        cellSize={0.1}
        cellThickness={0.6}
        cellColor="#394454"
        sectionSize={1}
        sectionThickness={1.2}
        sectionColor="#6d829b"
        fadeDistance={14}
        fadeStrength={1}
        infiniteGrid
      />
      <Grid
        position={[0, GRID_Y, 0]}
        args={[24, 24]}
        cellSize={1}
        cellThickness={0.6}
        cellColor="#394454"
        sectionSize={10}
        sectionThickness={1.4}
        sectionColor="#6d829b"
        fadeDistance={300}
        fadeStrength={0.8}
        infiniteGrid
      />

      <SceneObjects meshes={meshes} controlsRef={controlsRef} />
      <PlacingPreview />
      <PlacingSolidPreview />
      <CutPlaneGizmo controlsRef={controlsRef} />
      <Rulers controlsRef={controlsRef} />
      <RotationDial />
      <SnapMarker />
      {/* Inside the canvas because it is the camera it reports on and flies.
          What it draws is a canvas of its own, outside -- see `AxisCompass`. */}
      <CompassControl controlsRef={controlsRef} />
      <Interaction meshes={meshes} />
      {/* Inside the canvas because it projects each object's gizmo through the
          camera to decide what the box caught. What it draws is outside. */}
      <MarqueeControl />

      <OrbitControls
        ref={controlsRef as never}
        makeDefault
        enabled={!dragging}
        enableDamping
        dampingFactor={0.12}
        // 114 is what it takes to frame the largest solid `dimensions.ts`
        // allows; 200 leaves room to stand off a scene of them. The near end
        // drops far enough to put a millimetre feature on screen.
        minDistance={0.02}
        maxDistance={200}
      />
    </>
  )
}

function hintFor(
  kind: Drag['kind'],
  valid: boolean,
  solid: string,
  handle: GizmoHandle | null
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
    ? `Resizing the sketch along ${name} -- right-drag`
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
  if (handle.mode === 'rotate') return 'Turning about the axis nearest the camera'
  if (handle.mode === 'plane') return `Moving in the ${PLANE_NAMES[handle.axis]} plane`
  if (handle.axis === 'all') return 'Scaling every dimension at once'
  const name = AXIS_NAMES[handle.axis]
  return handle.mode === 'move'
    ? `Moving along ${name}`
    : `Resizing along ${name} -- right-drag`
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

  useEffect(() => {
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
    return () => cancelAnimationFrame(frame)
  }, [])

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
  const solid = useDoc((s) =>
    s.drag.kind === 'placing-solid' ? solidLabel(s.drag.template.base).toLowerCase() : ''
  )
  const handle = useDoc((s) => {
    if (s.drag.kind === 'gizmo' || s.drag.kind === 'cut-gizmo') return s.drag.handle
    if (s.drag.kind === 'ruler-gizmo') return s.drag.handle
    // A sketch drag carries a bare axis rather than a handle; the hint only
    // needs to tell the ring from the arrows.
    if (s.drag.kind === 'sketch-gizmo') return s.drag.handle
    return null
  })
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
      {hintFor(kind, valid, solid, handle)}
      <span className="snap-readout" ref={readout} />
    </div>
  )
}

export function Viewport() {
  const controlsRef = useRef<Controls>(null)
  const meshes = useRef<Map<string, Mesh>>(new Map())
  const selectObject = useDoc((s) => s.selectObject)

  // The gesture ends wherever the pointer happens to be -- including outside
  // the window -- so completion is owned by a global listener, not the canvas.
  useEffect(() => {
    const finish = () => {
      const s = useDoc.getState()
      if (s.drag.kind === 'placing-solid') s.commitPlacingSolid()
      else if (s.drag.kind === 'placing') s.commitPlacing()
      else if (s.drag.kind !== 'idle') s.endDrag()
      snapIndicator.hit = null
      // The plane handles were latched up for the length of the drag, whatever
      // Control has been doing meanwhile. This is the one place that sees every
      // gesture end, so it is where they are let go.
      planeHandles.held = false
      // The frame loop clears these too, but a press that lands before the next
      // frame would inherit them -- and a grab offset from the previous gesture
      // is exactly the teleport it exists to prevent.
      clearGrabs()
      if (controlsRef.current) controlsRef.current.enabled = true
    }

    const track = (e: KeyboardEvent | PointerEvent) => {
      modifiers.shift = e.shiftKey
      // Meta counts as Control; see `modifiers`. Read off whatever event is to
      // hand rather than from a keydown alone, because a window that regains
      // focus with the key already down never sees the press.
      modifiers.ctrl = e.ctrlKey || e.metaKey
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
      controls.mouseButtons.RIGHT = MOUSE.PAN
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
        planeHandles.held = false
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
          s.removeObject(selected)
        }
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
    <div className="viewport" onContextMenu={(e) => e.preventDefault()}>
      <Canvas
        // Four units out -- 40 cm -- which frames the 10 cm solid the palette
        // drops with a comfortable margin of ground around it, rather than the
        // metre of empty grid the opening shot used to hold. The direction is
        // unchanged: down the corner, so all three axes read at once.
        camera={{ position: [2.5, 1.85, 2.5], fov: 45, near: 0.005, far: 1000 }}
        // A five-metre solid needs the camera 113 units out to frame it; a
        // millimetre one fills the view from 0.023 units away, which was INSIDE
        // the old near plane -- the app simply could not draw a part that small.
        // Both ends had to move, and a 200,000:1 frustum is far past what a
        // 24-bit depth buffer resolves, so the log buffer is not an
        // optimisation here but the thing that keeps faces from tearing.
        gl={{ logarithmicDepthBuffer: true }}
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
      <AxisCompass />
      <SelectionHud />
      <MarqueeRect />
      <RotationReadout />
      <RulerReadouts />
      <DragHint />
      <ObjectMenu />
    </div>
  )
}
