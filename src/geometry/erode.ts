import { BufferAttribute, BufferGeometry, Vector3 } from 'three'
import { resizeFactors } from './dimensions'
import type { BaseSolid, ErodeDab } from './types'

/**
 * The brushes: what a sphere held against a surface does to it.
 *
 * TWO TOOLS, ONE FILE, ONE SIGN BETWEEN THEM. The blowtorch sinks the surface
 * under the brush; the sculpt tool raises it. Everything else about them is the
 * same arithmetic, the same guards and the same tuning, because the hard part
 * of either is not the direction -- it is keeping a mesh that has to bend under
 * a moving pointer from bunching up, creasing at the rim of the brush and
 * folding through itself. That work is written once, and `ErodeDab.raise`
 * chooses which way it points. See `dab`, where the sign enters, and the note
 * on `RELAX_FILL`, which is the one place the two are not mirror images by
 * accident but by arrangement.
 *
 * What follows describes the torch, because that is the tool the tuning below
 * was measured against; read every "sink" as "move the surface the way this dab
 * is pointed" and it is equally the description of the other one.
 *
 * NOT a boolean. Subtracting a sphere would leave a crisp spherical bite with a
 * sharp circular rim, which is a drill hole -- the one thing this tool is not.
 * Melting plastic does two things at once, and both of them are here:
 *
 *   - the surface SAGS INWARD under the brush, hardest at the middle and
 *     tapering to nothing at the rim, so what is left is a dish rather than a
 *     crater with an edge, and
 *   - it RELAXES toward its own neighbours, which is surface tension written
 *     as arithmetic. That is what rounds a corner off, closes a sharp crease
 *     and gives the result the soft, poured look of something that flowed
 *     before it set.
 *
 * Vertices MOVE; no triangle is ever removed and no hole is ever opened. That
 * is the deliberate limit of the approach and it buys three things worth more
 * than perforation: the work is local, so a stroke costs the vertices under the
 * brush and not the object; everything outside the brush stays EXACTLY the
 * geometry the evaluator built, down to the float; and the mesh keeps its
 * groups, so a merged assembly comes out of the torch still wearing all of its
 * colours. Torch one spot long enough and the surface will sag through the far
 * side of a thin wall rather than opening a hole in it -- see `dig`.
 *
 * Everything here runs in OBJECT-LOCAL space, like every other stage of the
 * pipeline, so a dab is stored once and survives the object being moved,
 * turned, undone and redone.
 */

/** How far past the brush radius a dab may re-tessellate. */
const REFINE_REACH = 1.5

/**
 * The longest edge allowed under a dab, as a fraction of its radius.
 *
 * A dish can only be as smooth as the triangles that carry it: held against the
 * middle of a cube's face, which is two triangles, a torch with nothing to move
 * would either do nothing at all or drag the whole corner in. So the brush
 * subdivides what it is about to melt.
 *
 * Two fifths of a radius puts roughly five vertices across the dish, which is
 * enough for the falloff to read as a curve rather than a cone. Smaller looks
 * better and costs triangles everywhere the user has ever pointed the torch;
 * this is the knee.
 */
const REFINE_EDGE = 0.4

/**
 * How many rounds of edge-splitting one call may spend.
 *
 * Each round halves the edges under the brush, so ten is a thousandfold
 * refinement -- enough to bring a five-metre wall down to a five-millimetre
 * brush, which is the widest gap between object and tool this app can produce.
 *
 * Affordable because only the FIRST round looks at the whole mesh: after that a
 * round revisits only what it just split, so the cost falls away as the patch
 * converges rather than compounding.
 */
const REFINE_ROUNDS = 10

/**
 * A ceiling on the welded vertex count, past which refinement stops.
 *
 * Erosion is replayed from the document on every evaluation, so an unbounded
 * mesh is not merely a memory problem -- it is a frame time that grows with the
 * user's own history and never comes back down. At the cap the torch keeps
 * working; it just stops adding detail, so the dish gets coarser rather than
 * the app getting slower.
 */
const MAX_VERTICES = 300_000

/**
 * How far ONE dab moves the surface at its centre, as a fraction of the brush
 * radius -- down for the torch, up for the sculpt tool.
 *
 * Deliberately small. A stroke lays dabs down every fraction of a radius (see
 * `DAB_SPACING`), so the depth a user actually sees is this accumulated many
 * times over -- and the thing that has to feel right is the RATE, not the
 * single dab. Big enough to see one press land, small enough that crossing an
 * area once is a scorch rather than a trench.
 */
const DAB_BITE = 0.12

/** Rounds of relaxation per dab. Three is where a torched crease stops looking
 *  faceted; more is slower without looking different. */
const RELAX_ROUNDS = 3

/**
 * Smoothing's share of a step, at full strength and dead centre.
 *
 * Held below 1 because a full-strength Laplacian step moves a vertex all the
 * way onto the average of its neighbours, which does not relax a surface so
 * much as shatter it -- adjacent vertices swap places and the patch folds. Two
 * thirds is the usual safe ceiling for an explicit step, and three rounds of it
 * is plenty of flow.
 */
const RELAX_RATE = 0.66

/**
 * How much of the flow that UNDOES THE DAB survives -- for the torch, the half
 * that tries to fill the dish back in. See the note at the point of use: this
 * is the number that decides whether going over the same spot twice does
 * anything.
 *
 * A quarter. Zero would let a dish deepen without limit and eventually turn
 * itself inside out; one is the symmetric case that stalls at two thirds of a
 * radius. A quarter puts the ceiling far enough out that a user reaches it by
 * choosing to, rather than by discovering the tool has stopped working.
 *
 * WHICH HALF IT IS FOLLOWS THE DAB rather than the surface. Inside a dish the
 * flow points back out; on top of a bead it points back down. Both are the same
 * thing -- the surface tension undoing what the brush just did -- so the test
 * is the flow against the dab's own direction, and the sculpt tool gets the
 * same ceiling on a bead that the torch has always had on a dish. Held the
 * other way round, a raise would be filled in by its own smoothing as fast as
 * it was laid down, and Smoothing at full would have meant a tool that did
 * nothing at all.
 */
const RELAX_FILL = 0.25

/**
 * How much the surface is allowed to even ITSELF out, whatever the user has set
 * Smoothing to.
 *
 * Sinking a curved surface along its own normals does not merely move it -- it
 * CONVERGES it. Push a circle of radius r inward by d and its circumference
 * shrinks by the same ratio the radius does, so the vertices sitting on it are
 * squeezed together. Repeat that and the triangles between them close up and
 * eventually turn inside out; on a cylinder with Smoothing at zero, eight dabs
 * took the shortest edge under the brush from 2 mm to a third of a millimetre
 * and folded the surface into spikes.
 *
 * Flow was already the cure and it is not available here, because the user is
 * entitled to turn it off. So the TANGENTIAL half of the flow runs regardless:
 * a step across the surface rather than into it, which slides vertices back
 * apart without moving the surface they sit on. It is mesh housekeeping, not a
 * shape change -- Smoothing at zero still sinks a bare dent with every crease
 * it started with -- and it is what makes the setting survivable at zero.
 *
 * Only the NORMAL half is Smoothing's to sell, which is the half that rounds a
 * corner over and fills a dish back in.
 *
 * The FULL rate, measured rather than guessed: at a third of it a cylinder with
 * Smoothing off still folded eight triangles over eight dabs, at a half four,
 * and only at the full rate did it stop entirely. Which stands to reason -- the
 * squeeze it is undoing is the whole of the sinking, so anything less is always
 * losing ground. It costs nothing at the top of the range, where this is what
 * the tangential half was already running at.
 */
const RELAX_CONDITION = RELAX_RATE

/**
 * The flow's share of the falloff: how much of the brush the melt reaches,
 * as against how much of it SINKS.
 *
 * The two are not the same question and giving them the same curve is what
 * pinched a bridge in half. The falloff shapes the dent, so the sinking is
 * entitled to all of it. The flow does something else -- it blends the dent
 * into the surface around it -- and weighting it by the same curve makes it
 * die out at the rim, which is precisely where the dent MEETS that surface and
 * therefore where the crease it leaves is sharpest. The brush was cutting a
 * step at the edge of its own reach and then declining to smooth it, and forty
 * dabs of that stood the step up into a cliff.
 *
 * A square root, so the weight still runs from one in the middle to zero at
 * the rim -- nothing outside the brush is touched, which is the promise this
 * whole file is built on -- but stays worth having across the outer half of
 * it: at four fifths of the radius the sink is down to an eighth and the flow
 * is still a third.
 *
 * It cannot sand the object down by being generous here. Flow moves a vertex
 * toward the average of its neighbours, and on a surface that is already
 * smooth that average is where the vertex already is. A fatter weight buys
 * more smoothing only where there is a crease to remove.
 */
const RELAX_SPREAD = 0.5

