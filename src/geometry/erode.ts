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
 * A THIRD BRUSH RIDES THE SAME SPHERE and takes neither direction: the
 * Smoother, which rounds a corner off and does nothing else. It is the flow
 * above with the bite taken out -- see `roundOff` -- and it lives here rather
 * than in a file of its own because rounding a corner is not something the
 * other two do BESIDE melting and raising, it is something they cannot help
 * doing WHILE they melt and raise. What the Smoother adds is a PLACE TO STOP:
 * it eases every corner under it to one radius and then leaves the surface
 * alone, where the other two go on moving it for as long as they are held.
 *
 * What follows describes the torch, because that is the tool the tuning below
 * was measured against; read every "sink" as "move the surface the way this dab
 * is pointed" and it is equally the description of the other one.
 *
 * NOT a boolean. Subtracting a sphere would leave a crisp spherical bite with a
 * sharp circular rim, which is a drill hole -- the one thing this tool is not.
 * That holds even where the flame goes all the way through: what opens there is
 * a hole with a melted lip, in the middle of a face that was already sagging
 * toward it, and not a shape anybody subtracted. Melting plastic does two
 * things at once, and both of them are here:
 *
 *   - the surface SAGS INWARD under the brush, hardest at the middle and
 *     tapering to nothing at the rim, so what is left is a dish rather than a
 *     crater with an edge, and
 *   - it RELAXES toward its own neighbours, which is surface tension written
 *     as arithmetic. That is what rounds a corner off, closes a sharp crease
 *     and gives the result the soft, poured look of something that flowed
 *     before it set.
 *
 * VERTICES MOVE, and that is how nearly all of the work is done. It buys three
 * things: the work is local, so a stroke costs the vertices under the brush and
 * not the object; everything outside the brush stays EXACTLY the geometry the
 * evaluator built, down to the float; and the mesh keeps its groups, so a
 * merged assembly comes out of the torch still wearing all of its colours.
 *
 * THE ONE THING MOVING VERTICES CANNOT DO IS RUN OUT OF MATERIAL, and a thin
 * wall is where that stops being an abstraction. Sinking is along each vertex
 * own normal, so on a panel the near face travels one way and the far face
 * travels back at it; with nothing to stop them they meet in the middle, pass
 * through each other and keep going, and what the user is left with is the
 * front of the panel bulging out of the back of it, inside out, creased and
 * unmendable. That is not a melt that went too far, it is a melt with no answer
 * for the case where the answer is a HOLE.
 *
 * So the torch punches through. When a dab would consume the last of the wall
 * under it, the material there is removed and the two faces are sewn into the
 * wall of a tunnel -- see `burnList` and `breakThrough` -- and the object comes
 * out closed, one hole larger. It is the only stage that changes the topology,
 * it is all-or-nothing, and it declines rather than leaving a rim it cannot
 * close. The sculpt tool never reaches it: raising drives the two faces of a
 * wall apart.
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
 * How much of the room in front of a vertex the Smoother may close in one dab.
 *
 * THE ONE PLACE THE SMOOTHER ADMITS IT CAN RUN OUT OF ROOM, and the answer the
 * torch gives with `burnList` asked of a tool that has no hole to offer. Round
 * the rim of a plate thinner than twice the target and the two rounds -- one
 * coming down the front face, one coming up the back -- are aimed at the same
 * material; round the bottom of a slot narrower than twice the target and the
 * two fills are aimed at the same air. Either way the surfaces arrive in the
 * same place and pass through each other, and what the user is left with is a
 * plate turned inside out by the tool that was supposed to take the edge off
 * it.
 *
 * A SHARE OF WHAT IS LEFT rather than a threshold, which is what makes it
 * safe without needing a threshold to be right. Each face may close a fifth of
 * the gap per dab, so the two of them together close two fifths and three
 * fifths survive -- every dab, however many are laid. The gap shrinks
 * geometrically and never reaches zero, so a rim too thin to round comes out
 * thin and rounded rather than crossed, and the tool stops being able to do
 * anything more to it. That is the honest outcome: there was no room for the
 * radius that was asked for, and what room there was has been used.
 *
 * A fifth, because it has to be small enough that three rounds of a dab cannot
 * spend it (they are capped against the same allowance, not each given it) and
 * large enough that the approach is not so slow it reads as the tool giving up
 * early. It costs nothing anywhere else: on any surface with a solid behind it
 * -- which is every surface that is not part of a thin wall -- the gap is
 * larger than anything this brush could travel, and the cap never binds.
 */
const ROUND_WALL = 0.2

/**
 * The tightest round the Smoother will make, as a share of its brush.
 *
 * A FLOOR ON THE TARGET, and it is a PERFORMANCE floor, which is the honest
 * name for it. The target is what the mesh has to be fine enough to carry --
 * see `refineEdge` -- and the refinement it asks for is spread over the whole
 * brush rather than laid along the corner, because refinement runs before
 * anything has moved and knows only where the dabs are. So the cost of a round
 * goes as the square of how much finer than the brush it is, and a Strength
 * near zero spends the entire vertex budget on an arc nobody can see.
 *
 * MEASURED at the WIDE end, because that is where a floor has to hold: a 3 cm
 * brush -- the torch's default, and three times the Smoother's own -- dragged a
 * hundred dabs along a cube's edge, against the torch over the same ground at
 * 59 ms. At a quarter the Smoother takes 109 ms, at a fifth 337, at a tenth
 * several seconds -- and erosion is REPLAYED from the document on every
 * evaluation, so that is not a one-off cost but the frame time for the rest of
 * the drag. A quarter is where it stops being about twice the torch and starts
 * being a stall. The tool opens at a centimetre and is far cheaper there; see
 * DEFAULT_SMOOTHER_RADIUS.
 *
 * It costs the user very little, because the answer to wanting a finer round is
 * a finer brush: the two dials are a size and a share of it, so the 1 cm brush
 * this tool opens with leaves a 2.5 mm round at the floor, and a 1 mm brush
 * leaves a quarter of a millimetre. And a finer brush is CHEAPER rather than dearer, since the
 * region it refines shrinks with it -- which is what makes "use a smaller
 * brush" real advice rather than a way of describing a limitation. What the
 * floor rules out is only the combination that was never going to work: a wide
 * brush asked for a hairline fillet.
 *
 * The panel offers nothing below it, so the number a user picks is the number
 * they get. It is the same bargain BRUSH_SMOOTH_MIN strikes on the other two.
 */
export const ROUND_MIN = 0.25

/**
 * The longest edge an ARC can be drawn with, as a share of the radius it is an
 * arc of.
 *
 * Coarser than REFINE_EDGE, which is the same question asked about a dish, and
 * the difference is what the two things are: a dish has a rim and a middle and
 * a falloff between them, so it needs vertices to shape; an arc is one radius
 * all the way along and the reading that produces it is normalised by the
 * spacing of the vertices themselves. Density buys shape in the first case and
 * almost nothing in the second.
 *
 * Measured over brushes from 0.3 to 2 and Strengths from 0.1 to 1: at three
 * fifths the arc lands between 0.87 and 1.07 of the radius asked for, which is
 * TIGHTER than the same sweep at two fifths, and it does it with a third of the
 * triangles. Finer than this is paying for a worse answer -- past a point the
 * mean-edge reading `span` takes starts over-reading a fan whose edges vary
 * more than they did, and the arc comes out short.
 */
