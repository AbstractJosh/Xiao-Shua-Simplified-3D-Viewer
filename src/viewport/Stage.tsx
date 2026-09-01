import type { Box3 } from 'three'
import { GuideGrid } from './GuideGrid'
import { useSceneColors } from './useSceneColors'

/**
 * The empty room every viewport works in: the background, the light on it, and
 * the ground under it.
 *
 * Extracted the moment there was a second viewport, and for the reason
 * `axisColors.ts` exists: this is a set of values that must agree between
 * screens, and two copies of "the fine grid fades at 14 and the coarse one at
 * 300" is how the ground ends up looking like a different place depending on
 * which button in the bar was last pressed. What a screen does with the room is
 * its own business; what the room IS is one definition.
 *
 * Everything here is inside a `<Canvas>` and draws nothing on its own account:
 * a viewport mounts this and then adds whatever it is for.
 *
 * THE GROUND IS ALWAYS A PATCH, never a floor without end, and how far it
 * reaches is the one thing a screen gets to say about the room. `reach` is how
 * far past the middle the grid is still drawn, in world units; past it the fade
 * has taken the ground to nothing and the quad it was ruled on stops shortly
 * after. The laser screen asks for a bed three blocks wide; the modelling
 * screen asks for whatever holds the model -- see `groundReach`.
 *
 * IT USED TO BE ENDLESS ON THE SCREEN THAT TRAVELS, and that is what had the
 * grid trembling for the better part of a second after every camera move. Drei
 * draws an endless grid by blowing the quad up by the fade distance, which put
 * the coarse grid's four corners some 3,600 units from the middle -- and the
 * grid pattern is a `fract` of a varying interpolated across exactly those
 * corners. A float32 varying carrying values that big is quantised to about
 * 2.4e-4 of a unit, and the shader's `fwidth` -- which is what sets how thick a
 * line is drawn -- is a difference between neighbouring fragments that, at
 * arm's length from a solid, is only some 3.3e-3 of a unit wide. So better than
 * seven per cent of every line's thickness was rounding noise, nearer thirty
 * when zoomed in, and it re-rolled itself on every frame the camera moved.
 * OrbitControls' damping keeps the camera creeping for about a second after the
 * hand stops: that is the "and for a while afterwards".
 *
 * Bounded, the same arithmetic lands under a tenth of a per cent, because the
 * quad's corners are now tens of units out rather than thousands. Nothing about
 * the shader changed -- it is the magnitude of the numbers going into it. See
 * `groundPlan`, which now cuts each grid a quad of its own so the fine one, the
 * one you are looking at when you are zoomed in far enough to care, is never
 * more than 35 units across whatever the reach.
 */

/**
 * The grid sits a hair BELOW y = 0 even though objects rest exactly on it:
 * coplanar with a box's bottom face it z-fights across the whole footprint.
 */
const GRID_Y = -0.002

/**
 * The two grids draw before every other transparent thing in the scene, coarse
 * first and fine over it.
 *
 * Stated rather than left to the sort, which is half of what stopped the grid
 * shimmering: they are centred on the same point half a thousandth of a unit
 * apart, so three had nothing to separate them by and the order flipped as the
 * camera came round. Negative, because the ground goes under the gizmo, the
 * rulers, the cut plane and the snap marker without any of them having to say
 * so. See `GuideGrid`.
 */
const GRID_ORDER_COARSE = -2
const GRID_ORDER_FINE = -1

/**
 * How far either grid may fade out at, however much ground is asked for.
 *
 * The fine one gives out by about a metre and a half, which is roughly where
 * centimetre cells stop being countable and start being moire; the coarse one
 * would carry on to thirty metres, which is past the largest scene this app can
 * hold.
 */
const FINE_FADE = 14
const COARSE_FADE = 300

/**
 * How much wider than its own fade each grid's quad is cut.
 *
 * The fade completes at the fade distance and every fragment past it discards
 * itself, so the quad only has to be wide enough that the CIRCLE is inside it
 * -- a hard edge is the one thing a fade is for avoiding. Two would do it
 * exactly and leave the corners of the fade circle on the very edge of the
 * quad; two and a half leaves a standoff, at the cost of some fragments that
 * discard themselves.
 *
 * And no wider than that, which is now a rule with teeth: every unit of quad
 * past the fade is precision spent on ground nobody sees. See the note at the
 * top of the file.
 */