/**
 * NEITHER BRUSH SHARPENS, and this is the note that says so once for both.
 *
 * Not a constant -- a consequence, and one that surprised a check written to
 * assert the opposite. At a sharp feature the Laplacian is large next to a
 * dab's bite, so the flow rounds the feature off faster than the sinking or the
 * raising can drive it further. Measured on this app's own cone: forty dabs of
 * the sculpt tool on the tip leave it at 0.75 of its height rather than taller,
 * while packing material around it; and the torch, aimed into the sharp point
 * of a cone-shaped cavity, FILLS IT IN by +0.008 of volume at mid smoothing
 * instead of deepening it.
 *
 * It reads as a limit of the sculpt tool and it is nothing of the kind -- it is
 * one property of the brush seen from two sides, and the torch has shipped with
 * its half of it from the beginning. It follows from the same flow that makes
 * either tool worth having: a brush that could sharpen a point is a brush that
 * has stopped smoothing, and the whole reason the surface holds together under
 * a moving pointer is that it never stops.
 *
 * On any ORDINARY surface, flat or curved, both tools work as advertised and
 * they work symmetrically -- a bead stands exactly as proud as the dish sinks
 * at the same three settings. See the sculpt section of `engine-check`, which
 * states the promise and the exception side by side.
 */

/**
 * The most of its own length one dab may add to or take out of an edge under
 * the brush.
 *
 * The rate limit that makes the difference between a surface that melts and
 * one that tears. Sinking moves each vertex along ITS OWN normal, so two
 * vertices sharing an edge across a crease travel in different directions and
 * the edge between them shortens; do that faster than the flow can slide them
 * apart again and the mesh bunches up, stands into a cliff, and finally folds
 * through itself. Which is what a user sees when they melt two pits and then
 * melt the ridge left between them: the ridge is squeezed from both sides at
 * once, and the two walls arrive in the same place.
 *
 * BOTH WAYS ROUND, and the same number for each, which is what carries the
 * limit over to the sculpt tool. Raising a convex crease -- the rim of a
 * cylinder, the tip of a cone -- drives the two faces meeting there APART
 * instead of together, and the triangles across the crease stretch into slivers
 * that turn inside out just as readily as squeezed ones do. Measured over
 * cones, cylinders, tori and boxes at every brush size, heat and smoothing the
 * app offers: limiting only the closing half left the worst case at 78 folded
 * triangles for the sculpt tool and 48 for the torch, and limiting both halves
 * takes those to 64 and 38. It costs neither tool anything -- a mark that used
 * to reach 0.4249 of a radius now reaches 0.4244 -- because an edge lengthening
 * fast enough to hit this limit is already a sliver in the making.
 *
 * Applied as ONE SCALE OVER THE WHOLE DAB rather than per vertex, and that
 * distinction is the whole of why it works. Clamping vertices individually
 * rescues the worst of them by moving it differently from its neighbours,
 * which is a new crease in place of the old one -- measured, and it made the
 * folding WORSE, not better. Scaling the dab keeps the dish exactly the shape
 * the falloff asked for and merely lands it in more instalments.
 *
 * Eight hundredths, measured against the two things it has to sit between. Too
 * loose and it stops holding: at twelve hundredths a bridge tore again at mid
 * Smoothing. Too tight and it stops the tool: at two hundredths a stroke that
 * used to cut half a radius cut a fifth of one.
 *
 * What it costs is small and it is paid where it should be. A dish melted into
 * open surface reaches the same depth it always did -- twenty dabs took 0.41
 * of a radius and now take 0.38 -- because a patch holding its shape is
 * nowhere near the limit. A ridge with a pit either side is at the limit from
 * the first dab, so it goes down at about half the old rate and arrives at the
 * same place: sixty dabs reach 0.55 where they used to reach 0.57, with none
 * of the tearing that used to start at thirty.
 */
const DAB_CLOSE = 0.08

/**
 * The least flow a dab may have, whatever it was stored with.
 *
 * A POINT CANNOT BE MELTED WITHOUT SOME FLOW, and this is where that fact
 * lives. The sculpt tool needs the floor for the mirror of the same reason: a
 * raise inside a narrow groove pushes the two walls at each other, and with no
 * flow to slide the vertices along the groove they meet on its centreline and
 * cross. Neither tool is offered anything below it -- see BRUSH_SMOOTH_MIN's
 * use in the panels -- so the number a user picks is the number they get. Near a cone's apex the solid is thinner than any brush -- it converges
 * to nothing, so there is always a height at which the two sides of it are
 * closer together than the sphere is wide. Sinking there pulls the ring around
 * the tip inward faster than the tip descends, and with no flow to spread it
 * again the ring collapses onto the axis and crosses to the far side. The fan
 * turns inside out, the normal derived from it points inward, and from then on
 * sinking drives the tip back OUT: twelve dabs at zero smoothing left a needle
 * standing ABOVE where the cone started, on a surface that had melted away
 * beneath it.
 *
 * Measured, not guessed. At zero and at 0.05 the needle appears; at 0.1 a small
 * spur survives; from 0.15 the tip melts flat and stays flat however long the
 * torch is held on it. The floor is set there, and the Smoothing control offers
 * nothing below it -- see BRUSH_SMOOTH_MIN -- so the number a user picks is the
 * number they get rather than one silently corrected here.
 *
 * It costs almost nothing at the bottom of the range: a sixth of the flow still
 * reads as sandblasting rather than melting, which is what the low end is for.
 */
export const BRUSH_SMOOTH_MIN = 0.15



/**
 * The influence of a dab at `t` of its radius: 1 at the middle, 0 at the rim,
 * and FLAT at both ends.
 *
 * The flatness is the whole point. A falloff that arrived at the rim with slope
 * left over would leave a visible crease exactly where the brush stopped -- a
 * ring, on a tool whose entire job is not leaving rings. This one lands
 * tangent, so the dish blends into the surface it was cut from.
 */
function falloff(t: number): number {
  if (t >= 1) return 0
  const s = 1 - t * t
  return s * s
}

// --- Welding ----------------------------------------------------------------

/**
 * A mesh with its POSITIONS shared and its NORMALS still per corner.
 *
 * Both halves of that are load-bearing, and they pull in opposite directions.
 *
 * Positions have to be shared or the tool cannot work at all: the geometry the
 * evaluator produces is a triangle soup, where the three faces meeting at a
 * cube's corner each hold their own copy of it. Move one copy and the object
 * tears open. Welding is what makes "move the surface" a coherent instruction,
 * and it is also what gives every vertex the neighbours that relaxation
 * averages over.
 *
 * Normals must NOT be shared, because sharing them is what would quietly
 * re-shade the whole object. A cube's corner carries three different normals,
 * one per face, and that disagreement is exactly what makes its edges crisp.
 * Collapse them to one and every solid in the scene comes back soft. So the
 * normal stays attached to the CORNER -- the (triangle, slot) pair -- and the
 * torch rewrites only the corners it actually touched. Anything the brush never
 * reached leaves this function and comes back out the far end bit for bit.
 */
type Welded = {
  /** Shared positions, 3 floats each. */
  position: Float32Array
  vertexCount: number
  /** Corner -> welded vertex index, 3 per triangle. */
  corner: Uint32Array
  /** Corner normals, 3 floats each, parallel to `corner`. */
  cornerNormal: Float32Array
  /** Material index per triangle -- the paint group it came from. */
  group: Uint32Array
  triangleCount: number
}

/**
 * How near two positions must be to be the same vertex, relative to the
 * object's own size.
 *
 * Relative because this file sees a five-metre wall and a two-millimetre boss
 * with the same code, and an absolute epsilon is wrong for one of them by three
 * orders of magnitude. A boolean result's shared edges are computed twice, once
 * per triangle, from plane intersections that agree to within rounding rather
 * than exactly -- so a pure equality test welds almost nothing.
 */
const WELD_EPSILON = 1e-6

/**
 * How many passes the seam-sewing below may make.
 *
 * Each pass splits at most ONE edge per triangle, so a triangle with a stray
 * vertex on two of its sides needs two of them. Three has been enough for every
 * boolean measured -- a notched cube converges in two, a cylinder with a slot
 * and a cube merged with a sphere in three -- and the pass is skipped entirely
 * the moment there is nothing left to sew, so the fourth costs one walk of the
 * edges and buys the case nobody has hit yet.
 */
const STITCH_ROUNDS = 4

/**
 * Weld a triangle soup, memoised on the geometry it came from.
 *
 * The memo is what makes a live stroke affordable. Welding is the one part of
 * this file whose cost is the WHOLE object rather than the patch under the
 * brush, and the geometry being welded -- the object as it stands before any
 * erosion -- does not change for the entire length of a drag. So it is paid
 * once, on the first dab, and every dab after it reads the same answer.
 *
 * A WeakMap, so the entry dies with the geometry the evaluator's prefix cache
 * eventually disposes. A `Map` here would pin every mesh the user has ever
 * eroded for the life of the tab.
 */
let weldCache = new WeakMap<BufferGeometry, Welded>()

function weld(geom: BufferGeometry): Welded {
  const cached = weldCache.get(geom)
  if (cached) return cached
  const built = buildWeld(geom)
  weldCache.set(geom, built)
  return built
}

