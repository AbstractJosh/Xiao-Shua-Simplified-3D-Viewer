/**
 * THE FRONT DOOR'S LOOP, IN NUMBERS: the projection its solids are drawn in,
 * the faces of the prisms it shows, and the timeline that moves them. Kept out
 * of the component so every one of those can be checked without React -- the
 * same split as `ngon.ts` and `solidMorph.ts`, for the same reason.
 *
 * WHAT IT TELLS. A cube sits on the modelling grid. It stretches to three
 * high; two more cubes fly in and land either side of the top, making a T; a
 * cut plane slides in twice and takes the crossbar's corners off, leaving an
 * arrow pointing up. The camera swings round to the lathe's side view, a tool
 * grinds the arrow's wings and then its point away, and what is left is a
 * plain prism; then the Pull tool draws a rounded mass out of its top, with a
 * lip. The view fades back to the laser cutter's bed, a line is drawn round
 * the block a unit up -- below the mass, where the block is still square --
 * the beam burns along the line and everything above it drops away, and it is
 * a cube again. Thirteen seconds, then round once more. Every bench in the
 * app, in the order the screen tabs list them, and every tool does to the
 * shape what it does in the app: nothing here is a gesture the software
 * cannot make.
 *
 * PLAYFUL, AND NOT A CHARACTER. The cube overshoots when it stretches and the
 * T gives when the side cubes land; the blade slides a touch too far and comes
 * back; the cut goes off with a flash round its edge; the pulled wall swells
 * past its mark and settles; the offcuts tumble. What it never does is look
 * at anybody -- there is no face on it, no wink, nothing that asks to be
 * liked. The personality is in the timing, and the timing is quick: a move
 * takes a few tenths of a second, and the loop spends its time on beats
 * rather than on travel.
 *
 * ONE SOLID AT A TIME. From the moment the side cubes land until the lathe is
 * done, what is on show is a single prism -- the T, then the T with one
 * corner gone, then the arrow -- each a non-convex polygon extruded once, so
 * there is no seam where a cube was joined and none across the arrow where a
 * head would meet a stem. The stem that stretches at the start is hidden the
 * instant the cubes land and comes back when the lathe hands over, as the
 * square base under the mass.
 *
 * THE BASE STAYS SQUARE. The lathe would turn the whole piece round, and this
 * one does not: the pull reaches only the top, and the bottom unit and a
 * fifth is left as the box it was, so that the laser -- which cuts a unit up,
 * below where the mass begins -- leaves exactly the cube the loop starts on.
 *
 * ONE CLOCK. Every track below is written in seconds on the same thirteen-
 * second loop, and the component starts them all with one start time, so a
 * blade cannot drift away from the wedge it cuts. That is what a timeline in
 * seconds buys over percentages in a stylesheet: a beat can be moved by
 * editing one number, and the seam where the loop joins can be checked --
 * `seamOf` proves every track ends exactly where it began, which is the one
 * fault that would show every thirteen seconds forever.
 */

/** How long one pass takes, in seconds. */
export const LOOP = 13

/** Pixels per scene unit, in the drawing's own coordinates. */
export const UNIT = 64

/**
 * How much the whole drawing is scaled up on the page. The numbers below are
 * in the drawing's own units; the component scales the stage by this, so the
 * loop can be made bigger or smaller without a number here moving.
 */
export const STAGE_SCALE = 1.3

/**
 * Isometric: x runs down and to the right, z down and to the left, y straight
 * up. The camera sits at (+x, +y, +z), so the faces it sees are the top, the
 * one facing +z (the front-left) and the one facing +x (the front-right).
 */
const C = Math.cos(Math.PI / 6) * UNIT
const S = Math.sin(Math.PI / 6) * UNIT

export type V3 = readonly [number, number, number]
export type Pt = readonly [number, number]

/** A scene point on the page. */
export function iso([x, y, z]: V3): Pt {
  return [(x - z) * C, (x + z) * S - y * UNIT]
}

/**
 * The transform that lays a face flat in its own plane, so a rectangle drawn
 * in (along, up) units lands on the page as that face. The stem uses these
 * rather than fixed polygons because it has to STRETCH: a rectangle scaled in
 * its own frame is exactly a taller face, where a scaled polygon is not.
 */
export function faceMatrix(which: 'front' | 'right', at: number): string {
  // front: along = x at z = at. right: along = z at x = at, running the other
  // way across the page. Both: up = y, which the page counts downward.
  return which === 'front'
    ? `matrix(${C} ${S} 0 ${-UNIT} ${-at * C} ${at * S})`
    : `matrix(${-C} ${S} 0 ${-UNIT} ${at * C} ${at * S})`
}

/** Which way a face points, which is the only thing its shade depends on. */
export type Shade = 'top' | 'front' | 'right' | 'slant-l' | 'slant-r'

export type Face = { shade: Shade; points: Pt[] }

/**
 * A prism: a polygon in the x-y plane, counter-clockwise, pushed from z0 to
 * z1 -- and only the faces the camera can see, each as page points relative to
 * `pivot` so a group can be placed there and turned about it.
 *
 * IN THE ORDER THEY MUST BE DRAWN: the sides first and the front last. For a
 * convex prism it makes no difference, since its visible faces never overlap
 * on the page. For the T it is the whole point -- the crossbar's front face
 * hangs over the stem's right one, and drawn the other way round the stem
 * would show through the overhang. Two side faces of these shapes never
 * overlap each other, so their order among themselves is free.
 */
export function prism(poly: readonly Pt[], z0: number, z1: number, pivot: V3 = [0, 0, 0]): Face[] {
  const [ox, oy] = iso(pivot)
  const at = (x: number, y: number, z: number): Pt => {
    const [px, py] = iso([x, y, z])
    return [px - ox, py - oy]
  }
  const faces: Face[] = []
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]
    const [bx, by] = poly[(i + 1) % poly.length]
    // The outward normal of a counter-clockwise edge, and the camera sees a
    // face when that normal has any part along (1, 1, 1).
    const nx = by - ay
    const ny = ax - bx
    if (nx + ny <= 1e-9) continue
    const shade: Shade =
      Math.abs(nx) < 1e-9 ? 'top' : Math.abs(ny) < 1e-9 ? 'right' : nx < 0 ? 'slant-l' : 'slant-r'
    faces.push({
      shade,
      points: [at(ax, ay, z1), at(bx, by, z1), at(bx, by, z0), at(ax, ay, z0)],
    })
  }
  faces.push({ shade: 'front', points: poly.map(([x, y]) => at(x, y, z1)) })
  return faces
}