const ROUND_EDGE = 0.6

/**
 * What the dial's target has to be multiplied by for the arc it leaves to
 * actually have that radius.
 *
 * A CALIBRATION, and it is here rather than folded into the arithmetic above
 * because the arithmetic above is exact and this is not. `keep` compares the
 * reading against h squared over twice the target, which is the relation a
 * SPHERE of that radius obeys. A fillet is not a sphere, it is a cylinder --
 * curved across the corner and dead straight along it -- and the reading is a
 * MEAN curvature, which on a cylinder is half the curvature of its section. So
 * half the answer belongs to the flat direction and the target has to be twice
 * what the sphere relation asks for. That much is derived.
 *
 * The rest is measured, and it comes from `span` being a MEAN edge length over
 * a fan that is not regular: squaring a mean over-reads what an average of
 * squares would give, so the reading comes out high, the corner is called
 * rounder than it is, and the tool stops early. Measured on a cube's edge at
 * brush radii from 0.5 to 2 and Strengths from 0.1 to 0.5, the arc landed at
 * 0.34 of the radius asked for -- flat across all of them, which is what makes
 * a single constant the right shape of fix rather than a fudge that holds at
 * one size.
 *
 * At 3.4 the arc lands between 0.89 and 1.36 of the radius asked for over every
 * combination this app offers. The residual is SCALE-INVARIANT and depends only
 * on the brush against the OBJECT -- measured at a brush a sixth of a cube's
 * side it reads 1.20 whether the cube is 60 cm or 6, and at half a side it
 * reads 0.92 at both -- which is the mesh outside the brush, pinned where the
 * evaluator left it, having more say the smaller the patch is. That is a
 * property of refining a region rather than a whole solid, and it is why the
 * panel calls this Strength rather than a radius in millimetres: it is a share
 * of the brush, held to about a fifth either way.
 *
 * What it cannot do is beat the BRUSH: a fillet of radius T needs about T of
 * surface either side of the corner to sit on, so a round approaching the size
 * of the sphere runs out of room and saturates -- Strength at 1 leaves about
 * 0.7 of a radius rather than a whole one, and pushing this number higher buys
 * a few hundredths for a lot of iteration. Which is the honest shape of the
 * tool: the brush is how much of the corner you are working, and it bounds what
 * you can ask for.
 */
const ROUND_GAIN = 3.4

/**
 * The thinnest wall the torch will leave standing, as a fraction of the brush
 * radius. Anything thinner is gone, and a hole is opened where it was.
 *
 * A threshold rather than a crossing test, and the number has to sit between
 * two things. It cannot be smaller than the tessellation can carry: the rim of
 * a fresh hole is a ring on each face of the wall, sewn into a tunnel whose
 * height is whatever wall is left at the ring, so a threshold near zero builds
 * that tunnel out of slivers. And it cannot be so large that the wall vanishes
 * before the user has seen it thin -- at a fifth of a radius a panel thinner
 * than the brush loses nine tenths of the brush footprint on the first dab,
 * which reads as the tool teleporting a hole in rather than burning one.
 *
 * Three twentieths, chosen on the stroke rather than on the press, because the
 * stroke is where the difference shows. On the panel this was written for --
 * three units across, a twelfth of a unit thick, under a third-of-a-unit brush
 * -- one press opens a hole of about three fifths of the brush radius, and
 * every press after widens it toward the brush. Dragged across, that is a
 * continuous slot in one pass.
 *
 * A SIXTEENTH WAS TRIED FIRST AND IT LEFT A LADDER. The pilot hole was a
 * quarter of the brush, the dabs are laid a third of a radius apart, and a
 * brush that has just opened a hole spends the next dab widening it rather than
 * eating forward -- so the stroke leapfrogged, and what a user got for one pass
 * was a row of perforations with the web still standing between them. Going
 * over it again cleared them, which is the honest behaviour of a small flame
 * and the wrong first impression for a tool that had just been asked to cut.
 *
 * A wall thicker than about two thirds of a radius never reaches this at all,
 * because that is as deep as one dab position can sink before the surface sags
 * out of its own reach: hold the torch on a thick solid and it still dishes
 * rather than drilling.
 */
const BURN_WALL = 0.15

/**
 * How squarely two surfaces must face each other to be two sides of one wall.
 *
 * The wall of a panel, a shell or a web is the case this is for, and there the
 * two faces are very nearly back to back. The number is not set at the obvious
 * right angle and a bit, because a CONE is the counter-example: at this app own
 * proportions the two flanks of a cone read as ninety-three degrees of facing,
 * which would make the last millimetre of its point a wall thin enough to burn.
 * A point burnt away leaves ONE rim rather than two -- see `breakThrough`, which
 * declines to open a wound it cannot close -- so nothing breaks; it just spends
 * the search on every dab and then does nothing. At a hundred and thirty-five
 * degrees the cone is out and every genuine wall this app can build is still in.
 */
const BURN_FACING = -0.7

/** Handed back where nothing burnt, which is almost every dab ever laid. */
const NO_BURN: number[] = []



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
  /**
   * Which triangles are the wall of a hole this stroke burnt, one flag each.
   *
   * Kept because a tunnel has to be treated as a single thing when the flame
   * comes back to it: burning part of one away leaves a boundary that is not a
   * pair of rims and cannot be sewn up. See `breakThrough`, which swallows the
   * rest of any tunnel it touches so the wound stays a shape it can close.
   */
  rim: Uint8Array
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