function buildWeld(geom: BufferGeometry): Welded {
  const position = geom.getAttribute('position')
  const normal = geom.getAttribute('normal')
  const index = geom.getIndex()
  const cornerCount = index ? index.count : position.count
  const triangleCount = Math.floor(cornerCount / 3)

  // Scaled off the object's own extent -- see WELD_EPSILON.
  geom.computeBoundingBox()
  const box = geom.boundingBox
  const extent = box ? Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) : 1
  const tol = Math.max(extent, 1e-6) * WELD_EPSILON
  const cell = tol * 2

  // Grid hash, probing the 26 neighbouring cells as well as the vertex's own.
  // A single-cell lookup is faster and wrong: two positions a nanometre apart
  // can still land either side of a cell boundary, and the two halves of a
  // welded edge that failed to meet are a crack that opens as soon as the
  // torch moves one of them.
  //
  // The key is an INTEGER hash, not a string. Twenty-seven probes per corner
  // is the price of the guarantee above, and building three template literals
  // for each of them made welding cost more than every other stage of the tool
  // put together -- two hundred milliseconds on a mesh of nine hundred
  // triangles. Two hash keys colliding is harmless: the bucket is scanned for
  // an ACTUAL match within tolerance either way, so the hash only has to be
  // cheap and well spread, never perfect.
  const buckets = new Map<number, number[]>()
  const positions = new Float32Array(cornerCount * 3)
  const corner = new Uint32Array(cornerCount)
  let vertexCount = 0

  const key = (a: number, b: number, c: number) =>
    ((Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) >>> 0)
  const at = new Vector3()

  /** Scan one cell for a vertex already sitting within tolerance. */
  const inBucket = (hash: number): number => {
    const bucket = buckets.get(hash)
    if (!bucket) return -1
    for (const candidate of bucket) {
      const i = candidate * 3
      if (
        Math.abs(positions[i] - at.x) <= tol &&
        Math.abs(positions[i + 1] - at.y) <= tol &&
        Math.abs(positions[i + 2] - at.z) <= tol
      ) {
        return candidate
      }
    }
    return -1
  }

  for (let c = 0; c < cornerCount; c++) {
    const v = index ? index.getX(c) : c
    at.fromBufferAttribute(position, v)
    const cx = Math.floor(at.x / cell)
    const cy = Math.floor(at.y / cell)
    const cz = Math.floor(at.z / cell)

    // The vertex's OWN cell first, alone. Two corners naming the same point
    // usually hold bit-identical floats -- the boolean copies vertex data
    // rather than recomputing it -- so they land in the same cell and this one
    // lookup answers for the great majority of a mesh. The twenty-six
    // neighbours are the fallback for the rest, and skipping them when the
    // first probe hits is most of what this function costs.
    let found = inBucket(key(cx, cy, cz))
    if (found < 0) {
      // Three products per axis rather than three per PROBE: the offsets only
      // ever take three values, and hashing all twenty-seven from scratch was
      // eighty-one multiplies where nine will do.
      const hx = [Math.imul(cx - 1, 73856093), Math.imul(cx, 73856093), Math.imul(cx + 1, 73856093)]
      const hy = [Math.imul(cy - 1, 19349663), Math.imul(cy, 19349663), Math.imul(cy + 1, 19349663)]
      const hz = [Math.imul(cz - 1, 83492791), Math.imul(cz, 83492791), Math.imul(cz + 1, 83492791)]
      for (let dx = 0; dx < 3 && found < 0; dx++) {
        for (let dy = 0; dy < 3 && found < 0; dy++) {
          for (let dz = 0; dz < 3 && found < 0; dz++) {
            if (dx === 1 && dy === 1 && dz === 1) continue
            found = inBucket((hx[dx] ^ hy[dy] ^ hz[dz]) >>> 0)
          }
        }
      }
    }

    if (found < 0) {
      found = vertexCount++
      const i = found * 3
      positions[i] = at.x
      positions[i + 1] = at.y
      positions[i + 2] = at.z
      const own = key(cx, cy, cz)
      const bucket = buckets.get(own)
      if (bucket) bucket.push(found)
      else buckets.set(own, [found])
    }
    corner[c] = found
  }

  // Corner normals, straight across. A geometry with no normals is not one this
  // pipeline produces, but an empty object is, so the fallback is +Y rather
  // than a throw.
  const cornerNormal = new Float32Array(cornerCount * 3)
  if (normal) {
    for (let c = 0; c < cornerCount; c++) {
      const v = index ? index.getX(c) : c
      cornerNormal[c * 3] = normal.getX(v)
      cornerNormal[c * 3 + 1] = normal.getY(v)
      cornerNormal[c * 3 + 2] = normal.getZ(v)
    }
  } else {
    for (let c = 0; c < cornerCount; c++) cornerNormal[c * 3 + 1] = 1
  }

  // Which paint each triangle wears. The groups are how a merged assembly
  // keeps more than one colour, and a tool that dropped them would repaint the
  // whole object the host solid's colour the first time it was touched.
  const group = new Uint32Array(triangleCount)
  for (const g of geom.groups) {
    const first = Math.floor(g.start / 3)
    const last = Math.min(triangleCount, first + Math.floor(g.count / 3))
    for (let t = first; t < last; t++) group[t] = g.materialIndex ?? 0
  }

  return stitch(
    {
      position: positions.slice(0, vertexCount * 3),
      vertexCount,
      corner,
      cornerNormal,
      group,
      triangleCount,
    },
    tol,
    extent
  )
}

/**
 * Sew up the seams a boolean leaves behind.
 *
 * WELDING IS NOT ENOUGH TO MAKE A MESH SAFE TO MOVE, and this is the other half
 * of it. A boolean cuts the same seam into both solids and triangulates each
 * side on its own, so the two sides agree on where the seam RUNS and disagree
 * about where to put vertices along it: a notch taken out of a cube leaves one
 * face carrying a single long edge and the face against it carrying two shorter
 * ones that meet at a point partway along. Geometrically the surface is closed
 * -- the extra point sits exactly ON the long edge -- and it draws perfectly,
 * which is why nobody notices until something moves. Move either end of the
 * long edge and the point it was covering no longer lies on it, and the surface
 * opens along the whole seam. Torching a solid that had been merged or
 * subtracted from used to tear it into holes for exactly this reason.
 *
 * So the long edge is SPLIT at the point sitting on it, and the triangle behind
 * it fanned out to match. That makes the seam one shared edge again, which is
 * the property the rest of this file quietly assumes: melting moves vertices,
 * and a vertex may only be moved safely when every triangle touching that point
 * moves with it.
 *
 * Shape-preserving to the float, like the refinement is and for the same
 * reason: the vertex it splits at is one that was already there, already on the
 * edge. A stitched solid is the solid it was, drawn with more triangles.
 *
 * The candidates are the ENDS OF UNSHARED EDGES, not every vertex in the mesh,
 * and that restriction is what makes this affordable rather than merely
 * correct. A point stranded in the middle of someone else's edge is by
 * construction an end of the two shorter edges that replaced it on its own
 * side, and those are unshared too -- so the set worth indexing is the seam,
 * not the object. Indexing every vertex instead was measured: it finds the same
 * seams on a cube merged with a sphere and takes minutes to do it.
 *
 * A mesh with no unshared edges -- every primitive, and any import that arrived
 * closed -- leaves here on the first pass having paid one walk over the
 * triangles, which is the same walk the weld above just made.
 */