const PLANE_MARGIN = 2.5

/**
 * Where the fade is measured FROM.
 *
 * Drei fades radially outward from a point, and the point is the camera
 * projected onto the grid plane scaled by this: one puts it under the camera,
 * zero puts it at the middle of the world.
 *
 * THE MIDDLE, on every screen. The ground is a patch around the thing standing
 * on it, and it should be the same patch from every side; faded from the camera
 * it would slide about as the view came round -- brightest under the camera,
 * which on a level view is a standoff's worth OFF the object, so the ground
 * would be lit in front of it and dark behind. That mattered least when the
 * ground was endless, which is the only place the camera-centred fade was ever
 * used, and there is no endless ground any more.
 */
const FADE_FROM_MIDDLE = 0

/**
 * What the two grids are drawn on and where each of them gives out, for a
 * ground that reaches `reach`.
 *
 * A function of its own, and exported, for the reason `withLogDepth` is: it is
 * the whole of the decision, it is arithmetic, and `ui-check` can put a reach
 * through it and read the answer without a canvas to draw on.
 *
 * THE FINE GRID IS CAPPED. Its cells are a centimetre, and a bed three blocks
 * wide is 150 units across for the largest stock this app allows: ruled that
 * far the fine grid is moire and nothing else, and the coarse one is already
 * there to take the ground over. So the reach can pull it in, but never push it
 * past where it stops being readable.
 *
 * AND EACH GRID GETS ITS OWN QUAD, sized to its own fade rather than to the
 * reach they share. It costs nothing -- the fragments outside a fade discard
 * either way -- and it means the fine grid is at most 35 units across no matter
 * how much ground the coarse one has been asked to cover. The fine grid is what
 * fills the screen when you are close enough to a part for a rounding wobble in
 * a line to be visible at all, so that is the quad worth keeping small.
 */
export function groundPlan(reach: number): {
  finePlane: [number, number]
  coarsePlane: [number, number]
  fadeFrom: number
  fineFade: number
  coarseFade: number
} {
  const fineFade = Math.min(reach, FINE_FADE)
  const coarseFade = Math.min(reach, COARSE_FADE)
  const fine = fineFade * PLANE_MARGIN
  const coarse = coarseFade * PLANE_MARGIN
  return {
    finePlane: [fine, fine],
    coarsePlane: [coarse, coarse],
    fadeFrom: FADE_FROM_MIDDLE,
    fineFade,
    coarseFade,
  }
}

/**
 * The patch of ground the modelling screen opens on: twenty units across, two
 * metres, which holds the 10 cm solid the palette drops with a room's worth of
 * floor around it.
 */
const GROUND_REACH_MIN = 10

/**
 * How much further the ground reaches than the model standing on it, and the
 * step the answer is rounded up to.
 *
 * TWICE, because the fade is measured from the middle of the world and the
 * ground is at its dimmest where it ends: a reach that stopped exactly at the
 * far corner of the model would leave that corner standing on nothing. At twice
 * the span the model's own edge sits at half brightness, which still reads as
 * ground.
 *
 * ROUNDED UP TO A WHOLE TEN, because the answer feeds `planeGeometry`'s `args`,
 * and a reach that moved with the model would rebuild both grids on every frame
 * of a drag. Ten units is a step nobody can catch happening -- the ground grows
 * by a metre, once, somewhere in the middle of dragging a part out past the two
 * it already covers.
 */
const GROUND_HEADROOM = 2
const GROUND_STEP = 10

/**
 * How far the ground has to reach to hold this model.
 *
 * The modelling screen's answer to `reach`, and the whole of what "if the model
 * outgrows the patch, draw the rest" means. Measured from the MIDDLE OF THE
 * WORLD rather than from the middle of the model, because that is where drei
 * fades from -- a model set down off to one side is held by a bigger circle
 * rather than by a circle that moved, which is also what keeps the grid lines
 * standing still in world space while it grows.
 *
 * The corner rather than the wider of the two sides: the fade is a circle, so
 * what has to be inside it is the model's furthest CORNER. Height is not asked
 * about at all -- this is a floor, and a tall part does not need a wider one.
 *
 * An empty document reaches the minimum, which is the same patch the app opens
 * on before anything has been dropped into it.
 */