function growU8(array: Uint8Array, needed: number): Uint8Array {
  if (array.length >= needed) return array
  const next = new Uint8Array(Math.max(needed, array.length * 2))
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
    // Nothing has burnt yet, and on the overwhelming majority of strokes
    // nothing ever will -- this stays all zeroes and costs a byte a triangle.
    rim: new Uint8Array(welded.triangleCount),
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
/**
 * The longest edge a given dab can work with.
 *
 * For the two brushes that MOVE the surface it is a share of the brush, and it
 * has always been that: the dish is the size of the sphere, so the sphere is
 * what has to be resolved.
 *
 * The Smoother is the one whose mark is smaller than its brush. What it leaves
 * is a fillet of the TARGET radius, wherever inside the sphere the corner
 * happens to run -- and triangles sized for the sphere cannot carry an arc a
 * quarter of it. Held to the brush, a fine round under a fat brush did nothing
 * at all: the corner already read rounder than asked for, because the only
 * thing the reading had to go on was edges four times longer than the round. So
 * the Smoother asks about the round it is about to leave instead, and a fine
 * round under a fat brush now refines the way a fine round under a fine brush
 * always did.
 *
 * Bounded at BOTH ends, and both bounds are load-bearing. ROUND_MIN is the
 * floor, and it is what keeps a Strength of nearly nothing from spending the
 * whole vertex budget. REFINE_EDGE is the ceiling: a round approaching the size
 * of its own brush is being cut by a sphere barely wider than the arc, and the
 * density the torch already uses resolves that -- there is nothing to be gained
 * by refining a wide fillet more coarsely than a dish of the same size.
 */
function refineEdge(d: ErodeDab): number {
  if (d.round === undefined) return d.radius * REFINE_EDGE
  return d.radius * Math.min(Math.max(d.round, ROUND_MIN) * ROUND_EDGE, REFINE_EDGE)
}

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
  const minTarget = Math.min(...dabs.map(refineEdge))
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
        const target = refineEdge(dabs[d])
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
    work.rim = growU8(work.rim, work.triangleCount + count)
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

/** Who is under the brush this instant, and how hard. */
type Under = {
  /** The vertices in reach, in buffer order. */
  hit: number[]
  /** The falloff at each, 1 in the middle and 0 at the rim. */
  weight: number[]
  /** The same falloff opened out, which is what the FLOW is weighted by rather
   *  than what the sinking is. See RELAX_SPREAD. */
  spread: number[]
}

/**
 * Gather the vertices one dab reaches, with their weights.
 *
 * Its own function because all three brushes ask exactly this question and
 * would otherwise ask it in three places -- and the answer is not merely a
 * distance test: it is the sphere, the falloff, and the one exclusion below
 * that every brush has to make and none of them would think to. The arithmetic
 * is written out rather than run through a Vector3 because this is the
 * innermost loop of a live drag, and the wrapper costs more than the three
 * subtractions it wraps.
 *
 * `touched` is what the shading pass reads at the far end, so a brush that may
 * decline to move some of what it reaches passes `null` here and marks its own
 * as it moves them. See `roundOff`.
 */
function underBrush(
  work: Work,
  adj: Adjacency,
  spec: ErodeDab,
  reachable: Uint32Array,
  touched: Uint8Array | null
): Under {
  const cx = spec.at[0]
  const cy = spec.at[1]
  const cz = spec.at[2]
  const radius = spec.radius
  const radiusSq = radius * radius

  const hit: number[] = []
  const weight: number[] = []
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
    // A vertex no triangle uses any more: what is left of material an earlier
    // dab burnt away. It belongs to no surface, so it has no normal to sink
    // along and nothing to answer for -- and it must not be offered to the
    // wall search as though it were still a face.
    if (adj.triangleStart[v] === adj.triangleStart[v + 1]) continue
    hit.push(v)
    weight.push(w)
    spread.push(Math.pow(w, RELAX_SPREAD))
    if (touched) touched[v] = 1
  }
  return { hit, weight, spread }
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
): boolean {
  // THE SMOOTHER IS A DIFFERENT QUESTION ASKED OF THE SAME SPHERE, and it is
  // asked here rather than by the caller so that everything upstream -- the
  // refinement, the reach box, the replay order -- goes on seeing one kind of
  // dab. See `ErodeDab.round`.
  if (spec.round !== undefined) return roundOff(work, adj, spec, reachable, touched, slot)

  const radius = spec.radius
  // WHICH WAY THIS DAB PUSHES, and the only difference between the two tools.
  // Read once, into a plain +1/-1, because it multiplies a displacement in
  // three places and a branch in the innermost loop of a live drag would be
  // three branches the CPU has to predict per vertex per round.
  const dir = spec.raise ? 1 : -1

  // Who is under the brush, and how hard. Gathered once: both steps below want
  // the same set and the same weights.
  const { hit, weight, spread } = underBrush(work, adj, spec, reachable, touched)
  if (hit.length === 0) return false

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
  if (scale < 1) for (let i = 0; i < hit.length; i++) step[i] *= scale

  // WHERE THE WALL IS ABOUT TO RUN OUT. Asked after the clamp above and before
  // anything moves, because the answer is about the step this dab is actually
  // going to take -- and asked only of the torch, since a raise drives the two
  // faces of a wall apart rather than together. The surgery itself waits until
  // the end of the dab: it changes the topology, and the flow below is still
  // reading the adjacency this dab was built on.
  const burned = dir < 0 ? burnList(work, hit, normals, step, bite, radius) : NO_BURN
  for (let i = 0; i < hit.length; i++) slot[hit[i]] = -1

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

  // Last, so everything above ran on the mesh it was built against. True means
  // the topology moved and the caller owes itself a fresh adjacency.
  return burned.length > 0 && breakThrough(work, adj, burned, touched)
}

// --- Rounding ---------------------------------------------------------------

/**
 * Hold the Smoother still for one instant: ease every corner under the brush
 * toward one radius, and leave everything already that round exactly alone.
 *
 * THE FLOW WITH THE BITE TAKEN OUT, and with a place to stop bolted on. The
 * torch and the sculpt tool move the surface and then relax it; this only
 * relaxes -- so a stroke takes nothing away and puts nothing on beyond what
 * easing a corner over necessarily moves. It is the third brush in the same
 * list for the reason the second one is: the order the three were used in is
 * the whole of what the result means.
 *
 * WHAT IT MOVES IS ONLY WHAT IS TOO SHARP. Every vertex is asked how far it
 * sits off the average of its neighbours ALONG ITS OWN NORMAL, and that
 * reading, against the vertex's span, is the radius of the surface there. A
 * face reads flat, a gentle curve reads gentle, a cube's edge reads very sharp
 * indeed. Only the part of the reading BEYOND the target is moved, so:
 *
 *   - a flat face under the brush does not move at all, and not approximately
 *     -- its neighbours lie in its own plane, so the reading is zero to the
 *     float and the arithmetic below never touches it;
 *   - a curve already gentler than the target is left for the same reason,
 *     which is what lets a user drag sloppily across a panel and change only
 *     the edge they were aiming at;
 *   - a corner sharper than the target is eased until it reads exactly the
 *     target, and then it too stops. Going over it again does nothing.
 *
 * That last one is the difference between this tool and Smoothing on the other
 * two. Smoothing is a RATE -- hold it there and the feature goes away. This is
 * a DESTINATION: what a stroke leaves is a fillet of the radius that was asked
 * for, and a second stroke over the same corner leaves the same fillet.
 *
 * BOTH KINDS OF CORNER, out of one signed reading. A convex corner has its
 * neighbours below it and eases inward; an inside crease has them above it and
 * fills outward. Nothing here asks which it found, and nothing needs to: they
 * are one quantity with two signs, exactly as the torch and the sculpt tool are
 * one displacement with two signs.
 *
 * NOTHING OUTSIDE THE BRUSH MOVES, which is the promise this whole file is
 * built on and is not weakened by the rounding spreading itself: a corner being
 * eased makes its neighbours the sharpest thing left, so the round does creep
 * outward along the edge -- as far as the rim of the sphere and no further, and
 * it settles there rather than creeping on. A vertex where the fillet meets the
 * flat reads half the arc's curvature, which is under the target, so it holds
 * its ground and the round has an edge.
 */