function stitch(welded: Welded, tol: number, extent: number): Welded {
  let { corner, cornerNormal, group, triangleCount } = welded
  const { position, vertexCount } = welded
  const done = (): Welded => ({
    position,
    vertexCount,
    corner,
    cornerNormal,
    group,
    triangleCount,
  })

  // Exact for any mesh under ninety million vertices, which is well past what
  // the rest of this file will entertain -- see MAX_VERTICES.
  const edgeKey = (a: number, b: number) =>
    a < b ? a * vertexCount + b : b * vertexCount + a

  // Coarse enough to walk an edge in a handful of steps, and never finer than
  // the weld's own tolerance. This is a BROAD phase -- whatever it turns up is
  // measured properly against the segment below -- so it only has to be certain
  // never to MISS, which sampling at half a cell and probing the neighbours is.
  const cell = Math.max(extent / 128, tol * 4)
  const cellKey = (x: number, y: number, z: number) =>
    ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0)

  const a = new Vector3()
  const b = new Vector3()
  const ab = new Vector3()
  const at = new Vector3()
  const na = new Vector3()
  const nb = new Vector3()
  const nc = new Vector3()

  for (let round = 0; round < STITCH_ROUNDS; round++) {
    // Who uses each edge. ONE map, holding the corner that claimed the edge and
    // -1 once a second triangle turns up, rather than a count beside an owner:
    // this walks every corner of the mesh on every pass, and a second map here
    // was the most expensive thing in the file on a large import.
    //
    // An edge claimed twice is a seam already sewn; three or more is a place
    // several sheets genuinely meet, and they meet AT SHARED VERTICES, so
    // melting carries them along together and there is nothing to fix.
    const owner = new Map<number, number>()
    for (let t = 0; t < triangleCount; t++) {
      for (let e = 0; e < 3; e++) {
        const va = corner[t * 3 + e]
        const vb = corner[t * 3 + ((e + 1) % 3)]
        if (va === vb) continue
        const key = edgeKey(va, vb)
        owner.set(key, owner.has(key) ? -1 : t * 3 + e)
      }
    }

    const lone: number[] = []
    for (const [key, claim] of owner) if (claim >= 0) lone.push(key)
    if (lone.length === 0) return done()

    // The seam, indexed.
    const buckets = new Map<number, number[]>()
    const indexed = new Set<number>()
    const remember = (v: number): void => {
      if (indexed.has(v)) return
      indexed.add(v)
      const key = cellKey(
        Math.floor(position[v * 3] / cell),
        Math.floor(position[v * 3 + 1] / cell),
        Math.floor(position[v * 3 + 2] / cell)
      )
      const bucket = buckets.get(key)
      if (bucket) bucket.push(v)
      else buckets.set(key, [v])
    }
    for (const key of lone) {
      const c = owner.get(key) as number
      const t = Math.floor(c / 3)
      const e = c % 3
      remember(corner[t * 3 + e])
      remember(corner[t * 3 + ((e + 1) % 3)])
    }

    // At most one edge per triangle per round: the fan below rebuilds the
    // triangle around ONE of its sides, and a second split of the same triangle
    // in the same round would be written over the top of the first. The next
    // round finds it again, on whichever piece inherited it.
    const split = new Map<number, { edge: number; on: number[]; along: number[] }>()
    for (const key of lone) {
      const c = owner.get(key) as number
      const t = Math.floor(c / 3)
      if (split.has(t)) continue
      const e = c % 3
      const va = corner[t * 3 + e]
      const vb = corner[t * 3 + ((e + 1) % 3)]
      a.fromArray(position, va * 3)
      b.fromArray(position, vb * 3)
      ab.subVectors(b, a)
      const lengthSq = ab.lengthSq()
      if (lengthSq < 1e-30) continue

      const found: [number, number][] = []
      const seen = new Set<number>()
      const steps = Math.max(1, Math.ceil((Math.sqrt(lengthSq) / cell) * 2))
      for (let i = 0; i <= steps; i++) {
        at.copy(a).addScaledVector(ab, i / steps)
        const cx = Math.floor(at.x / cell)
        const cy = Math.floor(at.y / cell)
        const cz = Math.floor(at.z / cell)
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
              const bucket = buckets.get(cellKey(cx + dx, cy + dy, cz + dz))
              if (!bucket) continue
              for (const v of bucket) {
                if (v === va || v === vb || seen.has(v)) continue
                seen.add(v)
                // On the segment, and strictly between its ends.
                const rx = position[v * 3] - a.x
                const ry = position[v * 3 + 1] - a.y
                const rz = position[v * 3 + 2] - a.z
                const s = (rx * ab.x + ry * ab.y + rz * ab.z) / lengthSq
                if (s <= 1e-6 || s >= 1 - 1e-6) continue
                const ox = rx - ab.x * s
                const oy = ry - ab.y * s
                const oz = rz - ab.z * s
                if (ox * ox + oy * oy + oz * oz > tol * tol) continue
                found.push([s, v])
              }
            }
          }
        }
      }
      if (found.length === 0) continue
      found.sort((p, q) => p[0] - q[0])
      split.set(t, {
        edge: e,
        on: found.map((f) => f[1]),
        along: found.map((f) => f[0]),
      })
    }
    if (split.size === 0) return done()

    // Fan each split triangle from the corner opposite the edge that grew
    // points. Every piece is a slice of the triangle it came from, so the
    // winding carries across and none of them can come out inverted.
    let extra = 0
    for (const piece of split.values()) extra += piece.on.length
    corner = growU32(corner, (triangleCount + extra) * 3)
    cornerNormal = grow32(cornerNormal, (triangleCount + extra) * 9)
    group = growU32(group, triangleCount + extra)

    for (const [t, piece] of split) {
      const e = piece.edge
      const va = corner[t * 3 + e]
      const vb = corner[t * 3 + ((e + 1) % 3)]
      const vc = corner[t * 3 + ((e + 2) % 3)]
      na.fromArray(cornerNormal, (t * 3 + e) * 3)
      nb.fromArray(cornerNormal, (t * 3 + ((e + 1) % 3)) * 3)
      nc.fromArray(cornerNormal, (t * 3 + ((e + 2) % 3)) * 3)
      const paint = group[t]

      const chain = [va, ...piece.on, vb]
      // A new corner's normal is the one the shading was already interpolating
      // to at that point, so a stitched face shades exactly like the face it
      // replaced.
      const shade = [
        na.clone(),
        ...piece.along.map((s) => na.clone().lerp(nb, s).normalize()),
        nb.clone(),
      ]

      for (let i = 0; i < chain.length - 1; i++) {
        const slot = i === 0 ? t : triangleCount++
        const o = slot * 3
        corner[o] = chain[i]
        corner[o + 1] = chain[i + 1]
        corner[o + 2] = vc
        shade[i].toArray(cornerNormal, o * 3)
        shade[i + 1].toArray(cornerNormal, (o + 1) * 3)
        nc.toArray(cornerNormal, (o + 2) * 3)
        group[slot] = paint
      }
    }
  }

  return done()
}

// --- Growable working copy --------------------------------------------------

/**
 * The welded mesh as refinement leaves it: same fields, but sized to grow.
 *
 * A copy rather than the cached weld itself, because the cache entry has to
 * stay pristine for the next dab of the same stroke to build on.
 */
type Work = {
  position: Float32Array
  vertexCount: number
  corner: Uint32Array
  cornerNormal: Float32Array
  group: Uint32Array
  triangleCount: number
}

function grow32(array: Float32Array, needed: number): Float32Array {
  if (array.length >= needed) return array
  const next = new Float32Array(Math.max(needed, array.length * 2))
  next.set(array)
  return next
}

function growU32(array: Uint32Array, needed: number): Uint32Array {
  if (array.length >= needed) return array
  const next = new Uint32Array(Math.max(needed, array.length * 2))
  next.set(array)
  return next
}

function workingCopy(welded: Welded): Work {
  return {
    position: welded.position.slice(),
    vertexCount: welded.vertexCount,
    corner: welded.corner.slice(),
    cornerNormal: welded.cornerNormal.slice(),
    group: welded.group.slice(),
    triangleCount: welded.triangleCount,
  }
}

// --- Refinement -------------------------------------------------------------

/**
 * Split every edge under a dab that is longer than the brush can resolve.
 *
 * Midpoint subdivision, which is EXACTLY SHAPE-PRESERVING: the new vertex sits
 * on the straight edge it came from, so a refined flat face is the same flat
 * face and a refined cube is the same cube. Nothing here changes what the
 * object looks like -- it only buys the vertices the melting needs to have
 * something to move.
 *
 * That property is also why every dab of a call can be refined UP FRONT, before
 * any of them has melted anything: refinement and displacement commute, so
 * hoisting all of it to the top costs one pass over the triangles for the whole
 * stroke instead of one per dab.
 *
 * The midpoint of a shared edge is created ONCE and handed to both triangles,
 * which is what keeps the surface closed. Two independently-created midpoints
 * at the same place would weld back together by position -- until the torch
 * moved one of them.
 */
