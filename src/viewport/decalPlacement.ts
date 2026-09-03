import type { Vec3 } from '../geometry/types'
import type { Corner, Face, Placement } from '../store/referenceStore'

/**
 * Where a reference image sits on the block, in arithmetic and nothing else.
 *
 * Pure, and separate from anything that draws, for the reason `latheView.ts` is
 * separate from the lathe: this is the part that can be WRONG in a way an eye
 * cannot catch -- a decal a millimetre off the face, a drag that walks the
 * picture off the edge, a top face whose "up" is the wrong way round -- and a
 * function with numbers in and numbers out is the only part of a 3D screen a
 * headless check can hold to account.
 *
 * THE BLOCK'S SHAPE IS ASSUMED IN EXACTLY ONE PLACE, `faceFrame`, and it is the
 * shape `LaserViewport` draws: a box standing ON the ground, centred on the
 * origin's footprint, so x and z run either side of nothing and y runs from the
 * bed up. Everything else here is expressed through that one function.
 */

/** The six faces, in the order the compass names its axes. */
export const FACES: Face[] = ['+x', '-x', '+y', '-y', '+z', '-z']

/**
 * A face, as a frame you can put a picture in.
 *
 * `u` and `v` are what RIGHT and UP mean when you are looking straight at that
 * face from outside it -- which is the only view this screen has, so they are
 * also what right and up mean on screen. That is what stops a drawing arriving
 * mirrored on the back face or lying on its side on the top one.
 */
export type FaceFrame = {
  /** Outward unit normal. */
  normal: Vec3
  /** Right, as seen from outside. */
  u: Vec3
  /** Up, as seen from outside. */
  v: Vec3
  /** The middle of the face, in world space. */
  centre: Vec3
  /** How far the face runs along u and along v. */
  uSpan: number
  vSpan: number
  /** The face's plane, as a distance along its own normal. */
  depth: number
}

/** The block's three sides, in scene units: width (x), height (y), depth (z). */
export type BlockDims = [number, number, number]

/**
 * The smallest a reference may be drawn: a millimetre, which is the smallest
 * anything in this app is allowed to be. Below that it is a mark rather than a
 * picture, and it cannot be got hold of again to make it bigger.
 */
export const MIN_DECAL = 0.01

/** How much of a face a freshly dropped image covers, along its longer side. */
const DROP_FILL = 0.6

/** How close to the edge a drop or a drag may take it. */
const EDGE_FILL = 0.98

export function faceFrame(face: Face, dims: BlockDims): FaceFrame {
  const [w, h, d] = dims
  switch (face) {
    // Looking at the right-hand face, "right" runs back along -z.
    case '+x':
      return { normal: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], centre: [w / 2, h / 2, 0], uSpan: d, vSpan: h, depth: w / 2 }
    case '-x':
      return { normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], centre: [-w / 2, h / 2, 0], uSpan: d, vSpan: h, depth: w / 2 }
    // The top, seen from above with the camera's own up: the screen's up is -z.
    case '+y':
      return { normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1], centre: [0, h, 0], uSpan: w, vSpan: d, depth: h }
    case '-y':
      return { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], centre: [0, 0, 0], uSpan: w, vSpan: d, depth: 0 }
    case '+z':
      return { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], centre: [0, h / 2, d / 2], uSpan: w, vSpan: h, depth: d / 2 }
    default:
      return { normal: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0], centre: [0, h / 2, -d / 2], uSpan: w, vSpan: h, depth: d / 2 }
  }
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Where a point on a face sits, as an offset from the middle of that face. */
export function faceOffset(point: Vec3, face: Face, dims: BlockDims): { u: number; v: number } {
  const frame = faceFrame(face, dims)
  const rel: Vec3 = [
    point[0] - frame.centre[0],
    point[1] - frame.centre[1],
    point[2] - frame.centre[2],
  ]
  return { u: dot(rel, frame.u), v: dot(rel, frame.v) }
}

/**
 * How big a picture of this shape lands, dropped on this face.
 *
 * Six tenths of the face along whichever side runs out first, and never past
 * the edge -- so a drop is a picture you can see all of and get hold of, on any
 * face of any block, without having to size it before you can read it.
 */