function roundOff(
  work: Work,
  adj: Adjacency,
  spec: ErodeDab,
  reachable: Uint32Array,
  touched: Uint8Array,
  slot: Int32Array
): boolean {
  const radius = spec.radius
  // THE RADIUS THE CORNER IS DRIVEN TO, as a share of the brush -- which is
  // what makes the two dials one gesture: the sphere on screen is the size of
  // the round it can leave, and Strength is how much of it to use.
  //
  // Clamped here rather than trusted from the document, for the reason the flow
  // is clamped in `dab`: a dab that arrives from anywhere -- an older file, a
  // headless caller, a hand-written test -- gets a surface that holds together.
  const target = Math.min(Math.max(spec.round ?? 0, 0), 1) * radius * ROUND_GAIN
  // Strength at zero asks for corners of no radius at all, which is what every
  // corner already is. The one setting of this tool that is honestly nothing
  // rather than something very slow.
  if (target <= 0) return false

  // `null`, so nothing is marked as having moved until it does -- see
  // `underBrush`. It is the difference between a tool that leaves a flat face
  // alone and one that leaves it alone and re-shades it anyway, which along a
  // crisp edge at the fringe of the stroke reads as a round that is not there.
  const { hit, spread } = underBrush(work, adj, spec, reachable, null)
  if (hit.length === 0) return false

  // EVERY NORMAL IS READ BEFORE ANY VERTEX MOVES, for the reason the torch
  // reads its own that way: a normal is derived from where the neighbours are,
  // so reading and moving in one pass aims each vertex using a surface the ones
  // before it have already bent. See `dab`.
  const normal = new Vector3()
  const normals = new Float32Array(hit.length * 3)
  // The mesh's own scale at each vertex: the mean distance to its neighbours.
  // It is what turns a Laplacian into a CURVATURE. The same dish read on coarse
  // triangles and on fine ones gives wildly different averages and exactly the
  // same radius, so without this "how round is this corner" would quietly mean
  // "how round is this corner, at this tessellation" -- and the Smoother would
  // leave a different fillet either side of a refinement boundary.
  const span = new Float32Array(hit.length)
  for (let i = 0; i < hit.length; i++) {
    const v = hit[i]
    vertexNormal(work, adj, v, normal)
    normals[i * 3] = normal.x
    normals[i * 3 + 1] = normal.y
    normals[i * 3 + 2] = normal.z
    const start = adj.neighbourStart[v]
    const end = adj.neighbourStart[v + 1]
    let sum = 0
    for (let k = start; k < end; k++) {
      const n = adj.neighbour[k]
      const ex = work.position[n * 3] - work.position[v * 3]
      const ey = work.position[n * 3 + 1] - work.position[v * 3 + 1]
      const ez = work.position[n * 3 + 2] - work.position[v * 3 + 2]
      sum += Math.sqrt(ex * ex + ey * ey + ez * ez)
    }
    span[i] = end > start ? sum / (end - start) : 0
  }

  // How much room each vertex has in front of it and behind it. Measured once,
  // off the surface this dab was aimed at, and consulted by every round.
  const room = facingRoom(work, hit, normals, radius)

  // How far each vertex is being moved this round, along its own normal, and
  // how far this dab has moved it in total. The second is what the room above
  // is spent against: three rounds share one allowance rather than each being
  // handed it.
  const move = new Float32Array(hit.length)
  const gone = new Float32Array(hit.length)
  const before = new Float32Array(hit.length * 3)
  for (let i = 0; i < hit.length; i++) slot[hit[i]] = i

  for (let round = 0; round < RELAX_ROUNDS; round++) {
    for (let i = 0; i < hit.length; i++) {
      const v = hit[i]
      before[i * 3] = work.position[v * 3]
      before[i * 3 + 1] = work.position[v * 3 + 1]
      before[i * 3 + 2] = work.position[v * 3 + 2]
    }

    for (let i = 0; i < hit.length; i++) {
      move[i] = 0
      const v = hit[i]
      const start = adj.neighbourStart[v]
      const end = adj.neighbourStart[v + 1]
      if (end === start || span[i] <= 0) continue

      let sx = 0
      let sy = 0
      let sz = 0
      for (let k = start; k < end; k++) {
        const n = adj.neighbour[k]
        // JACOBI, and strictly: a neighbour that is itself under the brush is
        // read as it stood at the top of the round rather than as this round
        // has already left it. Without that the answer depends on the order the
        // vertices happen to sit in the buffer, and the same stroke replayed
        // from the same document comes back a different mesh.
        const j = slot[n]
        if (j < 0) {
          sx += work.position[n * 3]
          sy += work.position[n * 3 + 1]
          sz += work.position[n * 3 + 2]
        } else {
          sx += before[j * 3]
          sy += before[j * 3 + 1]
          sz += before[j * 3 + 2]
        }
      }

      const count = end - start
      // HOW FAR THIS VERTEX SITS OFF THE AVERAGE OF ITS NEIGHBOURS, measured
      // along its own normal. Signed, and the sign is which kind of corner it
      // is: a convex one has its neighbours below it and reads negative, an
      // inside crease has them above it and reads positive.
      const into =
        (sx / count - before[i * 3]) * normals[i * 3] +
        (sy / count - before[i * 3 + 1]) * normals[i * 3 + 1] +
        (sz / count - before[i * 3 + 2]) * normals[i * 3 + 2]

      // AND WHAT A CORNER OF EXACTLY THE TARGET RADIUS WOULD READ HERE, which
      // is the whole of how this tool knows when to stop. A surface of radius R
      // whose neighbours are a span h away sits h squared over 2R off their
      // average -- so the reading and the target are the same quantity, and
      // what lies between them is a DISTANCE, ready to be moved.
      const keep = (span[i] * span[i]) / (2 * target)
      if (into <= keep && into >= -keep) continue
      const excess = into > 0 ? into - keep : into + keep

      // Held to the same share of a step the flow is, for the same reason: a
      // full explicit Laplacian step moves a vertex all the way onto its
      // neighbours' average, which shatters a patch rather than smoothing it.
      // See RELAX_RATE.
      //
      // The falloff sets the RATE and nothing else here. Every vertex the brush
      // reaches at all converges on the same radius, however faintly it is
      // weighted -- so a stroke leaves one even round rather than a scalloped
      // one, deepest where the middle of the brush happened to pass.
      let step = excess * RELAX_RATE * spread[i]

      // AND HELD TO THE ROOM THERE IS: material in front of it going in, air in
      // front of it coming out. See ROUND_WALL.
      const allowed = ROUND_WALL * (step < 0 ? room.solid[i] : room.air[i])
      const left = allowed - Math.abs(gone[i])
      if (left <= 0) continue
      if (step > left) step = left
      else if (step < -left) step = -left
      move[i] = step
    }

    // NO EDGE MAY CHANGE LENGTH FASTER THAN THE SURFACE CAN CARRY IT, which is
    // the torch's clamp doing the torch's job on a different displacement. A
    // corner being eased travels along its own normal while the surface just
    // outside the brush stays pinned where the evaluator left it, so the edge
    // between them bears the whole of the step -- and a sharp enough corner on
    // coarse enough triangles asks for a step large enough to fold it. ONE
    // SCALE FOR THE WHOLE ROUND rather than per vertex, for the reason
    // DAB_CLOSE gives: rescuing the worst vertex by moving it differently from
    // its neighbours is a new crease in place of the old one.
    let scale = 1
    for (let i = 0; i < hit.length; i++) {
      if (move[i] === 0) continue
      const v = hit[i]
      const vx = normals[i * 3] * move[i]
      const vy = normals[i * 3 + 1] * move[i]
      const vz = normals[i * 3 + 2] * move[i]
      for (let k = adj.neighbourStart[v]; k < adj.neighbourStart[v + 1]; k++) {
        const n = adj.neighbour[k]
        const ex = work.position[n * 3] - work.position[v * 3]
        const ey = work.position[n * 3 + 1] - work.position[v * 3 + 1]
        const ez = work.position[n * 3 + 2] - work.position[v * 3 + 2]
        const length = Math.sqrt(ex * ex + ey * ey + ez * ez)
        if (length < 1e-12) continue
        const j = slot[n]
        const nx = j < 0 ? 0 : normals[j * 3] * move[j]
        const ny = j < 0 ? 0 : normals[j * 3 + 1] * move[j]
        const nz = j < 0 ? 0 : normals[j * 3 + 2] * move[j]
        const change = Math.abs(((nx - vx) * ex + (ny - vy) * ey + (nz - vz) * ez) / length)
        const allowance = DAB_CLOSE * length
        if (change > allowance) scale = Math.min(scale, allowance / change)
      }
    }

    for (let i = 0; i < hit.length; i++) {
      const step = move[i] * scale
      if (step === 0) continue
      const v = hit[i]
      work.position[v * 3] = before[i * 3] + normals[i * 3] * step
      work.position[v * 3 + 1] = before[i * 3 + 1] + normals[i * 3 + 1] * step
      work.position[v * 3 + 2] = before[i * 3 + 2] + normals[i * 3 + 2] * step
      gone[i] += step
      // Marked only now, and only here: what the brush reached and declined to
      // move is not something this dab did, and the shading pass must not be
      // told it was.
      touched[v] = 1
    }
  }

  for (let i = 0; i < hit.length; i++) slot[hit[i]] = -1
  // The Smoother never changes the topology: it has nothing to remove, and what
  // it moves it moves along the surface it found. The caller's adjacency is
  // still good.
  return false
}

