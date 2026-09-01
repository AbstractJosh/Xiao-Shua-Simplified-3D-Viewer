import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, SphereGeometry, Vector3 } from 'three'
import type { Object3D } from 'three'
import { BLOCK_HALF, faceBasis, faceToBlock } from '../geometry/laserCut'
import type { FaceAxis, Pt } from '../geometry/laserCut'
import { MAX_ROPE, isCutTool, mirrorOn, useTools } from '../store/toolStore'
import { curveHandles, draftCut, useCutDraft } from './cutDraft'
import { LIFT, facePixelsFrom, pointerToFace } from './facePointer'
import { pixelsToWorld } from './orthoFrame'
import { faceTolerance, sideAlong, snapToPeers } from './pointSnap'
import { useSceneColors } from './useSceneColors'

/**
 * THE LINE ON THE FACE: what is drawn on the block, and the pointer work that
 * puts it there.
 *
 * IT DOES ITS OWN PICKING, with a `Raycaster` against a plane, rather than
 * hanging `onPointerDown` off a mesh. Three reasons, and the third is the one
 * that settles it. A stroke has to keep working over the parts of the face a
 * cut has already removed, where there is no mesh left to hit. It has to keep
 * working when the pointer runs off the block entirely, since a line that stops
 * at the silhouette could never be carried to the border. And the plane is
 * KNOWN -- the compass has settled the camera square on to one face, so which
 * surface is being drawn on is not a question the scene has to be asked.
 *
 * The same choice `Viewport` makes with `picking.ts`, for the same reason: what
 * the pointer means here is arithmetic, and arithmetic can be checked without a
 * browser.
 *
 * EVERYTHING IS IN BLOCK SPACE -- the unit cube centred on the origin -- and
 * drawn inside a group carrying the SAME transform `Pieces` puts the block
 * under. That is not a detail: the drawing and the block it is drawn on have to
 * be placed by one rule, and the two halves of this file already disagree about
 * everything else. `toFace` inverts the transform to read the pointer, the
 * preview re-applies it to draw, and a mark that skipped it landed half a block
 * below the face it was aimed at -- right shape, right size, wrong place, which
 * is exactly the fault no amount of checking the arithmetic finds.
 */

/**
 * How wide the preview line is drawn: PIXELS, held there at every zoom, like
 * the knots on it.
 *
 * IT USED TO BE THREE KERFS -- a width in the material, exaggerated threefold
 * because the true slot is under a pixel at the opening zoom. That made the
 * line a scale model of what the laser takes, which is honest and, past a few
 * turns of the wheel, useless: at ten times in, the slot is a fifty-pixel band
 * of solid colour lying across the very drawing it is being aimed along, so the
 * closer you look the less you can see. A line you are aiming is a mark on the
 * screen, so it is held to the screen, exactly as the knots and grips are. See
 * `pixelsToWorld` for the two kinds of thing and which is which.
 *
 * WHAT IS GIVEN UP, said plainly: zoomed in, the line no longer stands for how
 * much material the cut takes -- it is thinner than the real slot rather than
 * wider. The kerf itself is unchanged and unchangeable from here; it lives in
 * `KERF` and the cut it makes is the truth. If the width ever has to be read
 * again, read it there.
 *
 * Four, which is what the three kerfs came out at on an ordinary window at the
 * opening frame -- so the screen arrives looking as it always did.
 */
export const PREVIEW_PX = 4

/**
 * How big a placed point is drawn: a radius IN PIXELS, held there at every
 * zoom.
 *
 * PIXELS RATHER THAN A FRACTION OF THE BLOCK, which is the same choice
 * `GRAB_PX` below already makes and for the same reason: a knot is somewhere to
 * put a finger, so it is a fact about a hand and a screen. It used to be two
 * hundredths of the block, which is about this size at the opening zoom and
 * then grows with everything else -- so leaning in to place a point finely made
 * the point itself cover the very detail being aimed at, and the reference
 * underneath it disappeared behind a row of dots. Zooming in is for working
 * more finely; furniture that magnifies with the work defeats it. See
 * `pixelsToWorld`.
 *
 * Eight is what the old fraction came out at on an ordinary window at the
 * opening frame, so nothing has changed about how the screen ARRIVES -- only
 * about what the wheel then does to it.
 */
export const KNOT_PX = 8
/** And the handles, which are the finer of the two things on screen. */
export const GRIP_PX = 5.5