export function dropSize(face: Face, dims: BlockDims, aspect: number): { w: number; h: number } {
  const frame = faceFrame(face, dims)
  const ratio = aspect > 0 && Number.isFinite(aspect) ? aspect : 1
  let h = DROP_FILL * frame.vSpan
  let w = h * ratio
  if (w > DROP_FILL * frame.uSpan) {
    w = DROP_FILL * frame.uSpan
    h = w / ratio
  }
  return { w: Math.max(MIN_DECAL, w), h: Math.max(MIN_DECAL, h) }
}

/**
 * A centre pulled back onto the face.
 *
 * The picture stays wholly on the face it is stuck to: a reference hanging half
 * off the edge is a line you would follow into thin air. A picture too big for
 * its face is centred instead of being clamped to a corner, because there is no
 * offset that keeps it on and centring is the one answer that does not look
 * like a bug.
 */
export function clampCentre(
  u: number,
  v: number,
  w: number,
  h: number,
  face: Face,
  dims: BlockDims
): { u: number; v: number } {
  const frame = faceFrame(face, dims)
  const room = (span: number, size: number) => Math.max(0, (EDGE_FILL * span - size) / 2)
  const ru = room(frame.uSpan, w)
  const rv = room(frame.vSpan, h)
  return {
    u: Math.min(ru, Math.max(-ru, u)),
    v: Math.min(rv, Math.max(-rv, v)),
  }
}

/** The biggest a picture of this aspect may be drawn on this face. */
export function maxSize(face: Face, dims: BlockDims, aspect: number): { w: number; h: number } {
  const frame = faceFrame(face, dims)
  const ratio = aspect > 0 && Number.isFinite(aspect) ? aspect : 1
  let w = EDGE_FILL * frame.uSpan
  let h = w / ratio
  if (h > EDGE_FILL * frame.vSpan) {
    h = EDGE_FILL * frame.vSpan
    w = h * ratio
  }
  return { w, h }
}

/** The four corners, as the handles are drawn and as a grab names them. */
export const CORNERS: Corner[] = [
  { su: -1, sv: -1 },
  { su: 1, sv: -1 },
  { su: 1, sv: 1 },
  { su: -1, sv: 1 },
]

/**
 * A picture resized by one of its corners, with the opposite corner nailed
 * down.
 *
 * THE ANCHOR IS WHAT MAKES IT A CORNER PULL rather than a symmetric grow. Held
 * by the bottom right, the top left does not move -- which is how a drawing is
 * fitted to a feature on the block: you put one corner where it belongs and
 * drag the other until the picture is the right size. Growing about the middle
 * instead would walk both corners at once and never let either be placed.
 *
 * ITS OWN SHAPE IS KEPT, always. The pointer offers two distances from the
 * anchor and only one of them can be honoured, so the bigger claim wins: the
 * corner tracks the pointer along whichever axis has been pulled further and
 * lags on the other. A reference stretched out of its aspect is a drawing you
 * would cut wrong, which is not a thing this app lets a drag do.
 *
 * IT STOPS AT THE EDGE OF THE FACE, and the limit is measured FROM THE ANCHOR
 * rather than from the middle: the room to grow into is whatever lies between
 * the nailed corner and the far edge, in both directions at once, and the
 * tighter of the two is the one that binds. So the picture never hangs off,
 * and it never has to be nudged back on afterwards.
 *
 * NEVER INSIDE OUT. Dragging the pointer past the anchor and out the other side
 * makes the picture small and leaves it on the side it started, rather than
 * flipping it through the anchor -- the corner in hand keeps its name for the
 * whole gesture, which is what stops the handles swapping places under a
 * moving pointer.
 */