/**
 * How much room every vertex under the brush has straight ahead of it and
 * straight behind it: the nearest surface facing back at it, on each side.
 *
 * `solid` is material -- the far face of a wall this vertex is standing on --
 * and it is what limits a corner being eased INWARD. `air` is the gap across a
 * slot or an inside corner, and it is what limits a crease being filled
 * OUTWARD. Both are Infinity where there is nothing in the way, which is the
 * answer for almost every vertex of almost every dab.
 *
 * NOT `burnList`, although it measures the same distance with the same grid and
 * the same facing test, and the two are deliberately left as two. What the
 * torch wants is a VERDICT -- is this wall gone, and is its far side gone with
 * it -- reached against a threshold and a predicted step, all-or-nothing,
 * because what it does next is surgery. What this wants is a DISTANCE, on both
 * signs, for a tool that never opens anything and only ever needs to know how
 * much of the gap it may spend. Folding them together would mean one function
 * that answers neither question without a flag saying which it was asked.
 *
 * The search is the brush's own radius, and nothing wider is needed: a rounding
 * dab cannot travel further than the target it is driving at, and the target is
 * a share of that radius.
 */
function facingRoom(
  work: Work,
  hit: number[],
  normals: Float32Array,
  search: number
): { solid: Float32Array; air: Float32Array } {
  const solid = new Float32Array(hit.length).fill(Infinity)
  const air = new Float32Array(hit.length).fill(Infinity)

  // ONE SHEET UNDER THE BRUSH IS THE ORDINARY CASE and it is ruled out in a
  // pass, exactly as `burnList` rules it out and for the same reason -- the
  // rest of this is not free, and it would otherwise run on every dab of every
  // stroke anyone ever makes. If every normal sits within sixty degrees of
  // their average then no two of them are more than a hundred and twenty apart,
  // which is not facing enough to be in each other's way.
  let ax = 0
  let ay = 0
  let az = 0
  for (let i = 0; i < hit.length; i++) {
    ax += normals[i * 3]
    ay += normals[i * 3 + 1]
    az += normals[i * 3 + 2]
  }
  const mean = Math.sqrt(ax * ax + ay * ay + az * az)
  if (mean > 1e-12) {
    ax /= mean
    ay /= mean
    az /= mean
    let worst = 1
    for (let i = 0; i < hit.length; i++) {
      const d = normals[i * 3] * ax + normals[i * 3 + 1] * ay + normals[i * 3 + 2] * az
      if (d < worst) worst = d
    }
    if (worst > 0.5) return { solid, air }
  }

  // A grid one search radius to a cell, so the far side of a wall is found in
  // twenty-seven lookups rather than by sweeping the patch for every vertex.
  const cells = new Map<number, number[]>()
  const cellKey = (x: number, y: number, z: number) =>
    ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0)
  for (let i = 0; i < hit.length; i++) {
    const v = hit[i]
    const key = cellKey(
      Math.floor(work.position[v * 3] / search),
      Math.floor(work.position[v * 3 + 1] / search),
      Math.floor(work.position[v * 3 + 2] / search)
    )
    const bucket = cells.get(key)
    if (bucket) bucket.push(i)
    else cells.set(key, [i])
  }

  for (let i = 0; i < hit.length; i++) {
    const v = hit[i]
    const px = work.position[v * 3]
    const py = work.position[v * 3 + 1]
    const pz = work.position[v * 3 + 2]
    const nx = normals[i * 3]
    const ny = normals[i * 3 + 1]
    const nz = normals[i * 3 + 2]
    const cx = Math.floor(px / search)
    const cy = Math.floor(py / search)
    const cz = Math.floor(pz / search)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = cells.get(cellKey(cx + dx, cy + dy, cz + dz))
          if (!bucket) continue
          for (const j of bucket) {
            const u = hit[j]
            if (u === v) continue
            // Only a surface FACING BACK is in the way. Two vertices on one
            // sheet, however close, are neighbours rather than obstacles. See
            // BURN_FACING, which is the same threshold for the same reason.
            const away = normals[j * 3] * nx + normals[j * 3 + 1] * ny + normals[j * 3 + 2] * nz
            if (away >= BURN_FACING) continue
            const dxu = px - work.position[u * 3]
            const dyu = py - work.position[u * 3 + 1]
            const dzu = pz - work.position[u * 3 + 2]
            // ALONG THE NORMAL, with the sideways part discarded rather than
            // added in: the far face is tessellated on its own, so the vertex
            // opposite this one generally is not opposite at all. What is
            // wanted is the room ahead, which is the part of the offset that
            // runs along the normal.
            const gap = dxu * nx + dyu * ny + dzu * nz
            // Too far to the side to be standing across from this one at all.
            if (dxu * dxu + dyu * dyu + dzu * dzu - gap * gap > search * search) continue
            // POSITIVE IS MATERIAL BETWEEN THE TWO FACES, NEGATIVE IS AIR, and
            // that sign is the whole difference between the two sides of a thin
            // wall and the two walls of a narrow slot. A vertex sitting exactly
            // on another counts as both, which is the only honest reading of a
            // surface that has already arrived.
            if (gap >= 0 && gap < search && gap < solid[i]) solid[i] = gap
            if (gap <= 0 && -gap < search && -gap < air[i]) air[i] = -gap
          }
        }
      }
    }
  }

  return { solid, air }
}

// --- Burning through --------------------------------------------------------