/** How far a handle stands off its point when the curve through it is straight
 *  -- a fitted tangent of zero would put the grip inside the knot with nothing
 *  to take hold of. A fraction of the block, so it is grabbable at any zoom. */
const MIN_GRIP_REACH = 0.06

/**
 * How near the pointer has to come to take hold of something, in PIXELS.
 *
 * Pixels rather than block units, because it is a fact about a hand and a
 * screen rather than about the model: at any zoom the grab is the same size
 * under the finger. Twelve is the radius the gizmo and the ruler already use.
 */
export const GRAB_PX = 12

/**
 * How far the pointer may wander between press and release and still count as a
 * CLICK rather than a drag, in pixels.
 *
 * IT IS WHAT LETS ONE KNOT ANSWER TWO GESTURES. Pressing the first point of a
 * run has to be able to mean either "bridge the loop shut" or "move this
 * point", and the honest way to tell them apart is the one every pointer
 * interface uses: a press that goes nowhere is a click. Below this the point is
 * not moved AT ALL -- not moved and then put back -- so a hand that shook four
 * pixels while clicking closes the loop and leaves the drawing exactly as it
 * found it.
 *
 * Four, which is a third of `GRAB_PX`: comfortably more than a tremor and
 * comfortably less than an intended nudge, and small enough that a drag reads
 * as taking hold immediately rather than after a dead zone.
 */
const CLOSE_SLOP = 4

/** How many sides the closing ring is drawn with. Enough to read as a circle at
 *  the size it is drawn, which is a dozen pixels across. */
const CLOSE_RING_SIDES = 32

/* The ray, the plane and the projection that read a press as a place on the
   face went to `facePointer` the moment the mirror needed the same three: two
   copies of that arithmetic would agree exactly until one of them was fixed. */

/**
 * A flat ribbon `world` units wide, laid along a line on the face.
 *
 * The same offsetting `buildKerfWall` does, with the depth left out: a preview
 * is the wall seen end-on. Built here rather than borrowed from there because a
 * strip is not a solid -- it has two triangles per station and no caps, and
 * asking one function to be both would mean a flag deciding what it returns.
 *
 * ITS WIDTH IS IN WORLD UNITS AND THE BLOCK'S OWN STRETCH IS UNDONE, which is
 * the whole of what makes it possible to hold the line to a size on screen. The
 * line arrives in FACE coordinates -- fractions of the block, which is what the
 * cut is stored in -- and the group this is drawn in scales those by each side
 * of the stock separately. So a sideways step of a given length in face
 * coordinates is worth different amounts of world depending on which way it
 * points and how the block is proportioned: on a sheet, the same number is a
 * hair across and a hand up. Each station therefore divides by the world length
 * of its OWN sideways direction, which is `stretch` below, and the strip comes
 * out the same width all the way along on any stock.
 *
 * The old version took a width in face coordinates and skipped all of that,
 * which drew a diagonal line on a sheet as a wedge.
 */
export function ribbon(
  line: Pt[],
  face: FaceAxis,
  world: number,
  dims: [number, number, number]
): BufferGeometry | null {
  if (line.length < 2) return null
  const basis = faceBasis(face)
  const half = world / 2
  const positions: number[] = []

  // How much world one unit along the face's own u and v is worth. The two are
  // axis-aligned unit vectors, so this picks out the block's side along each.
  const along = (axis: Vector3) =>
    Math.abs(axis.x) * dims[0] + Math.abs(axis.y) * dims[1] + Math.abs(axis.z) * dims[2]
  const su = along(basis.u)
  const sv = along(basis.v)

  const sideways = (i: number): Pt => {
    const before = i > 0 ? ([line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]] as Pt) : null
    const after =
      i < line.length - 1 ? ([line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]] as Pt) : null
    const norm = (p: Pt): Pt => {
      const l = Math.hypot(p[0], p[1])
      return l > 0 ? [p[0] / l, p[1] / l] : [0, 0]
    }
    const a = before ? norm(before) : null
    const b = after ? norm(after) : null
    const dir = a && b ? norm([a[0] + b[0], a[1] + b[1]]) : (b ?? a ?? ([1, 0] as Pt))
    const use = Math.hypot(dir[0], dir[1]) > 0 ? dir : (a ?? b ?? ([1, 0] as Pt))
    return [-use[1], use[0]]
  }

  const edge = (i: number, s: 1 | -1) => {
    const side = sideways(i)
    // What half a world unit sideways IS, in face coordinates, pointing this
    // way on this block. Never zero: a station with no direction at all falls
    // back to one, which only a line of coincident points can reach.
    const stretch = Math.hypot(side[0] * su, side[1] * sv) || 1
    const step = (half / stretch) * s
    return faceToBlock(
      basis,
      [line[i][0] + side[0] * step, line[i][1] + side[1] * step],
      BLOCK_HALF + LIFT
    )
  }

  for (let i = 1; i < line.length; i += 1) {
    const a = edge(i - 1, 1)
    const b = edge(i - 1, -1)
    const c = edge(i, -1)
    const d = edge(i, 1)
    for (const p of [a, b, c, a, c, d]) positions.push(p.x, p.y, p.z)
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.computeVertexNormals()
  return geometry
}