function refine(work: Work, dabs: ErodeDab[]): void {
  const centres = dabs.map((d) => new Vector3(...d.at))
  const a = new Vector3()
  const b = new Vector3()
  const ab = new Vector3()
  const ac = new Vector3()

  /**
   * How near a dab comes to the EDGE, not to its ends.
   *
   * The distinction is the whole tool. A cube's top face is two triangles whose
   * edges run a whole span; hold a 5 mm brush against the middle of it and not
   * one endpoint is within reach, so an endpoint test splits nothing, refines
   * nothing, and the torch does visibly nothing at all. What matters is whether
   * the brush touches the edge ANYWHERE along it.
   */
  const nearestOnEdge = (centre: Vector3): number => {
    ab.subVectors(b, a)
    const lengthSq = ab.lengthSq()
    if (lengthSq < 1e-30) return centre.distanceToSquared(a)
    ac.subVectors(centre, a)
    const t = Math.max(0, Math.min(1, ac.dot(ab) / lengthSq))
    return ac.addVectors(a, ab.multiplyScalar(t)).sub(centre).lengthSq()
  }

  /**
   * The cells the stroke covers, as a set.
   *
   * Refinement asks one question -- is this edge inside the region the torch is
   * about to touch -- and that is a question about the REGION, not about the
   * dabs that painted it. Asking it per dab makes the cost of a frame grow with
   * how long the user has been holding the button down: a stroke of four
   * hundred dabs spent eighty milliseconds a frame testing edges against dabs
   * at the other end of the stroke. Asking it of a set of cells costs the same
   * whether the stroke is four dabs long or four thousand.
   *
   * A dab marks its own cell AND the twenty-six around it, with the cell one
   * REACH across. So every point within reach of any dab is certainly inside a
   * marked cell -- the test never misses a region that wants refining. It can
   * mark a little more than the strict reach, which costs a ring of slightly
   * finer triangles just outside the brush and is invisible.
   */
  const maxReach = Math.max(...dabs.map((d) => d.radius * REFINE_REACH))
  const minTarget = Math.min(...dabs.map((d) => d.radius * REFINE_EDGE))
  const cell = maxReach
  const cellKey = (x: number, y: number, z: number) =>
    ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0)

  // The box the whole stroke lives in. Six comparisons, and on any object
  // bigger than the brush it rejects almost every edge in the mesh before the
  // walk below is reached -- which is what keeps the first round, the only one
  // that looks at the whole object, off the frame budget of an imported model.
  const lo = new Vector3(Infinity, Infinity, Infinity)
  const hi = new Vector3(-Infinity, -Infinity, -Infinity)
  for (let d = 0; d < dabs.length; d++) {
    const reach = dabs[d].radius * REFINE_REACH
    lo.set(
      Math.min(lo.x, centres[d].x - reach),
      Math.min(lo.y, centres[d].y - reach),
      Math.min(lo.z, centres[d].z - reach)
    )
    hi.set(
      Math.max(hi.x, centres[d].x + reach),
      Math.max(hi.y, centres[d].y + reach),
      Math.max(hi.z, centres[d].z + reach)
    )
  }

  const covered = new Set<number>()
  for (const centre of centres) {
    const cx = Math.floor(centre.x / cell)
    const cy = Math.floor(centre.y / cell)
    const cz = Math.floor(centre.z / cell)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          covered.add(cellKey(cx + dx, cy + dy, cz + dz))
        }
      }
    }
  }

  /**
   * Whether an edge is long enough to want splitting and near enough to care.
   *
   * The length test comes first because it is one subtraction and it rejects
   * almost everything: once a patch has converged, every edge in it fails here
   * and the round ends. The region test walks the edge in half-cell steps,
   * which is a handful of lookups for a refined edge and a few dozen for one of
   * the metre-long edges a bare cube arrives with.
   */
  const wanted = (va: number, vb: number): boolean => {
    a.fromArray(work.position, va * 3)
    b.fromArray(work.position, vb * 3)
    const lengthSq = a.distanceToSquared(b)
    if (lengthSq <= minTarget * minTarget) return false
    if (
      Math.max(a.x, b.x) < lo.x ||
      Math.min(a.x, b.x) > hi.x ||
      Math.max(a.y, b.y) < lo.y ||
      Math.min(a.y, b.y) > hi.y ||
      Math.max(a.z, b.z) < lo.z ||
      Math.min(a.z, b.z) > hi.z
    ) {
      return false
    }

    const length = Math.sqrt(lengthSq)
    const steps = Math.max(1, Math.ceil((length / cell) * 2))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const x = Math.floor((a.x + (b.x - a.x) * t) / cell)
      const y = Math.floor((a.y + (b.y - a.y) * t) / cell)
      const z = Math.floor((a.z + (b.z - a.z) * t) / cell)
      if (!covered.has(cellKey(x, y, z))) continue
      // In the region. Now the exact question, against the dabs that could
      // actually be responsible -- which is only ever asked for an edge already
      // known to be in the right neighbourhood.
      for (let d = 0; d < dabs.length; d++) {
        const target = dabs[d].radius * REFINE_EDGE
        if (lengthSq <= target * target) continue
        const reach = dabs[d].radius * REFINE_REACH
        if (nearestOnEdge(centres[d]) <= reach * reach) return true
      }
      return false
    }
    return false
  }

  // An edge names itself by its two welded endpoints, packed into one number.
  // MAX_VERTICES is under 2^20, so the product stays an exact integer and the
  // map needs no strings -- which matters, because this is the inner loop of
  // the inner loop.
  const edgeKey = (va: number, vb: number) =>
    va < vb ? va * 1048576 + vb : vb * 1048576 + va

  const normalAt = (t: number, slot: number, out: Vector3): Vector3 =>
    out.fromArray(work.cornerNormal, (t * 3 + slot) * 3)

  const setCorner = (t: number, slot: number, v: number, n: Vector3): void => {
    work.corner[t * 3 + slot] = v
    const o = (t * 3 + slot) * 3
    work.cornerNormal[o] = n.x
    work.cornerNormal[o + 1] = n.y
    work.cornerNormal[o + 2] = n.z
  }

  /** Room for `count` more triangles, grown geometrically so a long stroke does
   *  not reallocate once per split. */
  const reserve = (count: number): void => {
    const needed = (work.triangleCount + count) * 3
    work.corner = growU32(work.corner, needed)
    work.cornerNormal = grow32(work.cornerNormal, needed * 3)
    work.group = growU32(work.group, work.triangleCount + count)
  }

  /** Whether the p-q diagonal of a quad is the shorter of the two. */
  const shorter = (p: number, q: number, r: number, s: number): boolean => {
    const dp = new Vector3().fromArray(work.position, p * 3)
    const dq = new Vector3().fromArray(work.position, q * 3)
    const dr = new Vector3().fromArray(work.position, r * 3)
    const ds = new Vector3().fromArray(work.position, s * 3)
    return dp.distanceToSquared(dq) <= dr.distanceToSquared(ds)
  }

  // Everything is a candidate on the first round; after that only what was just
  // split can want splitting again. A triangle whose edges were all short
  // enough this round has not changed, and neither have the dabs, so it can
  // never come back -- which is what keeps the later rounds cheap enough to
  // afford ten of them.
  let candidates: number[] = []
  for (let t = 0; t < work.triangleCount; t++) candidates.push(t)

  const n0 = new Vector3()
  const n1 = new Vector3()
  const n2 = new Vector3()
  const m0 = new Vector3()
  const m1 = new Vector3()
  const m2 = new Vector3()

  for (let round = 0; round < REFINE_ROUNDS; round++) {
    if (candidates.length === 0 || work.vertexCount >= MAX_VERTICES) return

    // Pass one: mint the midpoints, over the candidates alone. Shared by both
    // triangles either side of an edge, which is what keeps the surface closed
    // -- two independently created midpoints at the same place would weld back
    // together by position, right up until the torch moved one of them.
    const midpoints = new Map<number, number>()
    for (const t of candidates) {
      // NO FLOOR ON HOW THIN A TRIANGLE MAY BE and still be refined, and it is
      // worth saying why, because a floor is the obvious guard and it is wrong.
      //
      // Splitting only the over-long edges does leave slivers -- the leftover
      // piece at the corner between two split edges is closed off by an edge
      // joining their midpoints, which is half the length of the side that was
      // NOT split, so the narrow dimension halves every round while the target
      // only ever limits the long one. Refusing to refine a triangle already
      // thinner than one dab's bite stops that, and it also freezes every
      // triangle that was BORN thin: the ones crowding a cone's apex, where the
      // surface converges and the tessellation converges with it. The brush
      // then moves vertices belonging to triangles it had declined to refine,
      // which is precisely how a surface gets folded.
      //
      // What the slivers actually needed was not to be prevented but to be
      // survivable, and they are -- see RELAX_CONDITION, which slides vertices
      // back apart across the surface on every dab whatever the user has set
      // Smoothing to. With that in place a cylinder at Smoothing zero folds
      // nothing over eight dabs, and neither does a cone.
      for (let e = 0; e < 3; e++) {
        const va = work.corner[t * 3 + e]
        const vb = work.corner[t * 3 + ((e + 1) % 3)]
        const key = edgeKey(va, vb)
        if (midpoints.has(key)) continue
        if (!wanted(va, vb)) continue
        if (work.vertexCount >= MAX_VERTICES) continue
        const index = work.vertexCount++
        work.position = grow32(work.position, work.vertexCount * 3)
        for (let k = 0; k < 3; k++) {
          work.position[index * 3 + k] =
            (work.position[va * 3 + k] + work.position[vb * 3 + k]) / 2
        }
        midpoints.set(key, index)
      }
    }
    if (midpoints.size === 0) return

    // Pass two: close every triangle over whatever midpoints landed on its
    // edges. This sweeps the WHOLE mesh, not just the candidates: a triangle
    // that wanted no split of its own still has to be re-triangulated when a
    // neighbour split their shared edge, or the two are left meeting at a
    // T-junction -- a crack that opens the moment the torch moves the midpoint.
    // The sweep is three integer map lookups per triangle and touches nothing
    // else, so it is far cheaper than the geometry test above.
    const next: number[] = []
    const limit = work.triangleCount
    for (let t = 0; t < limit; t++) {
      const v0 = work.corner[t * 3]
      const v1 = work.corner[t * 3 + 1]
      const v2 = work.corner[t * 3 + 2]
      // -1 rather than undefined for "this edge did not split": the branch
      // chain below reads far better on a plain number, and TypeScript cannot
      // narrow an optional through it anyway.
      const e0 = midpoints.get(edgeKey(v0, v1)) ?? -1
      const e1 = midpoints.get(edgeKey(v1, v2)) ?? -1
      const e2 = midpoints.get(edgeKey(v2, v0)) ?? -1
      if (e0 < 0 && e1 < 0 && e2 < 0) continue

      normalAt(t, 0, n0)
      normalAt(t, 1, n1)
      normalAt(t, 2, n2)
      // A midpoint's normal is the average of the two it sits between, which is
      // the interpolation the shading already does across that edge -- so a
      // refined face shades exactly like the one it replaced.
      m0.addVectors(n0, n1).normalize()
      m1.addVectors(n1, n2).normalize()
      m2.addVectors(n2, n0).normalize()

      const group = work.group[t]
      const emit: [number, number, number, Vector3, Vector3, Vector3][] = []

      if (e0 >= 0 && e1 >= 0 && e2 >= 0) {
        emit.push(
          [v0, e0, e2, n0, m0, m2],
          [e0, v1, e1, m0, n1, m1],
          [e2, e1, v2, m2, m1, n2],
          [e0, e1, e2, m0, m1, m2]
        )
      } else if (e0 >= 0 && e1 < 0 && e2 < 0) {
        emit.push([v0, e0, v2, n0, m0, n2], [e0, v1, v2, m0, n1, n2])
      } else if (e1 >= 0 && e0 < 0 && e2 < 0) {
        emit.push([v1, e1, v0, n1, m1, n0], [e1, v2, v0, m1, n2, n0])
      } else if (e2 >= 0 && e0 < 0 && e1 < 0) {
        emit.push([v2, e2, v1, n2, m2, n1], [e2, v0, v1, m2, n0, n1])
      } else if (e0 < 0) {
        // v0-v1 survives; the quad v0-v1-e1-e2 is cut along the shorter
        // diagonal, which is the usual rule and keeps the pieces from turning
        // into needles.
        emit.push([v2, e2, e1, n2, m2, m1])
        if (shorter(v0, e1, v1, e2)) {
          emit.push([v0, v1, e1, n0, n1, m1], [v0, e1, e2, n0, m1, m2])
        } else {
          emit.push([v0, v1, e2, n0, n1, m2], [v1, e1, e2, n1, m1, m2])
        }
      } else if (e1 < 0) {
        emit.push([v0, e0, e2, n0, m0, m2])
        if (shorter(v1, e2, v2, e0)) {
          emit.push([v1, v2, e2, n1, n2, m2], [v1, e2, e0, n1, m2, m0])
        } else {
          emit.push([v1, v2, e0, n1, n2, m0], [v2, e2, e0, n2, m2, m0])
        }
      } else {
        emit.push([v1, e1, e0, n1, m1, m0])
        if (shorter(v2, e0, v0, e1)) {
          emit.push([v2, v0, e0, n2, n0, m0], [v2, e0, e1, n2, m0, m1])
        } else {
          emit.push([v2, v0, e1, n2, n0, m1], [v0, e0, e1, n0, m0, m1])
        }
      }

      // The first piece takes the original's slot and the rest are appended, so
      // a sweep that splits one triangle in a hundred does a hundred map
      // lookups and four writes rather than rebuilding the whole mesh.
      reserve(emit.length - 1)
      for (let i = 0; i < emit.length; i++) {
        const slot = i === 0 ? t : work.triangleCount++
        const piece = emit[i]
        setCorner(slot, 0, piece[0], piece[3])
        setCorner(slot, 1, piece[1], piece[4])
        setCorner(slot, 2, piece[2], piece[5])
        work.group[slot] = group
        next.push(slot)
      }
    }

    candidates = next
  }
}