export function resizeFromCorner(
  placement: Placement,
  corner: Corner,
  pointer: { u: number; v: number },
  aspect: number,
  dims: BlockDims
): { u: number; v: number; w: number; h: number } {
  const ratio = aspect > 0 && Number.isFinite(aspect) ? aspect : 1
  const frame = faceFrame(placement.face, dims)

  // The corner that is NOT in hand, which is the one thing this gesture holds
  // still. Derived from the placement each time rather than remembered: it
  // comes out the same on every move, since the new centre is written back
  // around it.
  const anchorU = placement.u - (corner.su * placement.w) / 2
  const anchorV = placement.v - (corner.sv * placement.h) / 2

  // How far the anchor is from the edge the pull is heading for, along each
  // axis, expressed as a width so the two can be compared.
  const roomU = (EDGE_FILL * frame.uSpan) / 2 - corner.su * anchorU
  const roomV = ((EDGE_FILL * frame.vSpan) / 2 - corner.sv * anchorV) * ratio

  const want = Math.max(Math.abs(pointer.u - anchorU), Math.abs(pointer.v - anchorV) * ratio)
  const w = Math.max(MIN_DECAL, Math.min(want, roomU, roomV))
  const h = w / ratio

  return { u: anchorU + (corner.su * w) / 2, v: anchorV + (corner.sv * h) / 2, w, h }
}

/** A placement's four corners and its plane, in world space. */
export type DecalRect = {
  centre: Vec3
  normal: Vec3
  u: Vec3
  v: Vec3
  w: number
  h: number
  depth: number
  /** The corners, anticlockwise from bottom-left as seen from outside. */
  corners: [Vec3, Vec3, Vec3, Vec3]
}

/**
 * Where a placement actually is, against the block as it stands NOW.
 *
 * Re-derived rather than stored, which is the whole reason a placement holds an
 * offset from the middle of a face instead of a point in the world: the block
 * is resized under these all the time, and a picture in the middle of the front
 * face has to still be in the middle of it afterwards.
 */
export function placementRect(placement: Placement, dims: BlockDims): DecalRect {
  const frame = faceFrame(placement.face, dims)
  const { u, v } = clampCentre(
    placement.u,
    placement.v,
    placement.w,
    placement.h,
    placement.face,
    dims
  )
  const centre: Vec3 = [
    frame.centre[0] + frame.u[0] * u + frame.v[0] * v,
    frame.centre[1] + frame.u[1] * u + frame.v[1] * v,
    frame.centre[2] + frame.u[2] * u + frame.v[2] * v,
  ]
  const hw = placement.w / 2
  const hh = placement.h / 2
  const corner = (su: number, sv: number): Vec3 => [
    centre[0] + frame.u[0] * su * hw + frame.v[0] * sv * hh,
    centre[1] + frame.u[1] * su * hw + frame.v[1] * sv * hh,
    centre[2] + frame.u[2] * su * hw + frame.v[2] * sv * hh,
  ]
  return {
    centre,
    normal: frame.normal,
    u: frame.u,
    v: frame.v,
    w: placement.w,
    h: placement.h,
    depth: frame.depth,
    corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
  }
}

/**
 * How far off a face's plane a surface may be and still count as that face.
 *
 * A tolerance rather than an equality because the surface being tested is
 * triangles: a fragment on the plane can land a rounding error either side of
 * it, and a test with no slack in it strobes.
 *
 * A tenth of a millimetre. Tight enough that the new face a cut leaves inside
 * the block -- parallel to the one the picture is on, and the case this test
 * exists for -- never picks the picture up, since a cut that shallow would have
 * taken nothing off.
 */
export const PLANE_EPSILON = 0.001

/**
 * How far off its face the sheet the pointer reads references through stands.
 *
 * PROUD OF THE FACE, like the outline and the grips, because it is a thing
 * laid OVER the block rather than a part of it -- and by half the plane
 * tolerance, so that by this file's own test it is still on the face: a point
 * read off the sheet is within `PLANE_EPSILON` of the plane the picture is
 * painted on, exactly as a point read off the material would be. See
 * `faceBoard`.
 */
export const BOARD_LIFT = PLANE_EPSILON / 2