/**
 * The ring drawn round the first knot when clicking it would close the loop: a
 * UNIT circle lying in the face's own plane, sized by `markScale` like every
 * other mark here.
 *
 * IT IS THE INVITATION, and it is drawn rather than written because there is
 * nowhere to write it. A knot that does two different things depending on
 * whether the press moves is a good gesture and an invisible one -- nothing
 * about a row of identical dots says the first is special, and a tooltip on a
 * dot in a 3D scene is not a thing this app has. A ring round the one knot that
 * closes the loop says which knot, and says it while the hand is over the face
 * rather than in a panel across the window.
 *
 * DRAWN AT EXACTLY `GRAB_PX`, which is the radius the press really catches at.
 * So the ring is the target rather than a decoration sitting near it: the
 * pointer is inside the circle exactly when a click would take.
 *
 * In the face's plane, which is why the basis is needed: a circle built in some
 * fixed plane and dropped on the block would be an edge-on line on four of the
 * six faces. Its two components lie along the face's own u and v, both
 * axis-aligned, so `markScale`'s per-axis divisor undoes the block's stretch
 * and it comes out round on a sheet as well as on a cube.
 */
export function closeRing(basis: { u: Vector3; v: Vector3; n: Vector3 }): BufferGeometry {
  const positions: number[] = []
  for (let i = 0; i < CLOSE_RING_SIDES; i += 1) {
    const a = (i / CLOSE_RING_SIDES) * Math.PI * 2
    // Depth zero: the ring lies in the plane, and the mesh's own position
    // carries it out to where the drawing sits.
    const p = faceToBlock(basis, [Math.cos(a), Math.sin(a)], 0)
    positions.push(p.x, p.y, p.z)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  return geometry
}

/** The straight stalk from a point out to one of its two handles -- and the one
 *  way anything on this screen draws a bare segment. `MirrorLayer` draws its
 *  axis with it. */
export function stalk(from: Vector3, to: Vector3): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([from.x, from.y, from.z, to.x, to.y, to.z]), 3)
  )
  return geometry
}

/** Decoration; nothing here is picked by the renderer -- see the note above. */
const noRaycast: Object3D['raycast'] = () => {}

/**
 * Where each of a point's two handles sits, in face coordinates.
 *
 * MIRRORED, which is the whole handle model: one stored offset, used forwards
 * out of the point and backwards into it, so the curve cannot kink and there is
 * no second handle to keep in step. Held out to a minimum reach when the fitted
 * tangent is short, because a grip drawn inside its own knot is a control
 * nobody can take hold of -- the direction is still the curve's own, only the
 * distance is the drawing's.
 */
export function handleEnds(at: Pt, handle: Pt): { out: Pt; back: Pt } {
  const l = Math.hypot(handle[0], handle[1])
  const reach = Math.max(l, MIN_GRIP_REACH)
  const dir: Pt = l > 0 ? [handle[0] / l, handle[1] / l] : [0, 1]
  return {
    out: [at[0] + dir[0] * reach, at[1] + dir[1] * reach],
    back: [at[0] - dir[0] * reach, at[1] - dir[1] * reach],
  }
}

/**
 * The camera's zoom, as a number React can draw with.
 *
 * The wheel writes `camera.zoom` directly -- the controls own it and nothing
 * re-renders when it moves -- so anything drawn at a size in pixels has to
 * watch it. Reported only when it CHANGES, which is the same bargain
 * `FaceWatch` strikes next door: read every frame, published on the frames
 * where the answer is different, so a still screen costs one comparison.
 */
function useZoom(): number {
  const camera = useThree((s) => s.camera)
  const [zoom, setZoom] = useState(camera.zoom)
  useFrame(() => {
    if (camera.zoom !== zoom) setZoom(camera.zoom)
  })
  return zoom
}

