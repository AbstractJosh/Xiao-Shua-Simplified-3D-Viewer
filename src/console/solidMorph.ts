/**
 * Pure geometry for the two Solids rows whose icon is a FAMILY rather than one
 * shape: pyramids and prisms, either of which can be built on any of five base
 * polygons. Kept out of the component so it can be checked and previewed
 * without React, exactly as `ngon.ts` is.
 *
 * Nothing here draws a solid from scratch. A pyramid icon is an n-gon laid
 * flat, squashed by the camera's elevation and lifted to an apex; a prism icon
 * is the same n-gon twice, one rim above the other. The ring, the resampling
 * and the eased blend all come out of `ngon.ts`, which is what lets an icon
 * here morph between side counts the way the chip in Shapes does.
 *
 * What it does NOT borrow is the chip's rotation. A polygon drawn face-on wants
 * to rest on a flat edge; a polygon lying on the floor in perspective wants to
 * be turned off the axis instead -- so these get a ring of their own, built the
 * same way out of their own corners.
 */
import { angleRing, radiiAt } from './ngon'

export type MorphKind = 'pyramid' | 'prism'

const TWO_PI = Math.PI * 2

/** The counts both family rows offer, and the only ones the ring below samples. */
export const SOLID_SIDES = [3, 4, 5, 6, 8]

/**
 * The corners of a base polygon, turned a QUARTER of a step off the axis.
 *
 * Something has to be, and a quarter step is the turn that works for every
 * count at once. Leave a base square-on and its near and far corners line up
 * behind each other, putting two apex edges on one screen line -- a triangle
 * with a stray tick through it rather than a pyramid. Turn it a HALF step
 * instead and an even-sided base projects to a plain rectangle, which reads as
 * a tent. A quarter step provably lands on neither: a corner at the front and
 * one at the back can only coincide when the step divides 180 degrees, and
 * offsetting by a quarter of a step puts a corner there only for counts of the
 * form 4m+1, which have no opposite corner to collide with in the first place.
 */
function baseCorners(sides: number): number[] {
  const step = TWO_PI / sides
  return Array.from({ length: sides }, (_, i) => step / 4 + i * step)
}

/**
 * Every corner of every base the rows can place, in one ring. Between any two
 * neighbouring angles here no base has a corner, so each of them runs dead
 * straight across the gap and is reproduced exactly rather than approximated --
 * which is what lets a morph start and end on the real solid.
 */
const BASE_RING = angleRing(SOLID_SIDES.flatMap(baseCorners))

/** The icon canvas is 32x32, so every solid is drawn around its middle. */
const CENTRE = 16

type Body = {
  /**
   * Half the silhouette width EVERY count is normalised to. A square base
   * turned onto its corners is 1.4x narrower than a hexagon of the same
   * radius; left alone, the cycle would visibly swell and shrink as it ran,
   * and the row would look heavier at some counts than at others.
   */
  halfWidth: number
  /**
   * How far the base circle is flattened by the camera's elevation. One value
   * for both solids: they sit next to each other in the list, and a shared
   * horizon is the difference between two icons and one drawing style.
   */
  squash: number
  /** The apex, for a pyramid; the centre of the top rim, for a prism. */
  topY: number
  /** Centre of the base rim. */
  baseY: number
}

/**
 * Both are drawn TALLER AND NARROWER than the cube and the tetrahedron they
 * share the list with. A 4-sided prism is a cube and a 3-sided pyramid is a
 * tetrahedron -- the geometry really is identical, and those two solids already
 * have rows of their own. Proportion is what keeps the rows apart: a column and
 * a spire read as members of a family that can be any width, where the equal
 * sided rows read as the one solid they are.
 */
const BODY: Record<MorphKind, Body> = {
  pyramid: { halfWidth: 8, squash: 0.45, topY: 3.6, baseY: 23.8 },
  prism: { halfWidth: 7.5, squash: 0.45, topY: 7.8, baseY: 24.2 },
}

const wrap = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI

/**
 * Where a corner of a base lands in the ring.
 *
 * Every corner angle of every count these rows offer is a sample of that ring
 * by construction, so this is a lookup rather than an approximation -- which is
 * what lets an edge stay welded to the rim while the rim is still moving.
 */
function ringIndex(angle: number): number {
  const a = wrap(angle)
  let best = 0
  let closest = Infinity
  for (let i = 0; i < BASE_RING.length; i += 1) {
    const gap = Math.abs(BASE_RING[i] - a)
    const cyclic = Math.min(gap, TWO_PI - gap)
    if (cyclic < closest) {
      closest = cyclic
      best = i
    }
  }
  return best
}

/** The radius that gives this count the family's fixed silhouette width. */
function ringRadius(kind: MorphKind, sides: number): number {
  const widest = Math.max(...baseCorners(sides).map((a) => Math.abs(Math.cos(a))))
  return BODY[kind].halfWidth / widest
}