/**
 * Which vertices under this dab have no wall left in front of them.
 *
 * THE ONE PLACE THE TORCH ADMITS THE MATERIAL CAN RUN OUT. Everywhere else in
 * this file the surface is a sheet that bends; here it is a wall with a
 * thickness, and a wall the flame has eaten all the way through is not a
 * surface that sags -- it is a hole.
 *
 * What it measures is the wall UNDER a vertex: from the vertex, straight into
 * the solid, how far to the surface on the other side. The measurement is
 * signed along the inward normal and only a POSITIVE answer counts, which is
 * the whole of how a wall is told apart from a gap. Two sheets with material
 * between them face each other across that material, so the far one lies
 * BEHIND this one and the reading is positive. The two walls of a groove, of a
 * slot, of the inside of any concave corner also face each other -- and lie in
 * FRONT of each other, across empty air, so the reading is negative and
 * nothing burns. Without that sign a torch held in a sharp inside corner would
 * open a hole in the middle of solid material, which is the exact opposite of
 * what it is for.
 *
 * PREDICTIVE, not a post-mortem. It asks what the wall will be once this dab
 * has moved both of its faces, not what it is now, because a crossing that has
 * already happened cannot be told from a groove: both are two surfaces facing
 * each other across a negative gap. Catching it one dab early is what keeps
 * the distinction above available, and it is why the threshold has to leave
 * room for a whole dab of closing on each side at once.
 *
 * The search space is the brush own hit list and nothing wider. A dab cannot
 * sink deeper than its own radius -- a vertex that has sagged out of reach
 * stops being melted, see `dab` -- so a wall this dab could break through is a
 * wall whose far side is inside the sphere.
 */
function burnList(
  work: Work,
  hit: number[],
  normals: Float32Array,
  step: Float32Array,
  bite: number,
  radius: number
): number[] {
  // A cold brush moves nothing, so there is no wall for it to consume. Stated
  // here rather than left to fall out of the arithmetic: with no bite the test
  // below would still burn anything already thinner than the threshold, and a
  // tool set to no heat at all must not be the one that opens a hole.
  if (bite <= 0) return NO_BURN
  const limit = BURN_WALL * radius
  // Both faces of the wall may close by a whole bite before the next dab looks
  // again, so anything nearer than this is worth measuring properly.
  const search = limit + bite * 2

  // ONE SHEET UNDER THE BRUSH IS THE ORDINARY CASE and it is ruled out in a
  // pass, because the rest of this function is not free and would otherwise run
  // on every dab of every stroke anyone ever makes. If every normal under the
  // brush sits within sixty degrees of their average then no two of them are
  // further than a hundred and twenty apart, which is not facing enough to be
  // two sides of a wall -- see BURN_FACING.
  let ax = 0
  let ay = 0
  let az = 0
  for (let i = 0; i < hit.length; i++) {
    ax += normals[i * 3]
    ay += normals[i * 3 + 1]
    az += normals[i * 3 + 2]
  }
  const spread = Math.sqrt(ax * ax + ay * ay + az * az)
  if (spread > 1e-12) {
    ax /= spread
    ay /= spread
    az /= spread
    let worst = 1
    for (let i = 0; i < hit.length; i++) {
      const d = normals[i * 3] * ax + normals[i * 3 + 1] * ay + normals[i * 3 + 2] * az
      if (d < worst) worst = d
    }
    if (worst > 0.5) return NO_BURN
  }

  // A grid one search radius to a cell, so the far side of a wall is found in
  // twenty-seven lookups rather than by sweeping the patch for every vertex in
  // it.
  const cells = new Map<number, number[]>()
  const cellKey = (x: number, y: number, z: number) =>
    ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0)
  for (let i = 0; i < hit.length; i++) {
    const v = hit[i]
    const key = cellKey(
      Math.floor(work.position[v * 3] / search),
      Math.floor(work.position[v * 3 + 1] / search),
      Math.floor(work.position[v * 3 + 2] / search)
    )
    const bucket = cells.get(key)
    if (bucket) bucket.push(i)
    else cells.set(key, [i])
  }

  // BOTH SIDES OF A WALL GO TOGETHER, and this is where that is arranged. A
  // hole is a pair of rims, one on each face, and the tunnel between them is
  // sewn from the two; burn the near face alone and what is left is a dish with
  // its bottom missing and a single raw boundary that nothing can close, so
  // `breakThrough` declines it and the wall never opens at all.
  //
  // They do not agree on their own. The far face is further from the middle of
  // the brush than the near one, so it is bitten less hard, and its vertices
  // sit wherever its own tessellation put them -- either can fail the test the
  // other passes, on a wall both of them are standing on. So a vertex burns
  // whatever it was measured AGAINST as well: the pair is the finding, not the
  // vertex.
  const marked = new Uint8Array(hit.length)
  for (let i = 0; i < hit.length; i++) {
    const v = hit[i]
    const px = work.position[v * 3]
    const py = work.position[v * 3 + 1]
    const pz = work.position[v * 3 + 2]
    const nx = normals[i * 3]
    const ny = normals[i * 3 + 1]
    const nz = normals[i * 3 + 2]
    const cx = Math.floor(px / search)
    const cy = Math.floor(py / search)
    const cz = Math.floor(pz / search)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = cells.get(cellKey(cx + dx, cy + dy, cz + dz))
          if (!bucket) continue
          for (const j of bucket) {
            const u = hit[j]
            if (u === v) continue
            const away =
              normals[j * 3] * nx + normals[j * 3 + 1] * ny + normals[j * 3 + 2] * nz
            if (away >= BURN_FACING) continue
            const dxu = px - work.position[u * 3]
            const dyu = py - work.position[u * 3 + 1]
            const dzu = pz - work.position[u * 3 + 2]
            // ALONG THE INWARD NORMAL, and the sideways part discarded rather
            // than added in. The far face of a wall is tessellated on its own,
            // so the vertex opposite this one is generally not opposite at all
            // -- it sits half an edge to one side, and its straight-line
            // distance is the wall plus that offset. What is wanted is the wall
            // it stands on, which is the part of the offset that runs along the
            // normal: on any flat stretch that is exactly the thickness however
            // far to the side the vertex lies, and on a curved one it is out by
            // the curvature over that half edge, which is nothing.
            const gap = dxu * nx + dyu * ny + dzu * nz
            // Positive is material between the two faces, negative is air --
            // and that sign is the whole difference between a thin wall and a
            // sharp inside corner. See the note above.
            if (gap <= 0 || gap > search) continue
            // Too far to the side to be standing on the same wall.
            if (dxu * dxu + dyu * dyu + dzu * dzu - gap * gap > search * search) continue
            // What the far face brings to the meeting, resolved along the same
            // normal: it moves along its own, which points back at this one.
            if (gap - step[i] + away * step[j] >= limit) continue
            marked[i] = 1
            marked[j] = 1
          }
        }
      }
    }
  }

  const burned: number[] = []
  for (let i = 0; i < hit.length; i++) if (marked[i]) burned.push(hit[i])
  return burned
}

/**
 * One boundary of the wound, as the surviving triangles left it.
 *
 * `area` is the loop own normal by Newell formula -- twice its area, pointed
 * the way the loop winds -- and it is what tells the two ends of a tunnel from
 * two rings on the same sheet: the ends of a tunnel wind opposite ways, so
 * their normals oppose.
 */
type Loop = {
  ring: number[]
  centre: Vector3
  area: Vector3
}