/**
 * What to scale a UNIT mark by so it comes out `px` pixels across, drawn inside
 * the block-space group.
 *
 * TWO TRANSFORMS TO UNDO, and they are undone here rather than by drawing the
 * marks somewhere else. The group carries the block's own scale, so a mark
 * inside it is stretched by whichever side of the stock it lies along -- three
 * divisions rather than one, which is also what stops a knot on a sheet coming
 * out as an ellipse. And the zoom decides how much world a pixel is worth. See
 * `pixelsToWorld`.
 */
export function markScale(
  px: number,
  zoom: number,
  dims: [number, number, number]
): [number, number, number] {
  const world = pixelsToWorld(px, zoom)
  return [world / dims[0], world / dims[1], world / dims[2]]
}

/** What the pointer took hold of on the way down. */
type Grab =
  | { kind: 'stroke' }
  | {
      kind: 'point'
      index: number
      /**
       * Where the press landed, on a knot whose click would open or close the
       * loop -- and absent on every other knot, which is what makes this the
       * flag as well as the anchor.
       *
       * Cleared the moment the pointer leaves `CLOSE_SLOP`, from which point
       * the gesture is an ordinary drag and can no longer close anything. So
       * the two readings are settled by the hand rather than by a mode, and
       * neither one has to be chosen in advance.
       */
      closing?: { x: number; y: number }
    }
  | { kind: 'handle'; index: number; side: 1 | -1 }
  | null

/**
 * The drawing, and the hands on it.
 *
 * Inside the canvas because both halves need the camera: the preview is drawn
 * in the scene, and the picking projects the block's own face back to the
 * pointer. It draws nothing at all with no tool in hand.
 */