// --- Adjacency --------------------------------------------------------------

/**
 * Who each vertex's neighbours are, and which triangles it belongs to, as two
 * CSR tables.
 *
 * Built once per call rather than per dab: refinement has already finished by
 * the time this runs, so the topology is fixed for every dab that follows and
 * only the positions move.
 *
 * The neighbour list is not deduplicated. An interior edge is walked once from
 * each of the two triangles sharing it, so every neighbour appears twice and
 * the unweighted average -- which is all the relaxation asks for -- is
 * unchanged. Deduplicating would cost a set per vertex to arrive at the same
 * number.
 */
type Adjacency = {
  neighbourStart: Uint32Array
  neighbour: Uint32Array
  triangleStart: Uint32Array
  triangle: Uint32Array
}

function buildAdjacency(work: Work): Adjacency {
  const v = work.vertexCount
  const t = work.triangleCount

  const neighbourStart = new Uint32Array(v + 1)
  const triangleStart = new Uint32Array(v + 1)
  for (let i = 0; i < t * 3; i++) {
    neighbourStart[work.corner[i] + 1] += 2
    triangleStart[work.corner[i] + 1] += 1
  }
  for (let i = 0; i < v; i++) {
    neighbourStart[i + 1] += neighbourStart[i]
    triangleStart[i + 1] += triangleStart[i]
  }

  const neighbour = new Uint32Array(neighbourStart[v])
  const triangle = new Uint32Array(triangleStart[v])
  const nFill = neighbourStart.slice(0, v)
  const tFill = triangleStart.slice(0, v)

  for (let i = 0; i < t; i++) {
    const a = work.corner[i * 3]
    const b = work.corner[i * 3 + 1]
    const c = work.corner[i * 3 + 2]
    triangle[tFill[a]++] = i
    triangle[tFill[b]++] = i
    triangle[tFill[c]++] = i
    neighbour[nFill[a]++] = b
    neighbour[nFill[a]++] = c
    neighbour[nFill[b]++] = a
    neighbour[nFill[b]++] = c
    neighbour[nFill[c]++] = a
    neighbour[nFill[c]++] = b
  }

  return { neighbourStart, neighbour, triangleStart, triangle }
}

// --- Melting ----------------------------------------------------------------

/**
 * The surface normal at a vertex, read off the triangles that meet there.
 *
 * Computed from the CURRENT positions rather than taken from the stored corner
 * normals, and it has to be: the stored ones describe the shading of the
 * surface as it was, and by the second dab the surface is somewhere else. The
 * cross product is area-weighted for free, which is what stops a fan of slivers
 * outvoting the one big triangle a vertex actually lies on.
 *
 * At a cube's corner this returns the diagonal, so a torch held to a corner
 * sinks it straight in rather than favouring whichever face was listed first.
 */
const nA = new Vector3()
const nB = new Vector3()
const nC = new Vector3()
const nAB = new Vector3()
const nAC = new Vector3()

function vertexNormal(work: Work, adj: Adjacency, v: number, out: Vector3): Vector3 {
  out.set(0, 0, 0)
  const a = nA
  const b = nB
  const c = nC
  const ab = nAB
  const ac = nAC
  for (let i = adj.triangleStart[v]; i < adj.triangleStart[v + 1]; i++) {
    const t = adj.triangle[i]
    a.fromArray(work.position, work.corner[t * 3] * 3)
    b.fromArray(work.position, work.corner[t * 3 + 1] * 3)
    c.fromArray(work.position, work.corner[t * 3 + 2] * 3)
    ab.subVectors(b, a)
    ac.subVectors(c, a)
    out.addScaledVector(ab.cross(ac), 1)
  }
  if (out.lengthSq() < 1e-30) return out.set(0, 1, 0)
  return out.normalize()
}

/**
 * Hold the torch still for one instant: sink the surface under the brush, then
 * let it flow.
 *
 * The two steps are separate on purpose and the order matters. Sinking first
 * puts the material where the heat was; relaxing second is what turns the dent
 * into a melt rather than a punch -- it carries the displacement out past the
 * dab's own rim, rounds whatever creases the sinking just made, and softens any
 * edge that happened to be standing under the brush.
 *
 * Relaxation dies out at the same rim as the sinking, so nothing outside the
 * brush is touched -- but it does NOT follow the same curve on the way there.
 * It reaches further into the outer half of the dab, because that is where the
 * dent meets the surface it was cut from and where the crease it leaves has to
 * be blended away. See RELAX_SPREAD.
 *
 * A vertex is either in or out on the basis of where it sits NOW -- so a
 * surface that has already sagged out of reach stops being melted, which is
 * what makes a stroke deepen at a slowing rate instead of running away.
 */
/**
 * Every vertex the stroke could conceivably move, gathered once.
 *
 * Each dab has to find who is under it, and without this that search is a sweep
 * of the whole mesh -- so the cost of a stroke is its length times the size of
 * the object, and torching a corner of an imported model is as expensive as
 * torching a corner of a cube is cheap. The box is generous, and it is a box
 * rather than anything cleverer because the vertices MOVE as the stroke is
 * replayed: a structure that indexed them by position would go stale on the
 * first dab. The slack absorbs that -- nothing travels anywhere near a brush
 * radius from where it started.
 */
function reachableVertices(work: Work, dabs: ErodeDab[]): Uint32Array {
  let lox = Infinity
  let loy = Infinity
  let loz = Infinity
  let hix = -Infinity
  let hiy = -Infinity
  let hiz = -Infinity
  for (const d of dabs) {
    // Twice the radius: one for the brush itself, one for the slack above.
    const reach = d.radius * 2
    lox = Math.min(lox, d.at[0] - reach)
    loy = Math.min(loy, d.at[1] - reach)
    loz = Math.min(loz, d.at[2] - reach)
    hix = Math.max(hix, d.at[0] + reach)
    hiy = Math.max(hiy, d.at[1] + reach)
    hiz = Math.max(hiz, d.at[2] + reach)
  }

  const inside: number[] = []
  for (let v = 0; v < work.vertexCount; v++) {
    const x = work.position[v * 3]
    if (x < lox || x > hix) continue
    const y = work.position[v * 3 + 1]
    if (y < loy || y > hiy) continue
    const z = work.position[v * 3 + 2]
    if (z < loz || z > hiz) continue
    inside.push(v)
  }
  return Uint32Array.from(inside)
}

