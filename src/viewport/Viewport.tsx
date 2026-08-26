import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Grid, OrbitControls } from '@react-three/drei'
import { Mesh, Raycaster, Vector3 } from 'three'
import type { BufferGeometry, Camera, MeshBasicMaterial } from 'three'
import type { SnapTarget } from '../geometry/snap'
import { snapSinglePoint } from '../geometry/snap'
import { hostSurfaceFor, surfaceFor } from '../geometry/surfaces'
import { endFaceFrame } from '../geometry/prism'
import { toLocalPoint, toLocalRay, toWorldDir, toWorldPoint } from '../geometry/transform'
import type { BaseSolid, SceneObject, SurfaceAnchor, Vec3 } from '../geometry/types'
import { solidLabel } from '../geometry/types'
import type { Drag } from '../store/docStore'
import { useDoc } from '../store/docStore'
import { useTools } from '../store/toolStore'
import { CutPlaneGizmo } from './CutPlaneGizmo'
import {
  pickAnchorAcrossObjects,
  pickAnchorOnObject,
  pickGroundPoint,
  pickPlanePoint,
  pointerNdc,
} from './picking'
import { PlacingSolidPreview } from './PlacingSolidPreview'
import { SceneObjects } from './SceneObjects'
import { PlacingPreview } from './SketchLayer'
import {
  resolveObjectMove,
  resolvePoint,
  resolveSolidDrop,
  snapIndicator,
  snapTargets,
} from './snapping'

type Controls = { enabled: boolean } | null
type Store = ReturnType<typeof useDoc.getState>
type DragOf<K extends Drag['kind']> = Extract<Drag, { kind: K }>

/** Matches the Inspector's face-offset range; the drag must not out-run it. */
const FACE_OFFSET_LIMIT = 1.5

/**
 * The grid sits a hair BELOW y = 0 even though objects rest exactly on it:
 * coplanar with a box's bottom face it z-fights across the whole footprint.
 */
const GRID_Y = -0.002

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/**
 * Live modifier state. The gestures are driven from a frame loop rather than
 * from the event that set the key, so the flag has to outlive that event.
 */
const modifiers = { shift: false }

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

let objectGrab: ObjectGrab | null = null
let faceGrab: FaceGrab | null = null