export function CutLayer({ face, dims }: { face: FaceAxis; dims: [number, number, number] }) {
  // The block's own transform, as three numbers: block space is still the unit
  // cube, so a point in it is scaled by these and lifted by half the height.
  const [bw, bh, bd] = dims
  const scene = useSceneColors()
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  // What the wheel has done, watched rather than read once: everything below
  // that is drawn at a size in pixels is redrawn when this moves.
  const zoom = useZoom()

  /**
   * The row and the column a knot being dragged has just taken from its
   * neighbours, or nulls.
   *
   * DRAWN, because a snap nobody can see is a knot that jumps. The modelling
   * screen answers this with a word in the corner -- "Snapped to centre" -- and
   * that is the right answer for a solid caught on a feature somewhere in a
   * room. Here what was caught is a LINE, so the honest readout is the line
   * itself: a hairline down the face at the u the point took, across it at the
   * v, and both at once where a right angle turns.
   *
   * React state rather than the draft store, because it belongs to the gesture
   * rather than to the drawing: it is nothing the cut is made from and nothing
   * that should survive letting go. Written only when it changes, so a drag
   * along a neighbour's column costs one render at the moment it catches rather
   * than one per pointer move.
   */
  const [guide, setGuide] = useState<{ u: number | null; v: number | null }>({
    u: null,
    v: null,
  })

  // ONLY THE TWO THAT DRAW. Move is in the same field and is not a cutter: it
  // takes hold of a reference, and to this layer that is empty hands. Narrowed
  // once here rather than tested at each of the four places below, so there is
  // no route by which half of this file thinks a line is being drawn.
  const tool = useTools((s) => (isCutTool(s.laserTool) ? s.laserTool : null))
  const fit = useTools((s) => s.fitCurve)
  /* The mirror standing on the face being drawn on, or null. Subscribed to
     rather than read once, because swinging the axis has to redraw the preview
     under a line that is already down. See `mirrorOn`. */
  const mirror = useTools(mirrorOn(face))

  const draftFace = useCutDraft((s) => s.face)
  const stroke = useCutDraft((s) => s.stroke)
  const points = useCutDraft((s) => s.points)
  const handles = useCutDraft((s) => s.handles)
  const closed = useCutDraft((s) => s.closed)

  const grab = useRef<Grab>(null)

  /**
   * Take the tool up on the face the compass has settled on, and drop whatever
   * was being drawn when either changes.
   *
   * A LINE BELONGS TO ONE FACE -- it is a pair of numbers in that face's own
   * (u, v) and means something else entirely on any other -- so turning the
   * compass has to clear it. Keeping it would leave Apply willing to burn a
   * line the user can no longer see, which is the one failure here that would
   * destroy work rather than merely surprise.
   */
  useEffect(() => {
    if (tool === null) {
      useCutDraft.getState().clear()
      return
    }
    useCutDraft.getState().begin(face, tool)
  }, [tool, face.axis, face.sign])

  // The line the preview draws IS the line Apply cuts -- one function, so the
  // two cannot disagree about what is about to happen. See `draftLine`.
  /**
   * EVERY LINE THIS PRESS WILL BURN, which is the drawn one until a mirror is
   * standing on the face and is two or four of them after that.
   *
   * Through `draftCut`, which is the same call Apply makes -- see it for why
   * the preview and the cut cannot be allowed to work the question out
   * separately. It is also what makes a stroke wandering into a dimmed part of
   * the face show as ending at the axis: the clip happens here, so what is
   * drawn on screen is what is left of the line rather than what the hand did.
   */
  const cutting = useMemo(
    () =>
      draftCut(
        { kind: tool === 'points' ? 'points' : 'freehand', stroke, points, handles, closed },
        fit,
        mirror
      ),
    [tool, stroke, points, handles, closed, fit, mirror]
  )

  // Rebuilt when the wheel turns, since its width is now a number of pixels:
  // the strip is a few hundred triangles at most and the alternative is a
  // second transform hung off the mesh, which cannot hold a width constant
  // along a line that changes direction.
  const preview = useMemo(
    () =>
      draftFace
        ? cutting
            .map((one) => ribbon(one, draftFace, pixelsToWorld(PREVIEW_PX, zoom), dims))
            .filter((strip): strip is BufferGeometry => strip !== null)
        : [],
    [cutting, draftFace, zoom, dims]
  )
  useEffect(() => () => preview.forEach((strip) => strip.dispose()), [preview])

  // UNIT spheres: the size is on the mesh now, not in the geometry, because it
  // changes every time the wheel turns. See `markScale`.
  const knot = useMemo(() => new SphereGeometry(1, 12, 8), [])
  const grip = useMemo(() => new SphereGeometry(1, 10, 6), [])
  useEffect(
    () => () => {
      knot.dispose()
      grip.dispose()
    },
    [knot, grip]
  )

  // Per face rather than per frame: the ring lies in the face's own plane, and
  // the face only changes when the compass settles somewhere else -- which
  // clears the drawing anyway. See `closeRing`.
  const halo = useMemo(() => (draftFace ? closeRing(faceBasis(draftFace)) : null), [draftFace])
  useEffect(() => () => halo?.dispose(), [halo])

  /**
   * The pointer, as a place on the face -- or null when the ray runs parallel
   * to it, which only a camera that has left its axis can manage.
   *
   * The plane is the block's own face, in WORLD space: block space scaled by
   * the side and lifted so the block stands on the bed. Inverting that is the
   * whole of the arithmetic, and it is why nothing else here has to know the
   * size.
   */
  const toFace = (e: PointerEvent): Pt | null =>
    pointerToFace(e, camera, gl.domElement, face, dims)

  /** How far a face point lands from the pointer, in pixels. */
  const pixelsFrom = (at: Pt, e: PointerEvent): number =>
    facePixelsFrom(at, e, camera, gl.domElement, face, dims)

  /**
   * Where a knot should actually land, given where the pointer is and where the
   * other knots already are.
   *
   * READ FRESH FROM THE STORES AT THE MOMENT OF THE MOVE, all of it -- the
   * switch, the distance, the points -- because this runs inside listeners that
   * outlive the render they were made in. Subscribing to any of it here would
   * put the reach a drag obeys one render behind the panel that sets it.
   *
   * The point being moved is left OUT of its own peers: it is always exactly on
   * its own row, so leaving it in would pin the knot where it started and it
   * would refuse to move at all. `skip` is its index, or -1 for a knot that is
   * being placed and is not in the list yet.
   *
   * Off, the point is handed back untouched and the guide goes -- which is what
   * makes the switch in the bar a real switch rather than a mode inside the
   * arithmetic. See `pointSnap.ts`.
   */
  const settle = (at: Pt, skip: number): Pt => {
    const tools = useTools.getState()
    if (!tools.snap) {
      setGuide((was) => (was.u === null && was.v === null ? was : { u: null, v: null }))
      return at
    }
    const basis = faceBasis(face)
    const sides: [number, number] = [sideAlong(basis.u, dims), sideAlong(basis.v, dims)]
    const peers = useCutDraft
      .getState()
      .points.filter((_, i) => i !== skip)
    // `camera.zoom` rather than the watched `zoom` above: this is called from
    // listeners that outlive the render they were built in, and the effect
    // holding them deliberately does not re-run on the wheel -- tearing it down
    // mid-drag would drop the very gesture being snapped. The camera is the one
    // thing here that is always current.
    const held = snapToPeers(
      at,
      peers,
      faceTolerance(tools.laserSnapDistance, camera.zoom, sides)
    )
    setGuide((was) =>
      was.u === held.onU && was.v === held.onV ? was : { u: held.onU, v: held.onV }
    )
    return held.at
  }

  useEffect(() => {
    if (tool === null) return
    const el = gl.domElement

    const onDown = (e: PointerEvent) => {
      // Left button only. The wheel zooms and the right button is left alone,
      // the way they are everywhere else over a viewport.
      if (e.button !== 0) return
      const at = toFace(e)
      if (!at) return
      const draft = useCutDraft.getState()

      if (tool === 'freehand') {
        // One stroke is one line: a second press starts again rather than
        // adding a second run to the same cut.
        draft.strokeFrom(at)
        grab.current = { kind: 'stroke' }
      } else {
        // THE FINER TARGET WINS, and handles are finer than points: they are
        // smaller, they are drawn over the knots, and a press that landed on a
        // handle but moved the point under it would be the one gesture in this
        // tool that could not be undone by eye.
        // Handles exist only while the curve does -- a straight segment has no
        // tangent to aim -- and they are read through `curveHandles`, so a grip
        // is grabbed exactly where it is drawn whether the tangent is the
        // user's or still the fit's.
        if (useTools.getState().fitCurve) {
          // The same reading of the run the line itself is drawn from, loop and
          // all: a grip has to be grabbed where it is drawn, and on a closed
          // run the fit that draws it wraps round the seam. See `curveHandles`.
          const aim = curveHandles(draft.points, draft.handles, draft.closed)
          for (let i = 0; i < draft.points.length; i += 1) {
            const ends = handleEnds(draft.points[i], aim[i])
            if (pixelsFrom(ends.out, e) <= GRAB_PX) {
              grab.current = { kind: 'handle', index: i, side: 1 }
              break
            }
            if (pixelsFrom(ends.back, e) <= GRAB_PX) {
              grab.current = { kind: 'handle', index: i, side: -1 }
              break
            }
          }
        }
        if (!grab.current) {
          for (let i = 0; i < draft.points.length; i += 1) {
            if (pixelsFrom(draft.points[i], e) <= GRAB_PX) {
              // THE FIRST KNOT IS ALSO THE LOOP'S CATCH, and taking hold of it
              // does not decide which of the two this press is yet -- see
              // `closing` and `CLOSE_SLOP`. A click bridges the last point back
              // to it, or takes the bridge out again; a drag moves it, exactly
              // as a drag on any other knot does.
              //
              // Only where there is a loop to make or unmake: under three
              // points there is nothing to encircle, so the first knot is just
              // a knot and behaves like every other one.
              const catches = i === 0 && (draft.closed || draft.points.length >= 3)
              grab.current = {
                kind: 'point',
                index: i,
                ...(catches ? { closing: { x: e.clientX, y: e.clientY } } : null),
              }
              break
            }
          }
        }
        // Nothing under the pointer, so this is a new point at the end of the
        // line -- which is what a click on a bare face means for this tool.
        //
        // AND IT LANDS SNAPPED, on the same terms a dragged one does. Placing
        // is the same act as moving here -- the press that adds a point takes
        // hold of it -- so a click that lined up with the last knot and a drag
        // that lined up with it should not disagree, and a first placement that
        // ignored the neighbours would have to be nudged afterwards to get what
        // the click was already aiming at. Not in the list yet, so nothing is
        // skipped.
        if (!grab.current) {
          draft.addPoint(settle(at, -1))
          grab.current = { kind: 'point', index: draft.points.length }
        }
      }

      // Held on the WINDOW rather than by capturing the pointer: a stroke that
      // runs off the block, off the canvas, or off the window has to keep
      // being tracked, since the ends are carried to the border either way.
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
      e.preventDefault()
      // AND THE PRESS STOPS HERE, which is the one thing this listener has to
      // do besides start a line.
      //
      // The bar closes whichever tool panel is open on any press that lands
      // outside the bar, the island and the help screen -- see `NavBar` -- and
      // that is the right rule for every panel it was written for, all of which
      // are aimed with the controls inside them. This one is aimed by drawing
      // on the scene, and its Apply lives in the panel: without this, the first
      // stroke of every cut shut the panel holding the button that fires it, and
      // the tool could be used exactly once per reopening. The press is the
      // tool's own, so it is handled rather than passed on.
      e.stopPropagation()
    }

    const onMove = (e: PointerEvent) => {
      const held = grab.current
      if (!held) return
      const at = toFace(e)
      if (!at) return
      const draft = useCutDraft.getState()
      if (held.kind === 'stroke') {
        // A FREEHAND LINE DOES NOT SNAP, and that is not an omission. It is a
        // hand's line and is meant to read as one; a stroke that kept catching
        // on the knots of some earlier drawing would be a tremor the tool put
        // in rather than took out. The rope is this tool's steadying -- see
        // `freehandSmoothing`.
        draft.strokeTo(at, useTools.getState().freehandSmoothing * MAX_ROPE)
      } else if (held.kind === 'point') {
        if (held.closing) {
          // Inside the slop the knot is not moved at all, rather than moved and
          // put back: a click that shook is a click, and the drawing must come
          // out of it byte for byte as it went in.
          if (Math.hypot(e.clientX - held.closing.x, e.clientY - held.closing.y) <= CLOSE_SLOP) {
            return
          }
          // Past it, and this was a drag all along.
          held.closing = undefined
        }
        draft.movePoint(held.index, settle(at, held.index))
      } else {
        // NOR DOES A HANDLE. It aims the curve through a point rather than
        // saying where anything is, so there is no row or column of it to line
        // up with -- and pulling a tangent onto a neighbour's column would be
        // snapping a direction to a position.
        draft.moveHandle(held.index, at, held.side)
      }
    }

    const onUp = (e?: PointerEvent) => {
      const held = grab.current
      grab.current = null
      // A press that took the first knot and never left it is a CLICK on it,
      // and that is the gesture that bridges the loop shut -- or opens it
      // again, since one knot answering two things needs a way back.
      //
      // ONLY ON A REAL RELEASE. This same function is the cancel handler and
      // the effect's own teardown, and neither of those is the user saying
      // anything: a gesture the browser took away, or a tool put down mid-drag,
      // must not leave a loop behind it.
      if (e?.type === 'pointerup' && held?.kind === 'point' && held.closing) {
        useCutDraft.getState().toggleClosed()
      }
      // The guide belongs to the gesture, so it goes with it. What it was
      // showing is now visible in the drawing itself: two knots on a line.
      setGuide((was) => (was.u === null && was.v === null ? was : { u: null, v: null }))
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }

    el.addEventListener('pointerdown', onDown)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      onUp()
    }
  }, [tool, gl, camera, bw, bh, bd, face.axis, face.sign])

  if (tool === null || draftFace === null) return null
  const basis = faceBasis(draftFace)
  // A handle per point while the curve is on, and none at all while it is off.
  // It is not a mode any more -- see `fitCurve` -- so there is no third state in
  // which a curve is drawn with its tangents hidden: if the line bends, the
  // things that bend it are on screen and can be taken hold of.
  const showHandles = tool === 'points' && fit
  const aim = showHandles ? curveHandles(points, handles, closed) : []
  // Where a click on the first knot would do something, and so where the ring
  // that says so belongs. Only while the loop is OPEN: once it is shut the
  // bridge is on screen saying it, and a ring still inviting the click would be
  // furniture arguing with the drawing. The way back out is in the panel.
  const canClose = tool === 'points' && !closed && points.length >= 3

  return (
    // The block's own transform, so block-space marks land on the block. See
    // the note at the top of the file, and `Pieces`, which carries the same one.
    <group position={[0, bh / 2, 0]} scale={dims}>
      {/* The slot the cut is about to burn, drawn where it will be burned. */}
      {preview.map((strip, i) => (
        <mesh key={i} geometry={strip} raycast={noRaycast} renderOrder={2}>
          <meshBasicMaterial color={scene.in} toneMapped={false} depthTest={false} />
        </mesh>
      ))}

      {/* The points, in the colour material-being-taken-away wears everywhere
          else in this app: a knot on this line is a place the cut goes through.
          Drawn over everything, because a knot hidden behind the block it sits
          on is a knot nobody can aim. */}
      {tool === 'points' &&
        points.map((at, i) => (
          <mesh
            key={i}
            geometry={knot}
            raycast={noRaycast}
            renderOrder={4}
            position={faceToBlock(basis, at, BLOCK_HALF + LIFT)}
            scale={markScale(KNOT_PX, zoom, dims)}
          >
            <meshBasicMaterial color={scene.in} toneMapped={false} depthTest={false} />
          </mesh>
        ))}

      {/* WHERE THE LOOP CLOSES: a ring round the first knot, drawn while a
          click on it would bridge the line shut.

          IT IS THE ONLY THING ON SCREEN THAT COULD SAY IT. The gesture is one
          click on one dot, and a row of identical dots gives no reason to think
          the first of them is different from the rest -- so without this the
          feature is one a user finds by accident or not at all. Drawn at the
          radius the press actually catches at, so it is the target itself. See
          `closeRing` and `GRAB_PX`.

          In the accent, with the handles, because it is furniture rather than
          part of the line: nothing here is going to be burned. Over the knot it
          rings, so the block cannot hide it. */}
      {canClose && halo && (
        <lineLoop
          raycast={noRaycast}
          geometry={halo}
          renderOrder={5}
          position={faceToBlock(basis, points[0], BLOCK_HALF + LIFT)}
          scale={markScale(GRAB_PX, zoom, dims)}
        >
          <lineBasicMaterial color={scene.accent} toneMapped={false} depthTest={false} />
        </lineLoop>
      )}

      {/* WHAT THE KNOT IN HAND JUST CAUGHT: the row it took, the column it
          took, or both where a right angle turns.

          A LINE RATHER THAN A WORD, which is the one place this parts company
          with the modelling screen's readout. There a snap catches a feature of
          a solid -- a corner, a middle -- and "Snapped to centre" names it
          exactly. What is caught here is not a place but an ALIGNMENT, and the
          only honest way to show an alignment is to draw the line the two marks
          now share. It also says which of the two axes caught, which a word in
          the corner would have to spell out.

          Right across the face, edge to edge, rather than stopping at the knot
          it came from: the claim is about a whole row of the block, and a
          segment between two points would read as a preview of a cut that is
          not going to be made. In the accent, because it is furniture -- the
          same colour the handles wear, against the erase colour every mark that
          is part of the line is drawn in.

          Under the knots and over the preview, so a guide never hides the point
          being aimed. */}
      {tool === 'points' && (guide.u !== null || guide.v !== null) && (
        <group renderOrder={3}>
          {guide.u !== null && (
            <lineSegments
              raycast={noRaycast}
              geometry={stalk(
                faceToBlock(basis, [guide.u, -BLOCK_HALF], BLOCK_HALF + LIFT),
                faceToBlock(basis, [guide.u, BLOCK_HALF], BLOCK_HALF + LIFT)
              )}
            >
              <lineBasicMaterial color={scene.accent} toneMapped={false} depthTest={false} />
            </lineSegments>
          )}
          {guide.v !== null && (
            <lineSegments
              raycast={noRaycast}
              geometry={stalk(
                faceToBlock(basis, [-BLOCK_HALF, guide.v], BLOCK_HALF + LIFT),
                faceToBlock(basis, [BLOCK_HALF, guide.v], BLOCK_HALF + LIFT)
              )}
            >
              <lineBasicMaterial color={scene.accent} toneMapped={false} depthTest={false} />
            </lineSegments>
          )}
        </group>
      )}

      {/* And the handles, in the accent: they aim the curve rather than being
          part of it, which is the same difference the gizmo's arrows draw
          against the solid they move. Only in Manual, where they do something. */}
      {showHandles &&
        points.map((at, i) => {
          const ends = handleEnds(at, aim[i] ?? [0, 0])
          const out = faceToBlock(basis, ends.out, BLOCK_HALF + LIFT)
          const back = faceToBlock(basis, ends.back, BLOCK_HALF + LIFT)
          return (
            <group key={`h${i}`} renderOrder={3}>
              {/* `lineSegments` rather than `line`: the two draw the same
                  thing, and only one of them is not also an SVG element. */}
              <lineSegments raycast={noRaycast} geometry={stalk(back, out)}>
                <lineBasicMaterial color={scene.accent} toneMapped={false} depthTest={false} />
              </lineSegments>
              {[out, back].map((end, e) => (
                <mesh
                  key={e}
                  geometry={grip}
                  raycast={noRaycast}
                  position={end}
                  renderOrder={5}
                  scale={markScale(GRIP_PX, zoom, dims)}
                >
                  <meshBasicMaterial color={scene.accent} toneMapped={false} depthTest={false} />
                </mesh>
              ))}
            </group>
          )
        })}
    </group>
  )
}