function dab(
  work: Work,
  adj: Adjacency,
  spec: ErodeDab,
  reachable: Uint32Array,
  touched: Uint8Array,
  /** Vertex -> its index in `hit`, or -1. Owned by the caller and handed back
   *  all -1, so the clamp below can ask about a neighbour without a Map. */
  slot: Int32Array
): void {
  const cx = spec.at[0]
  const cy = spec.at[1]
  const cz = spec.at[2]
  const radius = spec.radius
  const radiusSq = radius * radius
  // WHICH WAY THIS DAB PUSHES, and the only difference between the two tools.
  // Read once, into a plain +1/-1, because it multiplies a displacement in
  // three places and a branch in the innermost loop of a live drag would be
  // three branches the CPU has to predict per vertex per round.
  const dir = spec.raise ? 1 : -1

  // Who is under the brush, and how hard. Gathered once: both steps below want
  // the same set and the same weights. The arithmetic is written out rather
  // than run through a Vector3 because this is the innermost loop of a live
  // drag, and the wrapper costs more than the three subtractions it wraps.
  const hit: number[] = []
  const weight: number[] = []
  // The flow's weight, kept beside the sink's rather than derived per round --
  // there are three rounds and two uses in each. See RELAX_SPREAD.
  const spread: number[] = []
  for (let i = 0; i < reachable.length; i++) {
    const v = reachable[i]
    const dx = work.position[v * 3] - cx
    const dy = work.position[v * 3 + 1] - cy
    const dz = work.position[v * 3 + 2] - cz
    const distSq = dx * dx + dy * dy + dz * dz
    if (distSq >= radiusSq) continue
    const w = falloff(Math.sqrt(distSq) / radius)
    if (w <= 0) continue
    hit.push(v)
    weight.push(w)
    spread.push(Math.pow(w, RELAX_SPREAD))
    touched[v] = 1
  }
  if (hit.length === 0) return

  // Sink, or raise. Along each vertex's own normal rather than toward or away
  // from the brush centre: a torch eats into the surface it is pointed at, and
  // pulling toward a point would drag a flat face into a cone aimed at wherever
  // the sphere happened to be centred -- and pushing away from one would blow
  // the same face out into a dome that has nothing to do with the surface. The
  // normal is what makes either tool follow the shape it is held against.
  const normal = new Vector3()
  const bite = spec.heat * radius * DAB_BITE
  const normals = new Float32Array(hit.length * 3)

  // EVERY NORMAL IS READ BEFORE ANY VERTEX MOVES, and the two loops below may
  // not be folded back into one.
  //
  // A vertex normal is derived from where its neighbours are. Reading and
  // moving in the same pass means vertex n is aimed using a surface that
  // vertices 0..n-1 have already dented -- so the direction each vertex sinks
  // along depends on the order they happen to sit in the buffer, and on a mesh
  // with any thin triangles in it that dependence is not small. It inverted
  // normals outright: whole patches of a cone and a cylinder sank OUTWARD into
  // spikes, because by the time their turn came the neighbours they were
  // measured against had moved past them.
  //
  // Jacobi, therefore -- exactly what the relaxation below already does, and
  // for exactly the same reason. The normals here are also the ones the flow
  // reads, so both halves of a dab now judge themselves against the surface the
  // user actually aimed at.
  for (let i = 0; i < hit.length; i++) {
    vertexNormal(work, adj, hit[i], normal)
    normals[i * 3] = normal.x
    normals[i * 3 + 1] = normal.y
    normals[i * 3 + 2] = normal.z
  }
  const step = new Float32Array(hit.length)
  for (let i = 0; i < hit.length; i++) step[i] = bite * weight[i]

  // NO EDGE MAY CHANGE LENGTH FASTER THAN THE FLOW CAN PUT IT BACK. Each
  // vertex is about to move along its own normal, so an edge whose two ends
  // disagree about which way that is gets shorter -- or, under the sculpt
  // tool at a convex crease, longer. The check is what the edge gains or loses
  // to this dab, measured along itself, against DAB_CLOSE of its length. One
  // scale for the whole dab, so the dish keeps the shape the falloff asked for.
  //
  // Edges to a vertex the brush did NOT reach count too, and they are the ones
  // that usually bind: the surface just outside the brush is pinned where the
  // evaluator left it, so the step at the rim is borne entirely by the vertex
  // inside it. That step is the cliff this clamp exists to stop.
  let scale = 1
  for (let i = 0; i < hit.length; i++) slot[hit[i]] = i
  for (let i = 0; i < hit.length; i++) {
    const v = hit[i]
    const vx = dir * normals[i * 3] * step[i]
    const vy = dir * normals[i * 3 + 1] * step[i]
    const vz = dir * normals[i * 3 + 2] * step[i]
    for (let k = adj.neighbourStart[v]; k < adj.neighbourStart[v + 1]; k++) {
      const n = adj.neighbour[k]
      const ex = work.position[n * 3] - work.position[v * 3]
      const ey = work.position[n * 3 + 1] - work.position[v * 3 + 1]
      const ez = work.position[n * 3 + 2] - work.position[v * 3 + 2]
      const length = Math.sqrt(ex * ex + ey * ey + ez * ez)
      if (length < 1e-12) continue
      const j = slot[n]
      const nx = j < 0 ? 0 : dir * normals[j * 3] * step[j]
      const ny = j < 0 ? 0 : dir * normals[j * 3 + 1] * step[j]
      const nz = j < 0 ? 0 : dir * normals[j * 3 + 2] * step[j]
      // How much the edge's own length changes under this dab, measured along
      // itself. The MAGNITUDE, because both directions are limited and by the
      // same amount: the ends closing is the torch's failure mode and the ends
      // parting is the sculpt tool's. See DAB_CLOSE.
      const change =
        Math.abs(((nx - vx) * ex + (ny - vy) * ey + (nz - vz) * ez) / length)
      const room = DAB_CLOSE * length
      if (change > room) scale = Math.min(scale, room / change)
    }
  }
  for (let i = 0; i < hit.length; i++) slot[hit[i]] = -1
  if (scale < 1) for (let i = 0; i < hit.length; i++) step[i] *= scale

  for (let i = 0; i < hit.length; i++) {
    const v = hit[i]
    work.position[v * 3] += dir * normals[i * 3] * step[i]
    work.position[v * 3 + 1] += dir * normals[i * 3 + 1] * step[i]
    work.position[v * 3 + 2] += dir * normals[i * 3 + 2] * step[i]
  }

  // Flow. Jacobi rather than Gauss-Seidel -- every vertex reads the positions
  // as they were at the start of the round -- so the result does not depend on
  // the order the vertices happen to be stored in, which is what keeps the same
  // stroke on the same object producing the same mesh every time it is
  // replayed from the document.
  // Clamped HERE rather than trusted from the document, so a dab that arrives
  // from anywhere -- an older file, a headless caller, a hand-written test --
  // gets a surface that holds together. See BRUSH_SMOOTH_MIN.
  const flow = Math.min(Math.max(spec.smooth, BRUSH_SMOOTH_MIN), 1) * RELAX_RATE
  // Across the surface, the greater of the two -- so at full Smoothing this is
  // exactly the single rate it used to be and nothing about a molten stroke
  // changes, while at zero it is the housekeeping alone.
  const slide = Math.max(flow, RELAX_CONDITION)
  const before = new Float32Array(hit.length * 3)
  for (let round = 0; round < RELAX_ROUNDS; round++) {
    for (let i = 0; i < hit.length; i++) {
      const v = hit[i]
      before[i * 3] = work.position[v * 3]
      before[i * 3 + 1] = work.position[v * 3 + 1]
      before[i * 3 + 2] = work.position[v * 3 + 2]
    }
    for (let i = 0; i < hit.length; i++) {
      const v = hit[i]
      const start = adj.neighbourStart[v]
      const end = adj.neighbourStart[v + 1]
      if (end === start) continue
      let sx = 0
      let sy = 0
      let sz = 0
      for (let k = start; k < end; k++) {
        const n = adj.neighbour[k]
        sx += work.position[n * 3]
        sy += work.position[n * 3 + 1]
        sz += work.position[n * 3 + 2]
      }
      const count = end - start
      const lx = sx / count - before[i * 3]
      const ly = sy / count - before[i * 3 + 1]
      const lz = sz / count - before[i * 3 + 2]

      // The step is split ACROSS the surface and INTO it, because the two do
      // different jobs and answer to different things.
      //
      // Across (tangential) is housekeeping: it slides vertices apart without
      // moving the surface, and it always runs -- see RELAX_CONDITION.
      //
      // Into (normal) is the melt itself, and it is Smoothing's to sell. WHICH
      // WAY it points decides how much of it is allowed, and that asymmetry is
      // what makes the torch able to dig. Inside a dish the average of the
      // neighbours lies straight back OUT, so the flow tries to fill in what
      // the heat just sank; left symmetric the two reach equilibrium almost at
      // once, and the dish stops at two thirds of a brush radius however long
      // the user holds the torch there. Rounding a corner is the INWARD half --
      // the neighbours of a sharp convex vertex lie below it -- so creases
      // still soften at full strength and only the hollow-filling is held
      // back. Which is also what molten plastic does: it slumps off a high
      // point readily and does not flow back up into a hollow by itself.
      //
      // THE ASYMMETRY IS MEASURED AGAINST THE DAB, not against the surface,
      // which is what carries all of the above over to the sculpt tool without
      // restating any of it. The half that is held back is the half that undoes
      // the dab -- outward inside a dish the torch just sank, downward on top
      // of a bead the sculpt tool just raised -- so `into * dir < 0` is one
      // test for both. Written the other way round, with the torch's `into > 0`
      // left hard-coded, a bead would be flattened by its own smoothing exactly
      // as fast as it was drawn, and the sculpt tool at full Smoothing would
      // have been a tool that did nothing.
      const nx = normals[i * 3]
      const ny = normals[i * 3 + 1]
      const nz = normals[i * 3 + 2]
      const into = lx * nx + ly * ny + lz * nz
      const keep = (into * dir < 0 ? RELAX_FILL : 1) * flow * spread[i]
      const across = slide * spread[i]

      work.position[v * 3] = before[i * 3] + (lx - nx * into) * across + nx * into * keep
      work.position[v * 3 + 1] =
        before[i * 3 + 1] + (ly - ny * into) * across + ny * into * keep
      work.position[v * 3 + 2] =
        before[i * 3 + 2] + (lz - nz * into) * across + nz * into * keep
    }
  }
}