/**
 * Take the burnt material out and sew the two faces of the wall into a tunnel.
 *
 * The one operation in this file that changes the TOPOLOGY rather than merely
 * the shape, and it is deliberately all or nothing: everything is measured
 * first, and if what comes back is not two rims for every hole then nothing is
 * removed and the dab is left to sag the way it always did. That is what makes
 * it safe to run on any mesh a user can produce. A wound that cannot be closed
 * is never opened, so the object cannot be left with a raw edge -- which would
 * not merely look wrong but would leak, and every solid here is expected to be
 * closed enough to measure, to boolean against and to export.
 *
 * The rims are ZIPPED rather than filled. Each face of the wall leaves a ring
 * of surviving vertices around the hole; walking the two rings together and
 * laying a triangle across at each step turns them into the wall of a tunnel,
 * with no new vertices minted and every new triangle carrying the reverse of a
 * boundary edge that was left open. That last part is what makes the result
 * closed rather than merely convincing.
 *
 * WHICH WAY EACH RING IS WALKED IS NOT A CHOICE. A boundary edge of a
 * consistently wound mesh runs with the material on its left, so the two rims
 * of one tunnel run opposite ways round it -- and the triangles that close them
 * have to carry the reverse of each. Walk the second rim forwards and the zip
 * covers its edges in the direction they already point, which duplicates them
 * instead of closing them and turns every triangle it lays inside out. So the
 * second rim is always reversed, and the only freedom left is where to start:
 * at the nearest pair, so the tunnel is not laid with a twist in it.
 */