/** A polygon's points as the attribute wants them. */
export function pointsOf(points: readonly Pt[]): string {
  return points.map(([x, y]) => `${round(x)},${round(y)}`).join(' ')
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/* --- the shapes ------------------------------------------------------------

   Everything is one unit deep, from z = -1/2 to z = 1/2, and stands on y = 0.
   The stem is the one solid that is not a fixed polygon: it is a box one unit
   square whose height the timeline drives. */

export const Z0 = -0.5
export const Z1 = 0.5

/** The stem's top face at height 1; the timeline lifts it. */
export const STEM_TOP: readonly Pt[] = [
  iso([-0.5, 1, -0.5]),
  iso([0.5, 1, -0.5]),
  iso([0.5, 1, 0.5]),
  iso([-0.5, 1, 0.5]),
]

/** The two cubes that fly in, each a box drawn at the seat it lands on. */
export const CUBE_L: readonly Pt[] = [
  [-1.5, 2],
  [-0.5, 2],
  [-0.5, 3],
  [-1.5, 3],
]
export const CUBE_R: readonly Pt[] = [
  [0.5, 2],
  [1.5, 2],
  [1.5, 3],
  [0.5, 3],
]

/**
 * The three solids the T is, in turn, each as one polygon. The stem is part
 * of every one of them: that is what leaves no line where the cubes joined
 * and none where the head meets the stem.
 */
export const SOLID_T: readonly Pt[] = [
  [-0.5, 0],
  [0.5, 0],
  [0.5, 2],
  [1.5, 2],
  [1.5, 3],
  [-1.5, 3],
  [-1.5, 2],
  [-0.5, 2],
]

/** After the first cut: the left corner gone, along the plane through the
 *  top's centre and the bar's outer bottom corner. */
export const SOLID_PENT: readonly Pt[] = [
  [-0.5, 0],
  [0.5, 0],
  [0.5, 2],
  [1.5, 2],
  [1.5, 3],
  [0, 3],
  [-1.5, 2],
  [-0.5, 2],
]

/** And after the second: the arrow. */
export const SOLID_ARROW: readonly Pt[] = [
  [-0.5, 0],
  [0.5, 0],
  [0.5, 2],
  [1.5, 2],
  [0, 3],
  [-1.5, 2],
  [-0.5, 2],
]

/** What each cut takes off. */
export const OFFCUT_L: readonly Pt[] = [
  [-1.5, 2],
  [0, 3],
  [-1.5, 3],
]
export const OFFCUT_R: readonly Pt[] = [
  [1.5, 2],
  [1.5, 3],
  [0, 3],
]

/**
 * How tall the prism is once the lathe has been at it.
 *
 * The side pass takes the wings off at the stem's own radius, and the
 * arrowhead's slope reaches that radius a third of the way down from the point
 * -- so the roof the facing pass then removes is the top third of the head.
 */
export const LATHED_HEIGHT = 2 + 2 / 3

/** Where the pulled mass begins: above it the piece is turned, below it the
 *  box is left alone. */
export const BULB_BASE = 1.2

/** What the laser takes off of the box: the sliver between its line and the
 *  mass's base. The mass itself goes with it, drawn separately. */
export const OFFCUT_SLICE: readonly Pt[] = [
  [-0.5, 1],
  [0.5, 1],
  [0.5, BULB_BASE],
  [-0.5, BULB_BASE],
]

/** Where the falling pieces turn about: near enough their middles. */
export const PIVOT_OFFCUT_L: V3 = [-1, 2 + 2 / 3, 0]
export const PIVOT_OFFCUT_R: V3 = [1, 2 + 2 / 3, 0]
export const PIVOT_OFFCUT_LASER: V3 = [0, 1.9, 0]

/**
 * The cut plane, as the square blade the modelling screen draws for one: it
 * holds the line from the top's centre to the bar's outer corner and runs the
 * block's depth, and is drawn a little larger than either so it reads as a
 * blade passing through rather than a patch on the surface.
 *
 * IN TWO PARTS, because it is INSIDE the block. What is within the block's
 * reach -- `under`: behind its front plane and below its top -- is drawn
 * under the solids, so wherever the block stands in front of it the block
 * wins and the blade is simply not seen: as it slides down its line it is
 * swallowed, and only what sticks out past the ends stays in view. What
 * nothing in the block can stand in front of -- `over`: the strip in front
 * of the front plane, and the end of the plane that rises above the top --
 * is drawn over everything. Drawn whole and on top it read as a card lying
 * on the surface; this is the difference between a plane on a block and a
 * plane through one.
 *
 * THE TOP IS THE BOUNDARY THAT WAS MISSED FIRST. Split by depth alone, the
 * end of the plane above the block fell inside the top face's outline on the
 * page and was hidden by it, though it is above the block and not behind it
 * -- the plane looked cut off at the top. Splitting at y = 3 as well puts
 * that end on top, and the seam between the two parts is then exactly the
 * line the plane makes across the top face, which is the mark that says a
 * plane is passing through.
 *
 * WITH ITS ARROW, on the front strip. The left plane is very nearly edge-on
 * to this camera -- its normal leans away from the eye -- so the strip alone
 * is a sliver, and a sliver could be a line on the surface. The arrow off it,
 * along the normal and towards the corner that comes off, is what says it is
 * a plane with a side; it is the same mark the modelling screen's gizmo
 * carries, for the same reason.
 *
 * AND WHERE IT COMES FROM. It slides into place along its own plane, down
 * the line of the cut from above the top's centre, and never turns: a plane
 * that arrives by rotating reads as a card being flipped, where one that
 * slides in reads as a blade going in. `slide` is that run, on the page.
 *
 * ONE OUTLINE, THOUGH TWO FILLS. The two parts meet along two seams -- the
 * front face's plane, and the block's top -- and a stroke round each part
 * would draw both seams as lines across the blade, which is a plane and has
 * no lines across it. So the fills carry no stroke, and the outline is drawn
 * apart, as two open runs along the blade's real edges only: `overEdge`
 * round the far end, the near side and the top, `underEdge` along the far
 * side and the near end. They meet end to end and read as one square.
 *
 * `section` is the cut itself: the rectangle where the plane meets the
 * block, whose edge the flash runs round. `perimeter` is its length on the
 * page, in the drawing's units, for the dash that draws it.
 */
export function blade(side: -1 | 1): {
  pivot: V3
  under: Pt[]
  over: Pt[]
  underEdge: Pt[]
  overEdge: Pt[]
  section: Pt[]
  perimeter: number
  arrow: { base: Pt; tip: Pt; head: Pt[] }
  slide: Pt
} {
  const pivot: V3 = [side * 0.75, 2.5, 0]
  const [ax, ay] = [side * 1.5, -1]
  const len = Math.hypot(ax, ay)
  const [ox, oy] = iso(pivot)
  const rel = (c: V3): Pt => {
    const [x, y] = iso(c)
    return [x - ox, y - oy]
  }
  // A point of the plane by how far along the cut it is from the pivot, and
  // how deep. The cut runs from the top's centre outward and down, so along
  // it negative is towards the top and beyond.
  const at = (s: number, z: number): Pt => rel([pivot[0] + (ax / len) * s, pivot[1] + (ay / len) * s, z])
  const reach = 1.15
  const deep = 0.9
  // Where the plane passes the block's top: y = 3, a little short of the end
  // that overhangs the top's centre.
  const top = (3 - pivot[1]) / (ay / len)
  const under: Pt[] = [at(top, -deep), at(reach, -deep), at(reach, Z1), at(top, Z1)]
  const over: Pt[] = [at(-reach, -deep), at(top, -deep), at(top, Z1), at(reach, Z1), at(reach, deep), at(-reach, deep)]
  const underEdge: Pt[] = [at(top, -deep), at(reach, -deep), at(reach, Z1)]
  const overEdge: Pt[] = [at(top, -deep), at(-reach, -deep), at(-reach, deep), at(reach, deep), at(reach, Z1)]
  // The normal is the cut's own direction turned a quarter, and it points
  // outward, up and to the side: at the offcut rather than the stem.
  const [nx, ny] = [(-ay / len) * side, (ax / len) * side]
  const arrowZ = 0.7
  const base = rel([pivot[0], pivot[1], arrowZ])
  const tip = rel([pivot[0] + nx * 0.6, pivot[1] + ny * 0.6, arrowZ])
  const [dx, dy] = [tip[0] - base[0], tip[1] - base[1]]
  const tipLen = Math.hypot(dx, dy)
  const [tx, ty] = [dx / tipLen, dy / tipLen]
  // Back up the cut's line by a good length: from there the blade slides down
  // the line, through the top's centre, into the block.
  const slide = rel([pivot[0] - (ax / len) * 1.7, pivot[1] - (ay / len) * 1.7, 0])
  const section: Pt[] = [rel([0, 3, Z1]), rel([ax, 2, Z1]), rel([ax, 2, Z0]), rel([0, 3, Z0])]
  let perimeter = 0
  for (let i = 0; i < section.length; i++) {
    const [x0, y0] = section[i]
    const [x1, y1] = section[(i + 1) % section.length]
    perimeter += Math.hypot(x1 - x0, y1 - y0)
  }
  return {
    pivot,
    under,
    over,
    underEdge,
    overEdge,
    section,
    perimeter: round(perimeter),
    arrow: {
      base,
      tip,
      head: [tip, [tip[0] - tx * 8 + ty * 4.5, tip[1] - ty * 8 - tx * 4.5], [tip[0] - tx * 8 - ty * 4.5, tip[1] - ty * 8 + tx * 4.5]],
    },
    slide,
  }
}

/**
 * The laser's line: round the front face and the right one, a unit up, which
 * is the path the beam follows and the length the draw-on is measured in.
 */
export const CUT_PATH_POINTS: Pt[] = [iso([-0.5, 1, 0.5]), iso([0.5, 1, 0.5]), iso([0.5, 1, -0.5])]
export const CUT_PATH = `M ${round(CUT_PATH_POINTS[0][0])} ${round(CUT_PATH_POINTS[0][1])} L ${round(CUT_PATH_POINTS[1][0])} ${round(CUT_PATH_POINTS[1][1])} L ${round(CUT_PATH_POINTS[2][0])} ${round(CUT_PATH_POINTS[2][1])}`
export const CUT_PATH_LENGTH = round(2 * Math.hypot(C, S))

/** A point along that line, by how far along it is. */
export function alongCut(f: number): Pt {
  const [a, b, c] = CUT_PATH_POINTS
  return f < 0.5
    ? [a[0] + (b[0] - a[0]) * f * 2, a[1] + (b[1] - a[1]) * f * 2]
    : [b[0] + (c[0] - b[0]) * (f - 0.5) * 2, b[1] + (c[1] - b[1]) * (f - 0.5) * 2]
}

/** The ground grid: a line every half unit, the whole ones drawn heavier. */
export const GRID_REACH = 2
export const GRID_STEP = 0.5

/** The laser cutter's bed, the flat slab the block stands on while it is cut. */
export const BED: readonly Pt[] = [
  [-1.7, -0.14],
  [1.7, -0.14],
  [1.7, 0],
  [-1.7, 0],
]
export const BED_Z0 = -1.7
export const BED_Z1 = 1.7

/* --- the pulled mass -------------------------------------------------------

   What the Pull tool makes of the prism's top: a wall that swells out to
   twice its radius, comes back in to a neck, and flares at the very top into
   a lip. The profile is a curve of radius against height, and everything
   drawn of the mass -- the side view's outline, the isometric view's
   silhouette and its top -- is computed from that one curve, so the two views
   cannot disagree about the shape. */

/**
 * The profile as control points: how far up the mass (0 at its base, 1 at
 * its top) against radius. A cardinal spline through these gives the curve;
 * the two tables differ only in the last points, which are the lip.
 *
 * SHAPED TO READ THE SAME FROM BOTH CAMERAS. The side view sees the profile
 * as it is. The isometric view looks down on it from thirty-five degrees,
 * and from there a flat top of radius r hides everything within 0.7 r below
 * it -- so a wide lip over a short neck showed, in that view, as a ball with
 * a lid, while the side view showed a vase. Hence: the swell low, a long neck
 * above it, and a small lip on a small top, so that the narrowing is in
 * plain sight before the rim's near edge takes over. The flare off the base
 * is quick for the same reason: the round base is inscribed in the square
 * top it stands on, and the faster it grows past the square's corners the
 * less of them shows.
 */
const BULB_SHAPE: readonly Pt[] = [
  [0, 0.5],
  [0.08, 0.62],
  [0.2, 0.86],
  [0.32, 1.01],
  [0.42, 1.05],
  [0.58, 0.9],
  [0.72, 0.58],
  [0.84, 0.43],
  [0.93, 0.42],
  [1, 0.44],
]
const LIP_SHAPE: readonly Pt[] = [
  [0, 0.5],
  [0.08, 0.62],
  [0.2, 0.86],
  [0.32, 1.01],
  [0.42, 1.05],
  [0.58, 0.9],
  [0.72, 0.58],
  [0.84, 0.43],
  [0.92, 0.43],
  [1, 0.5],
]

/** How many heights the profile is sampled at. Every state of the profile
 *  has this many, which is what lets one morph into another. */
const PROFILE_SAMPLES = 24

/** The spline through the control points, at one height. Hermite with the
 *  tangent at each point taken from its neighbours: smooth, and a table of
 *  eight points is enough to say the whole shape. */
function splineAt(points: readonly Pt[], u: number): number {
  const n = points.length
  let i = 0
  while (i < n - 2 && u > points[i + 1][0]) i++
  const [u0, r0] = points[i]
  const [u1, r1] = points[i + 1]
  const h = u1 - u0
  const t = Math.min(1, Math.max(0, (u - u0) / h))
  const slope = (a: number, b: number) => (points[b][1] - points[a][1]) / (points[b][0] - points[a][0])
  const m0 = (i === 0 ? slope(0, 1) : slope(i - 1, i + 1)) * h
  const m1 = (i + 2 >= n ? slope(n - 2, n - 1) : slope(i, i + 2)) * h
  const t2 = t * t
  const t3 = t2 * t
  return (2 * t3 - 3 * t2 + 1) * r0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * r1 + (t3 - t2) * m1
}

/** A profile: height and radius at each sample, base to top. */
export type Profile = readonly Pt[]

/**
 * The profile a table gives, with its swell scaled by `gain` about the box's
 * own radius: 0 is the untouched prism, 1 the shape as drawn, and a little
 * over 1 is the wall having gone past its mark.
 */
export function profileOf(shape: readonly Pt[], gain: number): Profile {
  const out: Pt[] = []
  for (let k = 0; k < PROFILE_SAMPLES; k++) {
    const u = k / (PROFILE_SAMPLES - 1)
    const r = 0.5 + (splineAt(shape, u) - 0.5) * gain
    out.push([BULB_BASE + u * (LATHED_HEIGHT - BULB_BASE), Math.max(0.5, r)])
  }
  return out
}

/** The four states the pulled wall passes through. */
export const PROFILE_RECT = profileOf(BULB_SHAPE, 0)
export const PROFILE_OVER = profileOf(BULB_SHAPE, 1.15)
export const PROFILE_BULB = profileOf(BULB_SHAPE, 1)
export const PROFILE_LIP = profileOf(LIP_SHAPE, 1)

/**
 * The side view's outline of the whole piece for a profile: the box up to the
 * mass's base, the profile up one side and down the other, the box down
 * again. Every state has the same run of commands, so the browser can carry
 * one into the next.
 */
export function sidePath(profile: Profile): string {
  const parts: string[] = [`M ${round(-0.5 * UNIT)} 0`, `L ${round(-0.5 * UNIT)} ${round(-BULB_BASE * UNIT)}`]
  for (const [y, r] of profile) parts.push(`L ${round(-r * UNIT)} ${round(-y * UNIT)}`)
  for (let i = profile.length - 1; i >= 0; i--) {
    const [y, r] = profile[i]
    parts.push(`L ${round(r * UNIT)} ${round(-y * UNIT)}`)
  }
  parts.push(`L ${round(0.5 * UNIT)} ${round(-BULB_BASE * UNIT)}`, `L ${round(0.5 * UNIT)} 0`, 'Z')
  return parts.join(' ')
}

/**
 * The isometric view's silhouette of the mass for a profile.
 *
 * A circle of radius r at height y projects to an ellipse about the axis's
 * point at that height, r * sqrt(2) * C wide and r * sqrt(2) * S tall; the
 * solid is the stack of those circles, so its picture is the UNION of those
 * ellipses, exactly. That makes the outline a simple thing to find: for each
 * row of the page, it is as far out as the widest ellipse crossing that row.
 * Walk the rows down the left side and back up the right and the outline is
 * closed, and it cannot fold back on itself the way an outline traced ring by
 * ring did -- where a wall's slope changed quickly, that one zigzagged into
 * facets, and where the lip overhung the neck it grew ears.
 *
 * The rim's near edge and the waist above the swell come out of this on
 * their own: the top ring's ellipse reaches lower on the page than the neck's
 * do, so the rim is seen from above, and the neck shows between the two only
 * where it is wider than the rim's ellipse is at that row. Which is what the
 * eye would see.
 */
export function bulbSilhouette(profile: Profile, pivot: V3 = [0, 0, 0]): Pt[] {
  const [ox, oy] = iso(pivot)
  const ka = Math.SQRT2 * C
  const kb = Math.SQRT2 * S
  // The rings, resampled finely between the profile's own samples so the
  // outline between two of them is a curve and not a chord.
  const rings: { cy: number; a: number; b: number }[] = []
  for (let i = 0; i < profile.length - 1; i++) {
    const [y0, r0] = profile[i]
    const [y1, r1] = profile[i + 1]
    for (let k = 0; k < 3; k++) {
      const f = k / 3
      const r = r0 + (r1 - r0) * f
      rings.push({ cy: -(y0 + (y1 - y0) * f) * UNIT, a: ka * r, b: kb * r })
    }
  }
  const [yTop, rTop] = profile[profile.length - 1]
  rings.push({ cy: -yTop * UNIT, a: ka * rTop, b: kb * rTop })
  const top = Math.min(...rings.map((ring) => ring.cy - ring.b))
  const bottom = Math.max(...rings.map((ring) => ring.cy + ring.b))
  const widthAt = (y: number): number => {
    let x = 0
    for (const { cy, a, b } of rings) {
      const f = (y - cy) / b
      if (f > -1 && f < 1) x = Math.max(x, a * Math.sqrt(1 - f * f))
    }
    return x
  }
  const step = 1.5
  const rows: number[] = []
  for (let y = top; y < bottom; y += step) rows.push(y)
  rows.push(bottom)
  const left: Pt[] = rows.map((y): Pt => [-widthAt(y) - ox, y - oy])
  const right: Pt[] = rows.map((y): Pt => [widthAt(y) - ox, y - oy]).reverse()
  return [...left, ...right]
}

/** The mass's flat top: the ellipse its top circle projects to. */
export function bulbTop(profile: Profile, pivot: V3 = [0, 0, 0]): Pt[] {
  const [ox, oy] = iso(pivot)
  const [y, r] = profile[profile.length - 1]
  const points: Pt[] = []
  for (let k = 0; k < 28; k++) {
    const t = (k / 28) * Math.PI * 2
    points.push([Math.SQRT2 * C * r * Math.cos(t) - ox, -y * UNIT + Math.SQRT2 * S * r * Math.sin(t) - oy])
  }
  return points
}

/* --- the side view ---------------------------------------------------------

   The lathe's screen is a side view in scene units with the piece standing on
   its faceplate, so this is the same drawing at the same scale: x across the
   page, y up it, the faceplate on y = 0. */

/** A side-view point on the page. */
export function flat([x, y]: Pt): Pt {
  return [x * UNIT, -y * UNIT]
}

/** The stem and the part of the head inside its radius: what survives the lathe. */
export const CORE_2D: readonly Pt[] = [
  [-0.5, 0],
  [0.5, 0],
  [0.5, LATHED_HEIGHT],
  [-0.5, LATHED_HEIGHT],
]
/** The wings outside that radius, which the side pass takes. */
export const WING_L_2D: readonly Pt[] = [
  [-1.5, 2],
  [-0.5, 2],
  [-0.5, LATHED_HEIGHT],
]
export const WING_R_2D: readonly Pt[] = [
  [0.5, 2],
  [1.5, 2],
  [0.5, LATHED_HEIGHT],
]
/** The point above it, which the facing pass takes. */
export const ROOF_2D: readonly Pt[] = [
  [-0.5, LATHED_HEIGHT],
  [0.5, LATHED_HEIGHT],
  [0, 3],
]

/** The tool's radius on the page, and where it sits for each pass. */
export const TOOL_R = 0.24 * UNIT
const TOOL_SIDE_X = 0.5 * UNIT + TOOL_R - 1
/**
 * The side pass starts just above the wings rather than at the point. At the
 * stem's radius the tool clears the whole of the roof, so a pass from the top
 * would spend its first third cutting air; starting where the material is
 * makes the pass the length of the cut.
 */
export const TOOL_SIDE_Y0 = -2.8 * UNIT
const TOOL_SIDE_Y1 = -2 * UNIT
const TOOL_TOP_Y = -LATHED_HEIGHT * UNIT - TOOL_R + 1

/** Where the Pull tool works: level with the swell's widest point, and then
 *  level with the lip. The wall comes to the tool and never past it, so the
 *  tool sits a radius outside wherever the wall is meant to reach. */
const SWELL_AT = 0.42
const PULL_Y = -(BULB_BASE + SWELL_AT * (LATHED_HEIGHT - BULB_BASE)) * UNIT
/** The sample nearest the swell, for reading the wall's radius there. */
const SWELL_SAMPLE = Math.round(SWELL_AT * (PROFILE_SAMPLES - 1))
const LIP_Y = -(LATHED_HEIGHT - 0.04) * UNIT
const pullX = (radius: number) => radius * UNIT + TOOL_R - 1

/* --- the timeline ----------------------------------------------------------

   A track is a name and a list of keys; a key is a time in seconds, the
   properties that hold from then, and how the run to the NEXT key is eased.
   Two keys at the same time are a jump. The component finds every element
   marked with the track's name and gives it these keys, so one track can
   drive several elements -- both of the stem's faces stretch on one.

   THE BEATS, so a number below can be placed:
     0.0  rest             2.3  cubes land, one T   3.5  first cut
     0.7  stretch          2.7  blade slides in     4.7  second cut
     1.7  cubes fly in     5.4  swing to the lathe  6.3  side pass
     7.2  facing pass      8.3  the pull            9.05 the lip
     9.5  fade back       10.0  line drawn         10.6  the beam burns
    11.4  top comes off   12.1  grid returns */

export type Props = {
  opacity?: number
  transform?: string
  offsetDistance?: string
  strokeDashoffset?: number
  d?: string
}
export type Key = readonly [at: number, props: Props, easing?: string]
export type Track = { name: string; keys: readonly Key[] }

const OUT = 'cubic-bezier(0.2, 0.8, 0.3, 1)'
const IN = 'cubic-bezier(0.6, 0, 0.9, 0.5)'
const INOUT = 'ease-in-out'
const LINEAR = 'linear'

/** The moments the two cuts go off, which several tracks are hung on. */
const CUT_L = 3.5
const CUT_R = 4.7

/** When the side cubes land and the stem gives way to the one-piece T. */
const LAND = 2.3

/** When the facing pass is done and the prism is a prism. */
const FACED = 7.8

/** When the Pull tool takes hold of the wall. */
const PULL = 8.3

/** When the view starts fading back to the laser cutter. */
const RETURN = 9.5

/** How long that fade takes. */
const FADE = 0.4

/** When the laser's line starts to draw, and when the beam sets off. */
const LINE = 10.0
const BURN = 10.6

/** When the laser's top comes away. */
const SEVER = 11.4

/**
 * The stem's height through the loop, in units. Both of its faces scale to
 * this and its top rises with it, so the three are written once.
 *
 * The overshoot at 1.25 is the animation's whole manner: a thing that
 * stretches goes a little too far and comes back. It is hidden from the
 * landing to the return -- the one-piece solids stand in for it -- and what
 * comes back is the square base under the pulled mass, so the jump to that
 * height happens where nobody can see it.
 */
const HEIGHT: readonly (readonly [number, number, string?])[] = [
  [0, 1],
  [0.7, 1, OUT],
  [1.25, 3.35, INOUT],
  [1.6, 3],
  [6.0, 3],
  [6.0, BULB_BASE],
  // The laser: the top comes away and the cube under it settles, with a
  // squash for the weight coming off.
  [SEVER, BULB_BASE],
  [SEVER, 1, OUT],
  [SEVER + 0.1, 0.84, OUT],
  [SEVER + 0.25, 1.1, OUT],
  [SEVER + 0.4, 0.97, OUT],
  [SEVER + 0.5, 1],
  [LOOP, 1],
]

function heightTrack(name: string, value: (h: number) => string): Track {
  return {
    name,
    keys: HEIGHT.map(([at, h, easing]) => [at, { transform: value(h) }, easing] as Key),
  }
}

/** A side cube's flight in, mirrored for the right one. It is gone the moment
 *  it lands, because from then on the T is one solid. */
function cubeTrack(name: string, side: -1 | 1): Track {
  const far = `translate(${side * 460}px, -60px)`
  return {
    name,
    keys: [
      [0, { opacity: 0, transform: far }],
      [1.7, { opacity: 0, transform: far }],
      [1.7, { opacity: 1, transform: far }, OUT],
      [2.0, { transform: `translate(${side * 150}px, -110px)` }, IN],
      [LAND, { opacity: 1, transform: 'translate(0px, 0px)' }],
      [LAND, { opacity: 0, transform: far }],
      [LOOP, { opacity: 0, transform: far }],
    ],
  }
}

/**
 * A blade's visit: it slides in down its own line, a touch past its mark and
 * back, holds, and on the cut carries on through and out. `at` is the moment
 * of the cut; `slide` is where it starts from, relative to where it cuts.
 */
function bladeTrack(name: string, [sx, sy]: Pt, at: number): Track {
  const away = `translate(${round(sx)}px, ${round(sy)}px)`
  const past = `translate(${round(-sx * 0.08)}px, ${round(-sy * 0.08)}px)`
  const through = `translate(${round(-sx * 0.5)}px, ${round(-sy * 0.5)}px)`
  return {
    name,
    keys: [
      [0, { opacity: 0, transform: away }],
      [at - 0.8, { opacity: 0, transform: away }, OUT],
      [at - 0.45, { opacity: 0.95, transform: past }, INOUT],
      [at - 0.3, { transform: 'translate(0px, 0px)' }],
      [at - 0.06, { transform: 'translate(0px, 0px)' }, IN],
      [at, { opacity: 1, transform: 'translate(0px, 0px)' }, IN],
      [at + 0.22, { opacity: 0, transform: through }],
      [at + 0.22, { opacity: 0, transform: away }],
      [LOOP, { opacity: 0, transform: away }],
    ],
  }
}

/**
 * The flash at the cut: a white line that runs right round the edge of the
 * cut's section in a tenth of a second, stands lit for a moment, and fades
 * as it grows a touch. It is the outline of the cut and nothing else -- the
 * one shape the cut has -- drawn over everything, so the whole rectangle is
 * seen through the block the way a flash would light it.
 */
function flashTrack(name: string, at: number, perimeter: number): Track {
  return {
    name,
    keys: [
      [0, { opacity: 0, strokeDashoffset: perimeter, transform: 'scale(1)' }],
      [at, { opacity: 0, strokeDashoffset: perimeter, transform: 'scale(1)' }],
      [at, { opacity: 1, strokeDashoffset: perimeter, transform: 'scale(1)' }, LINEAR],
      [at + 0.12, { strokeDashoffset: 0 }],
      [at + 0.22, { opacity: 1 }, OUT],
      [at + 0.45, { opacity: 0, strokeDashoffset: 0, transform: 'scale(1.06)' }],
      [at + 0.45, { strokeDashoffset: perimeter, transform: 'scale(1)' }],
      [LOOP, { opacity: 0, strokeDashoffset: perimeter, transform: 'scale(1)' }],
    ],
  }
}

/** A cut-off corner: a small kick up, then the tumble. */
function offcutTrack(name: string, side: -1 | 1, at: number): Track {
  const rest = 'translate(0px, 0px) rotate(0deg)'
  return {
    name,
    keys: [
      [0, { opacity: 0, transform: rest }],
      [at, { opacity: 0, transform: rest }],
      [at, { opacity: 1, transform: rest }, OUT],
      [at + 0.08, { transform: `translate(${side * 6}px, -10px) rotate(${side * 6}deg)` }, IN],
      [at + 0.45, { opacity: 1 }],
      [at + 0.6, { opacity: 0, transform: `translate(${side * 70}px, 150px) rotate(${side * 40}deg)` }],
      [at + 0.6, { transform: rest }],
      [LOOP, { opacity: 0, transform: rest }],
    ],
  }
}

/** Something that is simply there between two moments. */
function shownTrack(name: string, from: number, until: number): Track {
  return {
    name,
    keys: [
      [0, { opacity: 0 }],
      [from, { opacity: 0 }],
      [from, { opacity: 1 }],
      [until, { opacity: 1 }],
      [until, { opacity: 0 }],
      [LOOP, { opacity: 0 }],
    ],
  }
}

/** The opposite: there except between two moments. */
function hiddenTrack(name: string, from: number, until: number): Track {
  return {
    name,
    keys: [
      [0, { opacity: 1 }],
      [from, { opacity: 1 }],
      [from, { opacity: 0 }],
      [until, { opacity: 0 }],
      [until, { opacity: 1 }],
      [LOOP, { opacity: 1 }],
    ],
  }
}

/** The tool's place on the page while it grinds, for the chips to fly from. */
function toolAt(t: number): Pt {
  if (t < 7.0) return [TOOL_SIDE_X, TOOL_SIDE_Y0 + ((t - 6.3) / 0.7) * (TOOL_SIDE_Y1 - TOOL_SIDE_Y0)]
  return [0.8 * UNIT - ((t - 7.2) / 0.6) * 1.6 * UNIT, TOOL_TOP_Y]
}

/** A chip: it leaves the tool, rises, and falls out of the picture. */
export type Chip = { name: string; x: number; y: number }

export const CHIPS: readonly (Chip & { at: number; dx: number; spin: number })[] = [
  { at: 6.42, dx: 52, spin: 160 },
  { at: 6.55, dx: 44, spin: -220 },
  { at: 6.72, dx: 60, spin: 190 },
  { at: 6.88, dx: 48, spin: -150 },
  { at: 7.35, dx: -42, spin: -200 },
  { at: 7.6, dx: -50, spin: 170 },
].map((chip, i) => {
  const [x, y] = toolAt(chip.at)
  return { ...chip, name: `chip-${i}`, x: round(x), y: round(y) }
})

function chipTrack({ name, at, dx, spin }: (typeof CHIPS)[number]): Track {
  const rest = 'translate(0px, 0px) rotate(0deg)'
  return {
    name,
    keys: [
      [0, { opacity: 0, transform: rest }],
      [at, { opacity: 0, transform: rest }],
      [at, { opacity: 1, transform: rest }, OUT],
      [at + 0.14, { transform: `translate(${dx * 0.55}px, -34px) rotate(${spin * 0.4}deg)` }, IN],
      [at + 0.28, { opacity: 1 }],
      [at + 0.4, { opacity: 0, transform: `translate(${dx}px, 40px) rotate(${spin}deg)` }],
      [at + 0.4, { transform: rest }],
      [LOOP, { opacity: 0, transform: rest }],
    ],
  }
}

/** A spark off the beam, where the beam is at that moment. */
export type Spark = { name: string; x: number; y: number }

export const SPARKS: readonly (Spark & { at: number })[] = [0.1, 0.28, 0.45, 0.6, 0.74].map(
  (after, i) => {
    const at = BURN + after
    const [x, y] = alongCut(after / (SEVER - BURN))
    return { name: `spark-${i}`, at, x: round(x), y: round(y) }
  }
)

function sparkTrack({ name, at }: (typeof SPARKS)[number]): Track {
  return {
    name,
    keys: [
      [0, { opacity: 0, transform: 'scale(0.3)' }],
      [at, { opacity: 0, transform: 'scale(0.3)' }],
      [at, { opacity: 1, transform: 'scale(0.3)' }, OUT],
      [at + 0.22, { opacity: 0, transform: 'scale(1.3)' }],
      [at + 0.22, { transform: 'scale(0.3)' }],
      [LOOP, { opacity: 0, transform: 'scale(0.3)' }],
    ],
  }
}

/** Where the tools wait, off the corners of the side view. */
const TOOL_AWAY = `translate(${2.7 * UNIT}px, ${-3.5 * UNIT}px)`
const PULL_AWAY = `translate(${2.7 * UNIT}px, ${-1.4 * UNIT}px)`

/** The side view's outline in each of the wall's states. */
const D_RECT = `path("${sidePath(PROFILE_RECT)}")`
const D_OVER = `path("${sidePath(PROFILE_OVER)}")`
const D_BULB = `path("${sidePath(PROFILE_BULB)}")`
const D_LIP = `path("${sidePath(PROFILE_LIP)}")`

export const TRACKS: readonly Track[] = [
  /* --- the camera ----------------------------------------------------------
     Out to the lathe, the view folds flat about the piece's own centre line
     while the side view opens: a swing, so it reads as the camera moving and
     not the picture changing. Back again it is a fade, the isometric view
     coming up through the side view with the gentlest of zooms -- the piece
     stands in the same place in both, so the eye is not moved at all. */
  {
    name: 'view3d',
    keys: [
      [0, { opacity: 1, transform: 'scaleX(1) skewY(0deg)' }],
      [5.4, { opacity: 1, transform: 'scaleX(1) skewY(0deg)' }, IN],
      [5.6, { opacity: 1, transform: 'scaleX(0) skewY(-8deg)' }],
      [5.6, { opacity: 0, transform: 'scale(0.96)' }],
      [RETURN, { opacity: 0, transform: 'scale(0.96)' }, OUT],
      [RETURN + FADE, { opacity: 1, transform: 'scaleX(1) skewY(0deg)' }],
      [LOOP, { opacity: 1, transform: 'scaleX(1) skewY(0deg)' }],
    ],
  },
  {
    name: 'view2d',
    keys: [
      [0, { opacity: 1, transform: 'scaleX(0)' }],
      [5.6, { opacity: 1, transform: 'scaleX(0)' }, OUT],
      [5.8, { transform: 'scaleX(1.07)' }, INOUT],
      [5.95, { transform: 'scaleX(1)' }],
      [RETURN, { opacity: 1, transform: 'scaleX(1)' }, INOUT],
      [RETURN + FADE, { opacity: 0, transform: 'scale(1.03)' }],
      [RETURN + FADE, { opacity: 1, transform: 'scaleX(0)' }],
      [LOOP, { opacity: 1, transform: 'scaleX(0)' }],
    ],
  },

  /* --- the benches ---------------------------------------------------------
     The modelling grid goes with the first swing and comes back once the
     laser is done; the bed is there only for the laser. */
  {
    name: 'grid',
    keys: [
      [0, { opacity: 1 }],
      [5.4, { opacity: 1 }],
      [5.6, { opacity: 0 }],
      [12.1, { opacity: 0 }],
      [12.6, { opacity: 1 }],
      [LOOP, { opacity: 1 }],
    ],
  },
  {
    name: 'bed',
    keys: [
      [0, { opacity: 0 }],
      [RETURN, { opacity: 0 }],
      [RETURN + FADE, { opacity: 1 }],
      [12.1, { opacity: 1 }],
      [12.4, { opacity: 0 }],
      [LOOP, { opacity: 0 }],
    ],
  },

  /* --- modelling -----------------------------------------------------------*/
  heightTrack('stem-h', (h) => `scaleY(${h})`),
  heightTrack('stem-top', (h) => `translateY(${-(h - 1) * UNIT}px)`),
  // The stem stands in for the box while it stretches and again once the
  // lathe has left a box under the mass; between, the one-piece solids are
  // the shape.
  hiddenTrack('stem', LAND, RETURN),
  cubeTrack('cube-l', -1),
  cubeTrack('cube-r', 1),
  // The T gives a little as the cubes land on it: a squash about its base.
  {
    name: 'solid-t',
    keys: [
      [0, { opacity: 0, transform: 'scaleY(1)' }],
      [LAND, { opacity: 0, transform: 'scaleY(1)' }],
      [LAND, { opacity: 1, transform: 'scaleY(1)' }, OUT],
      [LAND + 0.1, { transform: 'scaleY(0.955)' }, OUT],
      [LAND + 0.25, { transform: 'scaleY(1.02)' }, OUT],
      [LAND + 0.4, { transform: 'scaleY(1)' }],
      [CUT_L, { opacity: 1, transform: 'scaleY(1)' }],
      [CUT_L, { opacity: 0, transform: 'scaleY(1)' }],
      [LOOP, { opacity: 0, transform: 'scaleY(1)' }],
    ],
  },
  shownTrack('solid-pent', CUT_L, CUT_R),
  // Held a moment past the swing, which has folded it flat by then.
  shownTrack('solid-arrow', CUT_R, 5.7),
  bladeTrack('blade-l', blade(-1).slide, CUT_L),
  bladeTrack('blade-r', blade(1).slide, CUT_R),
  flashTrack('flash-l', CUT_L, blade(-1).perimeter),
  flashTrack('flash-r', CUT_R, blade(1).perimeter),
  offcutTrack('offcut-l', -1, CUT_L),
  offcutTrack('offcut-r', 1, CUT_R),

  /* --- the lathe -----------------------------------------------------------
     One tool on one side, and both wings go: the piece is turning, so a pass
     down the right of it is a pass round the whole of it. Then a hop to the
     top and a pass across to take the point. */
  {
    name: 'tool',
    keys: [
      [0, { opacity: 0, transform: TOOL_AWAY }],
      [6.0, { opacity: 0, transform: TOOL_AWAY }, OUT],
      [6.25, { opacity: 1, transform: `translate(${TOOL_SIDE_X}px, ${TOOL_SIDE_Y0}px)` }],
      [6.3, { transform: `translate(${TOOL_SIDE_X}px, ${TOOL_SIDE_Y0}px)` }, LINEAR],
      [7.0, { transform: `translate(${TOOL_SIDE_X}px, ${TOOL_SIDE_Y1}px)` }, OUT],
      [7.1, { transform: `translate(${0.9 * UNIT}px, ${TOOL_TOP_Y - 30}px)` }, IN],
      [7.2, { transform: `translate(${0.8 * UNIT}px, ${TOOL_TOP_Y}px)` }, LINEAR],
      [FACED, { transform: `translate(${-0.8 * UNIT}px, ${TOOL_TOP_Y}px)` }, IN],
      [FACED + 0.25, { opacity: 0, transform: `translate(${-2.7 * UNIT}px, ${-3.7 * UNIT}px)` }],
      [FACED + 0.4, { transform: TOOL_AWAY }],
      [LOOP, { opacity: 0, transform: TOOL_AWAY }],
    ],
  },
  // The wings show only below the tool: a window that slides down with it.
  {
    name: 'wing-clip',
    keys: [
      [0, { transform: 'translateY(0px)' }],
      [6.3, { transform: 'translateY(0px)' }, LINEAR],
      [7.0, { transform: `translateY(${TOOL_SIDE_Y1 - TOOL_SIDE_Y0}px)` }],
      [RETURN + 0.5, { transform: `translateY(${TOOL_SIDE_Y1 - TOOL_SIDE_Y0}px)` }],
      [RETURN + 0.5, { transform: 'translateY(0px)' }],
      [LOOP, { transform: 'translateY(0px)' }],
    ],
  },
  // And the roof only to the left of it.
  {
    name: 'roof-clip',
    keys: [
      [0, { transform: 'translateX(0px)' }],
      [7.2, { transform: 'translateX(0px)' }, LINEAR],
      [FACED, { transform: `translateX(${-1.6 * UNIT}px)` }],
      [RETURN + 0.5, { transform: `translateX(${-1.6 * UNIT}px)` }],
      [RETURN + 0.5, { transform: 'translateX(0px)' }],
      [LOOP, { transform: 'translateX(0px)' }],
    ],
  },
  ...CHIPS.map(chipTrack),

  /* --- the pull ------------------------------------------------------------
     Once the prism is a prism, the piece is drawn as one outline that can
     change shape, and the plain rectangle with its rings gives way to it.
     The Pull tool takes hold at the swell's height and moves out; the wall
     comes to it, a touch past, and settles. Then a hop to the top and a
     small pull there for the lip. */
  hiddenTrack('core', FACED, RETURN + 0.5),
  {
    name: 'pulled',
    keys: [
      [0, { opacity: 0, d: D_RECT }],
      [FACED, { opacity: 0, d: D_RECT }],
      [FACED, { opacity: 1, d: D_RECT }],
      [PULL, { d: D_RECT }, OUT],
      [PULL + 0.45, { d: D_OVER }, INOUT],
      [PULL + 0.6, { d: D_BULB }],
      [PULL + 0.75, { d: D_BULB }, OUT],
      [PULL + 0.95, { d: D_LIP }],
      [RETURN + 0.5, { opacity: 1, d: D_LIP }],
      [RETURN + 0.5, { opacity: 0, d: D_RECT }],
      [LOOP, { opacity: 0, d: D_RECT }],
    ],
  },
  {
    name: 'pull',
    keys: [
      [0, { opacity: 0, transform: PULL_AWAY }],
      [PULL - 0.3, { opacity: 0, transform: PULL_AWAY }, OUT],
      [PULL, { opacity: 1, transform: `translate(${pullX(0.5)}px, ${PULL_Y}px)` }, OUT],
      [PULL + 0.45, { transform: `translate(${pullX(PROFILE_OVER[SWELL_SAMPLE][1])}px, ${PULL_Y}px)` }, INOUT],
      [PULL + 0.6, { transform: `translate(${pullX(PROFILE_BULB[SWELL_SAMPLE][1])}px, ${PULL_Y}px)` }, OUT],
      [PULL + 0.68, { transform: `translate(${pullX(0.85)}px, ${LIP_Y - 26}px)` }, IN],
      [PULL + 0.75, { transform: `translate(${pullX(0.5)}px, ${LIP_Y}px)` }, OUT],
      [PULL + 0.95, { transform: `translate(${pullX(PROFILE_LIP[PROFILE_SAMPLES - 1][1])}px, ${LIP_Y}px)` }, IN],
      [RETURN, { opacity: 0, transform: `translate(${2.7 * UNIT}px, ${-3.2 * UNIT}px)` }],
      [RETURN + 0.1, { transform: PULL_AWAY }],
      [LOOP, { opacity: 0, transform: PULL_AWAY }],
    ],
  },

  /* --- the laser -----------------------------------------------------------
     The line is drawn on first, the way the user draws it; then the beam
     arrives at its start, burns along it, and the top comes away. The line
     is shown only while it is wanted: a dash pattern wound fully off still
     leaves a hair at the path's end, and a hair in red on a resting cube is
     a mark nobody put there. */
  shownTrack('bulb', RETURN, SEVER),
  {
    name: 'cut-line',
    keys: [
      [0, { opacity: 0, strokeDashoffset: CUT_PATH_LENGTH }],
      [LINE, { opacity: 0, strokeDashoffset: CUT_PATH_LENGTH }],
      [LINE, { opacity: 1, strokeDashoffset: CUT_PATH_LENGTH }, INOUT],
      [LINE + 0.4, { strokeDashoffset: 0 }],
      [SEVER, { opacity: 1, strokeDashoffset: 0 }],
      [SEVER, { opacity: 0, strokeDashoffset: CUT_PATH_LENGTH }],
      [LOOP, { opacity: 0, strokeDashoffset: CUT_PATH_LENGTH }],
    ],
  },
  {
    name: 'beam',
    keys: [
      [0, { opacity: 0, offsetDistance: '0%' }],
      [BURN - 0.2, { opacity: 0, offsetDistance: '0%' }],
      [BURN - 0.05, { opacity: 1 }],
      [BURN, { offsetDistance: '0%' }, LINEAR],
      [SEVER, { opacity: 1, offsetDistance: '100%' }],
      [SEVER + 0.12, { opacity: 0 }],
      [SEVER + 0.15, { offsetDistance: '100%' }],
      [SEVER + 0.15, { offsetDistance: '0%' }],
      [LOOP, { opacity: 0, offsetDistance: '0%' }],
    ],
  },
  {
    name: 'beam-pop',
    keys: [
      [0, { transform: 'scale(0)' }],
      [BURN - 0.2, { transform: 'scale(0)' }, OUT],
      [BURN - 0.05, { transform: 'scale(1.5)' }, INOUT],
      [BURN + 0.05, { transform: 'scale(1)' }],
      [SEVER, { transform: 'scale(1)' }, OUT],
      [SEVER + 0.12, { transform: 'scale(2.2)' }],
      [SEVER + 0.15, { transform: 'scale(2.2)' }],
      [SEVER + 0.15, { transform: 'scale(0)' }],
      [LOOP, { transform: 'scale(0)' }],
    ],
  },
  ...SPARKS.map(sparkTrack),
  {
    name: 'offcut-laser',
    keys: [
      [0, { opacity: 0, transform: 'translate(0px, 0px) rotate(0deg)' }],
      [SEVER, { opacity: 0, transform: 'translate(0px, 0px) rotate(0deg)' }],
      [SEVER, { opacity: 1, transform: 'translate(0px, 0px) rotate(0deg)' }, OUT],
      [SEVER + 0.1, { transform: 'translate(4px, -14px) rotate(3deg)' }, IN],
      [SEVER + 0.45, { opacity: 1 }],
      [SEVER + 0.6, { opacity: 0, transform: 'translate(96px, 240px) rotate(34deg)' }],
      [SEVER + 0.6, { transform: 'translate(0px, 0px) rotate(0deg)' }],
      [LOOP, { opacity: 0, transform: 'translate(0px, 0px) rotate(0deg)' }],
    ],
  },
]

/** A track's keys as the Web Animations API takes them. */
export function keyframesOf(track: Track): Keyframe[] {
  return track.keys.map(([at, props, easing]) => ({
    offset: at / LOOP,
    ...(easing ? { easing } : {}),
    ...props,
  }))
}

/**
 * Why a track would show a jump at the seam, or null if it cannot.
 *
 * A property's value at the end of the loop has to be its value at the start,
 * and the API fills in whichever end is not written with the element's own
 * resting value -- so a property is safe if it is written at both ends with
 * one value, or at neither. Written at one end only, it is a guess about the
 * resting value, and guesses are what this exists to refuse. Keys out of
 * order would be refused by the API itself, but at run time, on the front
 * door, where nobody is watching for an exception.
 */
export function seamOf(track: Track): string | null {
  const keys = track.keys
  for (let i = 1; i < keys.length; i++) {
    if (keys[i][0] < keys[i - 1][0]) return `key ${i} at ${keys[i][0]}s is before key ${i - 1}`
  }
  if (keys.length === 0) return 'no keys'
  if (keys[0][0] !== 0) return `starts at ${keys[0][0]}s rather than 0`
  if (keys[keys.length - 1][0] !== LOOP) return `ends at ${keys[keys.length - 1][0]}s rather than ${LOOP}`
  const names = new Set<keyof Props>()
  for (const [, props] of keys) for (const name of Object.keys(props) as (keyof Props)[]) names.add(name)
  for (const name of names) {
    const first = keys.find(([at, props]) => at === 0 && props[name] !== undefined)
    const last = [...keys].reverse().find(([at, props]) => at === LOOP && props[name] !== undefined)
    if (!first && !last) continue
    if (!first || !last) return `${name} is written at only one end`
    if (first[1][name] !== last[1][name]) return `${name} is ${first[1][name]} at the start and ${last[1][name]} at the end`
  }
  return null
}