export function groundReach(model: Box3): number {
  if (model.isEmpty()) return GROUND_REACH_MIN
  const x = Math.max(Math.abs(model.min.x), Math.abs(model.max.x))
  const z = Math.max(Math.abs(model.min.z), Math.abs(model.max.z))
  const wanted = Math.hypot(x, z) * GROUND_HEADROOM
  return Math.max(GROUND_REACH_MIN, Math.ceil(wanted / GROUND_STEP) * GROUND_STEP)
}

export function Stage({ reach }: { reach: number }) {
  const scene = useSceneColors()
  const { finePlane, coarsePlane, fadeFrom, fineFade, coarseFade } = groundPlan(reach)

  return (
    <>
      <color attach="background" args={[scene.bg]} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[6, 9, 5]} intensity={2.1} />
      {/* The cool fill opposite the key, and the one place a theme's hue reaches
          the solids themselves -- everything else it repaints is chrome. */}
      <directionalLight position={[-6, 3, -5]} intensity={0.7} color={scene.fillLight} />

      {/* Grid colours are lifted well clear of whatever ground the theme paints:
          at the original values the ground read as empty space. Major lines
          carry a cast that separates them from the warm-grey solids, and the
          fade is gentler so the plane still reads out toward the horizon.

          Both pairs come from `sceneColors` per theme rather than being tinted
          from one set: "clear of the background" means lighter than it on a dark
          theme and darker than it on a light one, which no single adjustment
          gives you.

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

          The fine grid sits a hair ABOVE the coarse one, and draws after it,
          so that where their lines coincide -- every 1 unit, which is a section
          of one and a cell of the other -- the finer of the two wins outright.
          The ORDER is what decides that now rather than the height: neither
          grid writes depth any more, because two nearly coplanar depth-writing
          grids is exactly the fight that had the ground shimmering through
          every camera move. See `GuideGrid` for the whole of it. */}
      <GuideGrid
        renderOrder={GRID_ORDER_FINE}
        position={[0, GRID_Y + 0.0005, 0]}
        args={finePlane}
        cellSize={0.1}
        cellThickness={0.6}
        cellColor={scene.gridCell}
        sectionSize={1}
        sectionThickness={1.2}
        sectionColor={scene.gridSection}
        fadeDistance={fineFade}
        fadeFrom={fadeFrom}
        fadeStrength={1}
      />
      <GuideGrid
        renderOrder={GRID_ORDER_COARSE}
        position={[0, GRID_Y, 0]}
        args={coarsePlane}
        cellSize={1}
        cellThickness={0.6}
        cellColor={scene.gridCell}
        sectionSize={10}
        sectionThickness={1.4}
        sectionColor={scene.gridSection}
        fadeDistance={coarseFade}
        fadeFrom={fadeFrom}
        fadeStrength={0.8}
      />
    </>
  )
}

/**
 * How a camera is set down in that room, and how far it may travel from it.
 *
 * Shared for the same reason the grid is: two viewports opening at different
 * distances from the same ground would read as two different worlds. Spread
 * onto the `<Canvas>` and `<OrbitControls>` of whichever screen is up.
 */
export const STAGE_CAMERA = {
  // Four units out -- 40 cm -- which frames the 10 cm solid the palette drops
  // with a comfortable margin of ground around it, rather than the metre of
  // empty grid the opening shot used to hold. The direction is down the corner,
  // so all three axes read at once.
  position: [2.5, 1.85, 2.5],
  fov: 45,
  // A five-metre solid needs the camera 113 units out to frame it; a millimetre
  // one fills the view from 0.023 units away, which was INSIDE the old near
  // plane -- the app simply could not draw a part that small.
  near: 0.005,
  far: 1000,
} as const

/** 114 is what it takes to frame the largest solid `dimensions.ts` allows; 200
 *  leaves room to stand off a scene of them. The near end drops far enough to
 *  put a millimetre feature on screen. */
export const STAGE_MIN_DISTANCE = 0.02
export const STAGE_MAX_DISTANCE = 200