function breakThrough(
  work: Work,
  adj: Adjacency,
  burned: number[],
  touched: Uint8Array
): boolean {
  const dead = new Uint8Array(work.triangleCount)
  const doomed: number[] = []
  for (const v of burned) {
    for (let i = adj.triangleStart[v]; i < adj.triangleStart[v + 1]; i++) {
      const t = adj.triangle[i]
      if (dead[t]) continue
      dead[t] = 1
      doomed.push(t)
    }
  }
  if (doomed.length === 0) return false

  const edgeKey = (a: number, b: number) => (a < b ? a * 1048576 + b : b * 1048576 + a)

  /**
   * Take the peninsulas off the wound, so the rim it leaves is a rim.
   *
   * A triangle standing in the wound with two of its three sides on the
   * boundary is not part of the surface any more -- it is a spur of material
   * the burn happened to leave, hanging into a hole by one edge or one vertex.
   * The two faces of a wall are tessellated independently and burn to slightly
   * different outlines, so they are produced constantly, and every one of them
   * is a spike on the lip of the hole and a rim of its own for the sewing below
   * to worry about.
   *
   * Twice is enough to matter and cheap: a spur two triangles long comes off in
   * two rounds, and the round after a round that found nothing finds nothing.
   * It cannot run away, because the surface outside the brush is a sheet whose
   * triangles have no burnt neighbours at all.
   *
   * BEFORE THE TUNNEL RULE BELOW, and the order is not arbitrary: a spur can be
   * part of a tunnel this stroke sewed earlier, and taking it off would leave
   * that tunnel in pieces -- which is the exact state the rule below exists to
   * put right. Peel first and the rule sees the finished wound.
   */
  for (let round = 0; round < 2; round++) {
    const beside = new Set<number>()
    for (const t of doomed) {
      for (let e = 0; e < 3; e++) {
        const v = work.corner[t * 3 + e]
        for (let i = adj.triangleStart[v]; i < adj.triangleStart[v + 1]; i++) {
          if (!dead[adj.triangle[i]]) beside.add(adj.triangle[i])
        }
      }
    }
    let peeled = false
    for (const s of beside) {
      let sides = 0
      for (let e = 0; e < 3; e++) {
        const a = work.corner[s * 3 + e]
        const b = work.corner[s * 3 + ((e + 1) % 3)]
        for (let i = adj.triangleStart[a]; i < adj.triangleStart[a + 1]; i++) {
          const o = adj.triangle[i]
          if (o === s || !dead[o]) continue
          if (work.corner[o * 3] !== b && work.corner[o * 3 + 1] !== b) {
            if (work.corner[o * 3 + 2] !== b) continue
          }
          sides++
          break
        }
      }
      if (sides < 2) continue
      dead[s] = 1
      doomed.push(s)
      peeled = true
    }
    if (!peeled) break
  }

  // A TUNNEL GOES WHOLE OR NOT AT ALL, and this is the rule that keeps a
  // widening hole from tearing. The flame comes back to the rim it just made
  // and eats part of the tunnel wall; what is left is one boundary running down
  // the front face, along the surviving strip and back up the far side, which
  // is not two rims and cannot be zipped. Swallowing the rest of the tunnel
  // with it puts the wound back to a ring on each face, which is exactly the
  // shape the zip below understands -- and the tunnel it lays in place of the
  // old one is the same tunnel, one size larger.
  let rimmed = false
  for (const t of doomed) {
    if (work.rim[t]) {
      rimmed = true
      break
    }
  }
  if (rimmed) {
    const sides = new Map<number, number[]>()
    for (let t = 0; t < work.triangleCount; t++) {
      if (!work.rim[t]) continue
      for (let e = 0; e < 3; e++) {
        const key = edgeKey(work.corner[t * 3 + e], work.corner[t * 3 + ((e + 1) % 3)])
        const bucket = sides.get(key)
        if (bucket) bucket.push(t)
        else sides.set(key, [t])
      }
    }
    // `doomed` is the queue as well as the record: anything appended here is
    // walked by the same loop.
    for (let head = 0; head < doomed.length; head++) {
      const t = doomed[head]
      if (!work.rim[t]) continue
      for (let e = 0; e < 3; e++) {
        const bucket = sides.get(
          edgeKey(work.corner[t * 3 + e], work.corner[t * 3 + ((e + 1) % 3)])
        )
        if (!bucket) continue
        for (const s of bucket) {
          if (dead[s]) continue
          dead[s] = 1
          doomed.push(s)
        }
      }
    }
  }

  // The rim, as half-edges of the SURVIVING triangles. An edge of a doomed
  // triangle whose other user lives is an edge that has just been left open,
  // and it is stored pointing the way that survivor winds -- so following
  // `onward` from any vertex walks the boundary with the material on its left.
  //
  // A LIST PER VERTEX RATHER THAN ONE EDGE, because a wound is allowed to be
  // pinched. Burn two patches that touch at a single vertex and that vertex has
  // two rims running through it, one for each patch; hold only the second and
  // the walk below chases the wrong one, never comes home, and the whole
  // surgery is abandoned over a shape that is perfectly closeable. Each edge is
  // spent once, so the walk simply takes whichever of them is left.
  const onward = new Map<number, number[]>()
  const paint = new Map<number, number>()
  for (const t of doomed) {
    for (let e = 0; e < 3; e++) {
      const u = work.corner[t * 3 + e]
      const v = work.corner[t * 3 + ((e + 1) % 3)]
      for (let i = adj.triangleStart[v]; i < adj.triangleStart[v + 1]; i++) {
        const s = adj.triangle[i]
        if (dead[s]) continue
        for (let f = 0; f < 3; f++) {
          if (work.corner[s * 3 + f] !== v) continue
          if (work.corner[s * 3 + ((f + 1) % 3)] !== u) continue
          const out = onward.get(v)
          if (out) out.push(u)
          else onward.set(v, [u])
          paint.set(v, work.group[s])
        }
      }
    }
  }
  if (onward.size === 0) return false

  const loops: Loop[] = []
  const at = new Vector3()
  const on = new Vector3()
  for (const start of onward.keys()) {
    for (;;) {
      const first = onward.get(start)
      if (!first || first.length === 0) break
      const ring: number[] = []
      let v = start
      let closed = false
      for (;;) {
        const out = onward.get(v)
        if (!out || out.length === 0) break
        ring.push(v)
        v = out.pop() as number
        if (v === start) {
          closed = true
          break
        }
        // A rim that arrives somewhere it has already been, other than home. It
        // cannot happen while every vertex holds one edge each way, and the
        // guard is here so a mesh that manages it is declined rather than spun
        // on forever.
        if (ring.length > onward.size) break
      }
      // A boundary that does not come back to where it started is a rim this
      // cannot close -- a hole that has run off the edge of the sheet, say.
      // Nothing at all is removed in that case.
      if (!closed || ring.length < 3) return false
      const centre = new Vector3()
      const area = new Vector3()
      for (let i = 0; i < ring.length; i++) {
        at.fromArray(work.position, ring[i] * 3)
        on.fromArray(work.position, ring[(i + 1) % ring.length] * 3)
        centre.add(at)
        area.add(on.cross(at))
      }
      centre.multiplyScalar(1 / ring.length)
      loops.push({ ring, centre, area })
    }
  }

  // Two rims to a tunnel, paired nearest first, and only ever with a rim that
  // winds the other way -- which is what stops two rings left on the SAME face
  // from being sewn to each other into a lid.
  const pairs: [Loop, Loop][] = []
  const taken = new Uint8Array(loops.length)
  for (;;) {
    let bi = -1
    let bj = -1
    let best = Infinity
    for (let i = 0; i < loops.length; i++) {
      if (taken[i]) continue
      for (let j = i + 1; j < loops.length; j++) {
        if (taken[j]) continue
        if (loops[i].area.dot(loops[j].area) >= 0) continue
        const apart = loops[i].centre.distanceToSquared(loops[j].centre)
        if (apart >= best) continue
        best = apart
        bi = i
        bj = j
      }
    }
    if (bi < 0) break
    taken[bi] = 1
    taken[bj] = 1
    pairs.push([loops[bi], loops[bj]])
  }

  const fa = new Vector3()
  const fb = new Vector3()
  const fc = new Vector3()
  const fn = new Vector3()
  const emit = (a: number, b: number, c: number, group: number): void => {
    const t = work.triangleCount++
    work.corner = growU32(work.corner, work.triangleCount * 3)
    work.cornerNormal = grow32(work.cornerNormal, work.triangleCount * 9)
    work.group = growU32(work.group, work.triangleCount)
    work.rim = growU8(work.rim, work.triangleCount)
    work.corner[t * 3] = a
    work.corner[t * 3 + 1] = b
    work.corner[t * 3 + 2] = c
    work.group[t] = group
    work.rim[t] = 1
    fa.fromArray(work.position, a * 3)
    fb.fromArray(work.position, b * 3)
    fc.fromArray(work.position, c * 3)
    fn.subVectors(fb, fa).cross(fc.sub(fa))
    if (fn.lengthSq() < 1e-30) fn.set(0, 1, 0)
    else fn.normalize()
    // A stand-in: every vertex of a fresh tunnel is marked touched below, so
    // the smooth normal computed at the end is what actually ships. This is
    // what the corner would shade as if it were not.
    for (let corner = 0; corner < 3; corner++) {
      fn.toArray(work.cornerNormal, (t * 3 + corner) * 3)
    }
  }

  const span = (a: number, b: number): number => {
    const dx = work.position[a * 3] - work.position[b * 3]
    const dy = work.position[a * 3 + 1] - work.position[b * 3 + 1]
    const dz = work.position[a * 3 + 2] - work.position[b * 3 + 2]
    return dx * dx + dy * dy + dz * dz
  }

  for (const [front, back] of pairs) {
    const a = front.ring
    // Reversed, always. See the note above: the winding decides this, not the
    // geometry.
    const b = back.ring.slice().reverse()
    let from = 0
    let onto = 0
    let best = Infinity
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        const apart = span(a[i], b[j])
        if (apart >= best) continue
        best = apart
        from = i
        onto = j
      }
    }
    let i = 0
    let j = 0
    while (i < a.length || j < b.length) {
      const av = a[(from + i) % a.length]
      const anext = a[(from + i + 1) % a.length]
      const bv = b[(onto + j) % b.length]
      const bnext = b[(onto + j + 1) % b.length]
      // Whichever step lays the shorter diagonal, so the tunnel is triangulated
      // across rather than fanned from one point of it.
      const stepA = j >= b.length || (i < a.length && span(anext, bv) <= span(bnext, av))
      if (stepA) {
        emit(anext, av, bv, paint.get(av) ?? 0)
        i++
      } else {
        emit(bv, bnext, av, paint.get(bnext) ?? 0)
        j++
      }
    }
  }

  // A RIM WITH NOBODY TO PAIR WITH IS HEALED SHUT, and this is what lets the
  // surgery go ahead at all on a wound that is not simply one hole through one
  // wall.
  //
  // They turn up constantly, and small. The two faces of a wall are tessellated
  // independently and burn to slightly different outlines, so a scrap of the
  // near face is left standing where the far face has gone, or a stray triangle
  // survives inside the wound; either leaves a rim of a handful of vertices
  // with no opposite number. Refusing the whole surgery over one of those is
  // what used to leave a stroke as a ladder -- material still bridging a slot
  // at every point where the dab that should have cleared it was declined.
  //
  // A fan from the rim first vertex, which needs no new vertex and covers the
  // reverse of every edge left open. It is a flat patch across a hole of a few
  // millimetres and it does the honest thing on the one case where a rim is
  // BOTH large and alone: a point burnt off a cone leaves a single ring, and
  // this lands it flat, which is what melting a point off looks like.
  for (let i = 0; i < loops.length; i++) {
    if (taken[i]) continue
    const ring = loops[i].ring
    for (let k = 1; k + 1 < ring.length; k++) {
      emit(ring[0], ring[k + 1], ring[k], paint.get(ring[k]) ?? 0)
    }
  }

  // Out with the burnt material. The tunnel triangles were appended past the
  // end of `dead`, so they survive this by construction.
  let kept = 0
  for (let t = 0; t < work.triangleCount; t++) {
    if (t < dead.length && dead[t]) continue
    if (kept !== t) {
      for (let k = 0; k < 3; k++) work.corner[kept * 3 + k] = work.corner[t * 3 + k]
      for (let k = 0; k < 9; k++) {
        work.cornerNormal[kept * 9 + k] = work.cornerNormal[t * 9 + k]
      }
      work.group[kept] = work.group[t]
      work.rim[kept] = work.rim[t]
    }
    kept++
  }
  work.triangleCount = kept

  // The rim shades as melt rather than as the face it was cut out of.
  for (const loop of loops) for (const v of loop.ring) touched[v] = 1
  return true
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
  let adj = buildAdjacency(work)
  const touched = new Uint8Array(work.vertexCount)
  const reachable = reachableVertices(work, dabs)
  const slot = new Int32Array(work.vertexCount).fill(-1)
  // REBUILT ONLY WHEN A DAB BURNS THROUGH. Refinement has finished, so for an
  // ordinary stroke the topology is fixed and this is built once for the whole
  // of it; a dab that opens a hole has taken triangles out and put a tunnel in,
  // and everything after it has to be told.
  for (const spec of dabs) {
    if (dab(work, adj, spec, reachable, touched, slot)) adj = buildAdjacency(work)
  }
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