/** Drop both, except the one belonging to the gesture currently running. */
function clearGrabs(kind: Drag['kind'] = 'idle'): void {
  if (kind !== 'moving-object') objectGrab = null
  if (kind !== 'moving-face') faceGrab = null
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

/**
 * What one drag of a palette template needs measured about it, built once per
 * gesture: the height that rests it on the grid, and the mesh whose corners the
 * drop seeks the scene with.
 */
type DropCache = { base: BaseSolid; lift: number; geometry: BufferGeometry }

/** Drop point for a fresh primitive, resting on the grid under the pointer. */
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

/**
 * Whether two anchors name the same patch of the same surface.
 *
 * Only the multi-patch kinds carry a face index; for every other kind the patch
 * IS the surface, so matching `on` is the whole question.
 */
function samePatch(a: SurfaceAnchor, b: SurfaceAnchor): boolean {
  if (a.on !== b.on) return false
  if (a.on === 'box-face' && b.on === 'box-face') return a.face === b.face
  if (a.on === 'planar-face' && b.on === 'planar-face') return a.face === b.face
  return true
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
  // Rebuilding a faceted surface just to read its extents costs a full face
  // list, and sampling its corners for the drop snap costs a topology pass; the
  // base being dragged never changes mid-gesture, so both are measured once.
  const drop = useRef<DropCache | null>(null)

  // `surfaceFor().geometry()` hands back a fresh BufferGeometry whose GPU
  // buffers outlive the JS wrapper, so the cache is freed rather than dropped:
  // once per gesture, and again if the canvas goes away mid-drag.
  const releaseDrop = useCallback(() => {
    drop.current?.geometry.dispose()
    drop.current = null
  }, [])
  useEffect(() => releaseDrop, [releaseDrop])

  useFrame(() => {
    const s = useDoc.getState()
    // Hoisted to a const so the narrowing below survives into the branches;
    // TypeScript discards it for a mutable property reference.
    const drag = s.drag
    // This loop is the only place that sees every gesture end, so it is where
    // the per-gesture caches are dropped -- before the early returns below,
    // which a released drag takes on its way out.
    clearGrabs(drag.kind)
    if (drag.kind !== 'placing-solid') releaseDrop()
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
      case 'placing-solid': {
        if (drop.current?.base !== drag.base) {
          releaseDrop()
          const surface = surfaceFor(drag.base)
          drop.current = {
            base: drag.base,
            lift: -surface.bounds().min.y,
            geometry: surface.geometry(),
          }
        }
        dragPlacingSolid(s, raycaster, drop.current)
        return
      }
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
    mesh.scale.setScalar(clamp(camera.position.distanceTo(hit.point) * 0.016, 0.02, 0.22))
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
          gentler so the plane still reads out toward the horizon. */}
      <Grid
        position={[0, GRID_Y, 0]}
        args={[24, 24]}
        cellSize={0.5}
        cellThickness={0.7}
        cellColor="#394454"
        sectionSize={2.5}
        sectionThickness={1.4}
        sectionColor="#6d829b"
        fadeDistance={34}
        fadeStrength={0.8}
        infiniteGrid
      />

      <SceneObjects meshes={meshes} controlsRef={controlsRef} />
      <PlacingPreview />
      <PlacingSolidPreview />
      <CutPlaneGizmo />
      <SnapMarker />
      <Interaction meshes={meshes} />

      <OrbitControls
        ref={controlsRef as never}
        makeDefault
        enabled={!dragging}
        enableDamping
        dampingFactor={0.12}
        minDistance={1.5}
        maxDistance={24}
      />
    </>
  )
}

function hintFor(kind: Drag['kind'], valid: boolean, solid: string): string {
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
  }
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
    s.drag.kind === 'placing-solid' ? solidLabel(s.drag.base).toLowerCase() : ''
  )
  const readout = useRef<HTMLSpanElement>(null)

  // The snap readout is written straight into the DOM for the same reason the
  // frame loop reads the store imperatively: it changes as fast as the pointer
  // moves, and it is one line of text.
  useEffect(() => {
    if (kind === 'idle') return
    let frame = 0
    let shown = ''
    const tick = () => {
      const hit = snapIndicator.hit
      const text = hit ? `Snapped to ${hit.target.kind}` : ''
      if (text !== shown && readout.current) {
        readout.current.textContent = text
        shown = text
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [kind])

  if (kind === 'idle') return null

  return (
    <div className={`viewport-hint${valid ? '' : ' viewport-hint-bad'}`}>
      {hintFor(kind, valid, solid)}
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
      // The frame loop clears these too, but a press that lands before the next
      // frame would inherit them -- and a grab offset from the previous gesture
      // is exactly the teleport it exists to prevent.
      clearGrabs()
      if (controlsRef.current) controlsRef.current.enabled = true
    }

    const track = (e: KeyboardEvent | PointerEvent) => {
      modifiers.shift = e.shiftKey
    }
    // A window that loses focus never sees the keyup, so the flag would stay
    // stuck on and the next object drag would go vertical out of nowhere.
    const blur = () => {
      modifiers.shift = false
    }

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
        s.endDrag()
        clearGrabs()
        s.selectObject(null)
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // A feature is the finer selection, so it goes first: deleting the
        // whole object out from under a selected sketch would be a surprise.
        if (s.selectedObjectId && s.selectedFeatureId) {
          s.removeFeature(s.selectedObjectId, s.selectedFeatureId)
        } else if (s.selectedObjectId) {
          s.removeObject(s.selectedObjectId)
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      }
    }

    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('pointermove', track, { passive: true })
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', track)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('pointermove', track)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', track)
      window.removeEventListener('blur', blur)
    }
  }, [])

  return (
    <div className="viewport">
      <Canvas
        camera={{ position: [6.2, 4.6, 6.2], fov: 45, near: 0.1, far: 200 }}
        dpr={[1, 2]}
        onPointerMissed={() => selectObject(null)}
      >
        <Scene controlsRef={controlsRef} meshes={meshes} />
      </Canvas>
      <DragHint />
    </div>
  )
}