// --- Output -----------------------------------------------------------------

/**
 * Back to the triangle soup the rest of the pipeline speaks, with the melted
 * region re-shaded and everything else left exactly as it arrived.
 *
 * Re-shading is confined to corners whose vertex the torch actually moved,
 * PLUS one ring beyond them, because a corner sharing a triangle with a moved
 * vertex is looking at a triangle that has changed shape. Past that ring the
 * original corner normals go back out untouched, which is what keeps a cube
 * that was torched on one face crisp on the other five.
 *
 * Inside the ring the normal becomes the smooth vertex normal, with no crease
 * angle consulted. That is the melt: molten plastic has no sharp edges, so the
 * one place this tool should NOT preserve a crease is the place it just poured.
 */
function toGeometry(work: Work, adj: Adjacency, touched: Uint8Array): BufferGeometry {

  // One ring out from anything that moved.
  const shade = new Uint8Array(work.vertexCount)
  for (let t = 0; t < work.triangleCount; t++) {
    const a = work.corner[t * 3]
    const b = work.corner[t * 3 + 1]
    const c = work.corner[t * 3 + 2]
    if (touched[a] || touched[b] || touched[c]) {
      shade[a] = 1
      shade[b] = 1
      shade[c] = 1
    }
  }

  const smoothed = new Map<number, Vector3>()
  const normal = new Vector3()
  for (let v = 0; v < work.vertexCount; v++) {
    if (!shade[v]) continue
    smoothed.set(v, vertexNormal(work, adj, v, normal).clone())
  }

  // Triangles are emitted in group order so the result carries one contiguous
  // run per paint, which is the shape `normalizeGeometry` and the evaluator
  // both expect. Refinement appends split pieces at the end, so a mesh with
  // more than one paint generally does need reordering -- but the common object
  // has exactly one, and sorting fifty thousand indices to discover they were
  // already in order is a visible part of a frame. Checked first, therefore.
  let ordered = true
  for (let t = 1; t < work.triangleCount && ordered; t++) {
    if (work.group[t] < work.group[t - 1]) ordered = false
  }
  const order: number[] = []
  for (let t = 0; t < work.triangleCount; t++) order.push(t)
  if (!ordered) order.sort((a, b) => work.group[a] - work.group[b] || a - b)

  const position = new Float32Array(work.triangleCount * 9)
  const normals = new Float32Array(work.triangleCount * 9)
  const groups: { start: number; count: number; materialIndex: number }[] = []
  let cursor = 0

  for (const t of order) {
    const material = work.group[t]
    const last = groups[groups.length - 1]
    if (last && last.materialIndex === material) last.count += 3
    // `cursor` counts VERTICES, not floats -- it is stepped by three per
    // triangle and the writes below scale it by three themselves. A group start
    // is a vertex offset too, so multiplying here put every group after the
    // first three times too far along the buffer. With one paint the first
    // group starts at zero and the mistake was invisible; with two, the second
    // group pointed off the end of the mesh and the renderer drew garbage --
    // which is what merging a cube and a sphere and then torching it did.
    else groups.push({ start: cursor, count: 3, materialIndex: material })

    for (let slot = 0; slot < 3; slot++) {
      const v = work.corner[t * 3 + slot]
      const o = (cursor + slot) * 3
      position[o] = work.position[v * 3]
      position[o + 1] = work.position[v * 3 + 1]
      position[o + 2] = work.position[v * 3 + 2]
      const melted = smoothed.get(v)
      if (melted) {
        normals[o] = melted.x
        normals[o + 1] = melted.y
        normals[o + 2] = melted.z
      } else {
        const c = (t * 3 + slot) * 3
        normals[o] = work.cornerNormal[c]
        normals[o + 1] = work.cornerNormal[c + 1]
        normals[o + 2] = work.cornerNormal[c + 2]
      }
    }
    cursor += 3
  }

  const geom = new BufferGeometry()
  geom.setAttribute('position', new BufferAttribute(position, 3))
  geom.setAttribute('normal', new BufferAttribute(normals, 3))
  for (const g of groups) geom.addGroup(g.start, g.count, g.materialIndex)
  return geom
}

// --- Entry point ------------------------------------------------------------

/**
 * Every dab in order, replayed onto a fresh copy of the geometry.
 *
 * IN ORDER, and both brushes through the one list: a bead drawn across a groove
 * and a groove cut across a bead are different surfaces, and the only thing
 * that tells them apart is which dab was laid down second. See
 * `SceneObject.erosion`.
 *
 * REPLAYED, not accumulated: the document holds the strokes and this derives
 * the mesh from them, exactly as the rest of the pipeline derives a solid from
 * its features. That is what makes undo work, what makes a torched object still
 * a document rather than a bag of triangles, and what makes the same stroke
 * produce the same mesh on any machine.
 *
 * The caller owns the returned geometry. With no dabs it gets `null` and should
 * keep the geometry it already has -- an object nobody has torched must not pay
 * so much as a copy for the existence of this file.
 */
export function erodeGeometry(geom: BufferGeometry, dabs: ErodeDab[]): BufferGeometry | null {
  if (dabs.length === 0) return null
  const welded = weld(geom)
  if (welded.triangleCount === 0) return null

  const work = workingCopy(welded)
  refine(work, dabs)
  const adj = buildAdjacency(work)
  const touched = new Uint8Array(work.vertexCount)
  const reachable = reachableVertices(work, dabs)
  const slot = new Int32Array(work.vertexCount).fill(-1)
  for (const spec of dabs) dab(work, adj, spec, reachable, touched, slot)
  return toGeometry(work, adj, touched)
}

/**
 * The same strokes -- of either brush -- carried onto a base that has just
 * changed size.
 *
 * A dab is a POSITION AND A REACH in object units -- not an anchor in some
 * surface's parameter space -- so a resize that leaves them alone slides the
 * whole surface out from under the marks: torch a dent into a cube, pull the
 * cube wider, and the dent is left melting the empty middle of a solid that has
 * grown past it. Everything else the object carries already travels this way; a
 * cut's origin is scaled in `scaleSolids`, a sketch is reseated by `conform`,
 * and this is the third of them.
 *
 * The centre scales per axis, so a mark on a face stays on that face. THE
 * RADIUS CANNOT: a sphere brush has no way to become an ellipsoid, and there is
 * nowhere in an `ErodeDab` to write one down. It takes the geometric mean of
 * the three factors instead -- the single uniform scale that would change the
 * object's volume by as much as the resize did. Under the scale ring, where all
 * three factors are one number, that IS that number and the melt scales
 * exactly; pull one axis alone and the dish keeps very nearly the size it had,
 * which is the honest answer for a mark that cannot be stretched.
 */
export function carryErosion(
  dabs: ErodeDab[],
  from: BaseSolid,
  to: BaseSolid
): ErodeDab[] {
  const [fx, fy, fz] = resizeFactors(from, to)
  if (fx === 1 && fy === 1 && fz === 1) return dabs
  const reach = Math.cbrt(fx * fy * fz)
  // Annotated so the centre lands as a `Vec3` tuple rather than a number[].
  return dabs.map((d): ErodeDab => ({
    ...d,
    at: [d.at[0] * fx, d.at[1] * fy, d.at[2] * fz],
    radius: d.radius * reach,
  }))
}

/** For the checks, which need a cold cache to time a weld honestly. */
export function resetErodeCache(): void {
  weldCache = new WeakMap()
}