/**
 * The sheet the pointer reads one face through: the whole face, as it was
 * before the laser touched it, standing `BOARD_LIFT` proud of where it was.
 *
 * THE FACE THE STOCK ARRIVED WITH, NOT THE SURFACE THAT IS LEFT. A reference
 * is put down, slid and sized by pointing at the block, and for a long time
 * the block itself was what caught the pointer -- which was fine until the
 * laser had been through it. Over a hole a cut had opened there was nothing
 * under the pointer; a face a cut from another axis had taken clean away had
 * nothing under it anywhere; and the curved wall a freehand loop leaves is no
 * face a picture can lie flat on, so a press on it was refused. The drawing
 * was still there, hanging where the material had been -- see `DecalGhosts`
 * -- and could no longer be reached.
 *
 * So each face keeps a sheet of its own, invisible and exactly its own size,
 * and that is what the pointer is read against. It is a fact about the STOCK
 * -- three sides and a footprint, the same three numbers `faceFrame` reads --
 * and nothing the laser does moves it, which is the whole point: a picture
 * can be dropped over a hole, and one already straddling a gap can still be
 * taken hold of on either side of it.
 *
 * ITS OWN SIZE AND NO BIGGER, so that a pointer off the face is still off the
 * face: a drag let go beside the block is a drag abandoned, and a sheet that
 * ran past the edge would turn it into a drop.
 *
 * Pure, and next to `placementRect` rather than in the component that mounts
 * it, for the reason everything here is: whether a sheet stands exactly over
 * its face, the right way round and the right size, is a question of numbers
 * that an eye cannot settle on a block with nothing left under half of it.
 */
export type FaceBoard = {
  /** The middle of the sheet, in world space: the face's middle, lifted. */
  centre: Vec3
  /** The face's own frame, so a hit on the sheet reads through `faceOffset`. */
  normal: Vec3
  u: Vec3
  v: Vec3
  /** How far the sheet runs along u and along v: the face's own spans. */
  w: number
  h: number
}

export function faceBoard(face: Face, dims: BlockDims): FaceBoard {
  const frame = faceFrame(face, dims)
  return {
    centre: [
      frame.centre[0] + frame.normal[0] * BOARD_LIFT,
      frame.centre[1] + frame.normal[1] * BOARD_LIFT,
      frame.centre[2] + frame.normal[2] * BOARD_LIFT,
    ],
    normal: frame.normal,
    u: frame.u,
    v: frame.v,
    w: frame.uSpan,
    h: frame.vSpan,
  }
}

/**
 * Whether a point on a surface is under this placement's picture.
 *
 * The projection the shader does, in TypeScript, so the rule it applies can be
 * checked without a GPU: same plane, same side, inside the rectangle. It is
 * what makes the cut requirement true rather than hoped for -- material that
 * survives a cut is still on the plane and still inside the rectangle, so it
 * still carries its part of the picture, and material that has gone takes its
 * part with it.
 */
export function coversPoint(rect: DecalRect, point: Vec3, normal: Vec3): boolean {
  if (dot(normal, rect.normal) < 0.999) return false
  if (Math.abs(dot(point, rect.normal) - rect.depth) > PLANE_EPSILON) return false
  const rel: Vec3 = [
    point[0] - rect.centre[0],
    point[1] - rect.centre[1],
    point[2] - rect.centre[2],
  ]
  return Math.abs(dot(rel, rect.u)) <= rect.w / 2 && Math.abs(dot(rel, rect.v)) <= rect.h / 2
}

/**
 * Where in the picture a point on the surface falls: 0..1 across, 0..1 up.
 *
 * `v` counts DOWN the image, because that is the way a texture is read and the
 * way a canvas is drawn, and the frame's own `v` counts up the face. Flipping
 * it here rather than at each call site is what stops half the app drawing
 * references upside down.
 */
export function pointUv(rect: DecalRect, point: Vec3): { x: number; y: number } {
  const rel: Vec3 = [
    point[0] - rect.centre[0],
    point[1] - rect.centre[1],
    point[2] - rect.centre[2],
  ]
  return {
    x: dot(rel, rect.u) / rect.w + 0.5,
    y: 0.5 - dot(rel, rect.v) / rect.h,
  }
}