/** One count's base outline, sampled on the ring. */
export function iconRadii(kind: MorphKind, sides: number): number[] {
  return radiiAt(BASE_RING, sides, ringRadius(kind, sides), baseCorners(sides)[0])
}

/**
 * The outline `t` of the way from one base to another, eased out to match the
 * polygon chip. 0 and 1 land on the real polygons, because the ring samples
 * every corner of both.
 */
export function blendRadii(from: number[], to: number[], t: number): number[] {
  const eased = t * (2 - t)
  return from.map((r, i) => r + (to[i] - r) * eased)
}

const project = (angle: number, radius: number, centreY: number, squash: number) =>
  `${(CENTRE + Math.cos(angle) * radius).toFixed(2)},` +
  `${(centreY + Math.sin(angle) * radius * squash).toFixed(2)}`

/**
 * Screen y grows downward and the camera is above, so a corner with a positive
 * sine is on the NEAR side of the rim, and one with a negative sine is on the
 * far side, behind the body.
 */
const isNear = (angle: number) => Math.sin(angle) >= -1e-9

function rimPoints(radii: number[], centreY: number, squash: number, nearOnly = false): string {
  return BASE_RING.map((a, i) =>
    nearOnly && !isNear(a) ? '' : project(a, radii[i], centreY, squash)
  )
    .filter(Boolean)
    .join(' ')
}

export type IconEdge = {
  x1: number
  y1: number
  x2: number
  y2: number
  /** Behind the body: drawn faint, the way every other icon draws a back edge. */
  hidden: boolean
}

/**
 * The edges that make the solid a solid -- a prism's verticals, a pyramid's
 * apex spokes -- one per corner of the base.
 *
 * An edge is drawn solid if its corner is on the near side of the rim, or if it
 * reaches further left or further right than any near corner does. That second
 * clause is not a fudge: a corner nothing stands in front of IS the silhouette,
 * so its edge falls against the background however far back it sits. Odd counts
 * need it -- a pentagon's two widest corners both land just past the horizon --
 * and the hand-drawn pyramid this replaces made the same exception for the same
 * corner. It has to be asked once per side rather than on width alone: on a
 * turned base, the far corner carrying the left edge is often no wider than the
 * near corner carrying the right one.
 */
export function iconEdges(kind: MorphKind, sides: number, radii: number[]): IconEdge[] {
  const { squash, topY, baseY } = BODY[kind]
  const corners = baseCorners(sides)
  const nearReach = corners.filter(isNear).map((a) => Math.cos(a))
  const right = Math.max(...nearReach)
  const left = Math.min(...nearReach)
  return corners.map((angle) => {
    const r = radii[ringIndex(angle)]
    const x = CENTRE + Math.cos(angle) * r
    const y = baseY + Math.sin(angle) * r * squash
    const reach = Math.cos(angle)
    const silhouette = reach > right + 1e-9 || reach < left - 1e-9
    return {
      x1: kind === 'pyramid' ? CENTRE : x,
      y1: kind === 'pyramid' ? topY : y - (baseY - topY),
      x2: x,
      y2: y,
      hidden: !isNear(angle) && !silhouette,
    }
  })
}

export type IconFrame = {
  /** A prism's open top, which we look down into, so all of it is solid. */
  cap: string | null
  /** The base rim, closed and faint underneath... */
  base: string
  /** ...with its near half laid solid over that. */
  baseNear: string
  /**
   * One entry at rest, two mid-morph. The rims flow from any count to any other
   * because they are resampled onto one ring; the edges cannot, because three
   * verticals are not eight verticals moved a little. So the two sets cross-fade
   * instead, each standing on the rim as it is at that instant.
   */
  sets: { sides: number; edges: IconEdge[]; weight: number }[]
}

/** The icon `t` of the way from `from` sides to `to` sides. */
export function iconFrame(kind: MorphKind, from: number, to: number, t: number): IconFrame {
  const { squash, topY, baseY } = BODY[kind]
  const clamped = Math.min(1, Math.max(0, t))
  const radii =
    from === to
      ? iconRadii(kind, from)
      : blendRadii(iconRadii(kind, from), iconRadii(kind, to), clamped)
  const eased = clamped * (2 - clamped)
  const sets =
    from === to || eased <= 0
      ? [{ sides: from, edges: iconEdges(kind, from, radii), weight: 1 }]
      : eased >= 1
        ? [{ sides: to, edges: iconEdges(kind, to, radii), weight: 1 }]
        : [
            { sides: from, edges: iconEdges(kind, from, radii), weight: 1 - eased },
            { sides: to, edges: iconEdges(kind, to, radii), weight: eased },
          ]
  return {
    cap: kind === 'prism' ? rimPoints(radii, topY, squash) : null,
    base: rimPoints(radii, baseY, squash),
    baseNear: rimPoints(radii, baseY, squash, true),
    sets,
  }
}
