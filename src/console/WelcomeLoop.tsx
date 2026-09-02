import { useEffect, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { DEFAULT_OBJECT_COLOR } from '../geometry/types'
import { prefersReducedMotion } from './motion'
import {
  BED,
  BED_Z0,
  BED_Z1,
  CHIPS,
  CORE_2D,
  CUBE_L,
  CUBE_R,
  CUT_PATH,
  CUT_PATH_LENGTH,
  GRID_REACH,
  GRID_STEP,
  LOOP,
  OFFCUT_L,
  OFFCUT_R,
  OFFCUT_SLICE,
  PIVOT_OFFCUT_L,
  PIVOT_OFFCUT_LASER,
  PIVOT_OFFCUT_R,
  PROFILE_LIP,
  PROFILE_RECT,
  ROOF_2D,
  SOLID_ARROW,
  SOLID_PENT,
  SOLID_T,
  SPARKS,
  STAGE_SCALE,
  STEM_TOP,
  TOOL_R,
  TOOL_SIDE_Y0,
  TRACKS,
  UNIT,
  WING_L_2D,
  WING_R_2D,
  Z0,
  Z1,
  blade,
  bulbSilhouette,
  bulbTop,
  faceMatrix,
  flat,
  iso,
  keyframesOf,
  pointsOf,
  prism,
  sidePath,
} from './welcomeReel'
import type { Face, Pt, V3 } from './welcomeReel'

/**
 * THE OTHER HALF OF THE FRONT DOOR: a cube being made into an arrow and back,
 * by every bench in the app, on a loop.
 *
 * The welcome screen is one column at the left of a window that is usually
 * much wider, and the rest of it was bare ground. This is what stands there:
 * not a control, not a picture of the app, but the app's three tools doing the
 * one thing each of them does, to one shape, so that what the workshop is FOR
 * is shown rather than told. See `welcomeReel.ts` for the story and every
 * number in it; this file is the drawing and the clock.
 *
 * ONE SVG, NO WEBGL. The front door is the one screen that holds no context
 * open, and it stays that way: an isometric projection of a few boxes is a
 * handful of polygons, and the lathe's own screen has already made the case
 * that a side view of a turned piece is a filled path. Every fill and stroke
 * reads through the theme's tokens, so the loop changes clothes with the rest
 * of the app rather than carrying a palette of its own -- the solid is the
 * colour a fresh object is, because that is what it is.
 *
 * THE MOTION IS THE BROWSER'S. Every element that moves is given its keys once,
 * through the Web Animations API, with the same duration and the same start
 * time; from then on the compositor runs them and this component does nothing
 * at all. There is no frame loop and nothing to schedule, which is the right
 * cost for something that plays in the corner of the eye while a project is
 * being chosen. A user who has asked the system for less motion gets the
 * resting frame -- the cube on its grid -- and nothing moves, the same answer
 * the console's idle animations give. See `motion.ts`.
 *
 * WHAT IS NOT HERE: words. No caption, no bench name, no `title`. It is
 * decoration and says so to a screen reader; anything it might explain is in
 * Help, which is where explaining goes. See `CLAUDE.md`.
 */
export function WelcomeLoop() {
  const svg = useRef<SVGSVGElement>(null)

  useEffect(() => {
    const root = svg.current
    if (!root || prefersReducedMotion() || typeof root.animate !== 'function') return

    const running: Animation[] = []
    for (const track of TRACKS) {
      const keys = keyframesOf(track)
      root.querySelectorAll(`[data-track="${track.name}"]`).forEach((el) => {
        running.push(el.animate(keys, { duration: LOOP * 1000, iterations: Infinity }))
      })
    }
    // One start time for all of them, set by hand rather than left to the
    // frame each happened to be created in: what keeps a blade on the wedge
    // it cuts is that every track reads the same clock from the same zero.
    const zero = document.timeline.currentTime ?? 0
    for (const animation of running) animation.startTime = zero

    return () => {
      for (const animation of running) animation.cancel()
    }
  }, [])

  return (
    <div className="welcome-loop">
      <svg
        ref={svg}
        className="welcome-loop-svg"
        viewBox="0 0 640 600"
        aria-hidden="true"
        focusable="false"
        style={{ '--loop-solid': DEFAULT_OBJECT_COLOR } as CSSProperties}
      >
        <defs>
          <radialGradient id="wl-fade">
            <stop offset="0.45" stopColor="#fff" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id="wl-grid-mask">
            <ellipse cx="0" cy="0" rx="230" ry="130" fill="url(#wl-fade)" />
          </mask>
          {/* The pulled mass is round, so it cannot take one flat shade the
              way a face does: it is lit across, from the front's light on the
              left to the right face's dark on the right, through the solid's
              own colour. The stops read the same tokens the faces do. */}
          <linearGradient id="wl-bulb-shade" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" className="wl-bulb-stop-0" />
            <stop offset="0.42" className="wl-bulb-stop-1" />
            <stop offset="0.6" className="wl-bulb-stop-2" />
            <stop offset="1" className="wl-bulb-stop-3" />
          </linearGradient>
          {/* The lathe's two windows: the wings are seen only below the tool
              and the roof only to its left, so each is a rectangle the tool's
              track slides along. See `welcomeReel.ts`. */}
          <clipPath id="wl-wing-clip">
            <rect data-track="wing-clip" x={-2 * UNIT} y={TOOL_SIDE_Y0} width={4 * UNIT} height={-TOOL_SIDE_Y0} />
          </clipPath>
          <clipPath id="wl-roof-clip">
            <rect data-track="roof-clip" x={-0.6 * UNIT} y={-3.2 * UNIT} width={1.2 * UNIT} height={0.6 * UNIT} />
          </clipPath>
        </defs>

        {/* The stage: the ground's centre a little below the middle of the
            box, since the shapes stand up from it, and the whole drawing
            scaled up from the units it is written in. */}
        <g transform={`translate(320 378) scale(${STAGE_SCALE})`}>
          <g data-track="view3d">
            <Grid />
            <g data-track="bed" className="wl-bed wl-off">
              <Prism faces={prism(BED, BED_Z0, BED_Z1)} />
            </g>

            {/* THE BLADES' INSIDES go under every solid, so the block hides
                whatever of a blade is within it. See `blade`. */}
            <BladeBack side={-1} />
            <BladeBack side={1} />

            {/* NEARER THINGS LATER. The left cube goes under the stem, because
                the face where they meet is the stem's to show; the right one
                over it, for the same reason the other way round. */}
            <g data-track="cube-l" className="wl-off">
              <Prism faces={prism(CUBE_L, Z0, Z1)} />
            </g>
            <g data-track="stem" className="wl-stem">
              <g transform={faceMatrix('front', Z1)}>
                <g data-track="stem-h">
                  <rect x={-0.5} y={0} width={1} height={1} className="wl-front" />
                </g>
              </g>
              <g transform={faceMatrix('right', 0.5)}>
                <g data-track="stem-h">
                  <rect x={-0.5} y={0} width={1} height={1} className="wl-right" />
                </g>
              </g>
              <g data-track="stem-top">
                <polygon points={pointsOf(STEM_TOP)} className="wl-top" />
              </g>
            </g>
            <g data-track="cube-r" className="wl-off">
              <Prism faces={prism(CUBE_R, Z0, Z1)} />
            </g>
            {/* ONE SOLID AT A TIME from the landing to the lathe: the T, the
                T less a corner, the arrow. Each is one polygon pushed through
                the depth, so nothing is drawn where a cube was joined or where
                a head would meet a stem. See `welcomeReel.ts`. */}
            <g data-track="solid-t" className="wl-off">
              <Prism faces={prism(SOLID_T, Z0, Z1)} />
            </g>
            <g data-track="solid-pent" className="wl-off">
              <Prism faces={prism(SOLID_PENT, Z0, Z1)} />
            </g>
            <g data-track="solid-arrow" className="wl-off">
              <Prism faces={prism(SOLID_ARROW, Z0, Z1)} />
            </g>
            {/* What the lathe's pull made: the mass on the square base, drawn
                from the same profile the side view morphs to. */}
            <g data-track="bulb" className="wl-off">
              <Bulb />
            </g>

            <Pivot at={iso(PIVOT_OFFCUT_L)}>
              <g data-track="offcut-l" className="wl-off">
                <Prism faces={prism(OFFCUT_L, Z0, Z1, PIVOT_OFFCUT_L)} />
              </g>
            </Pivot>
            <Pivot at={iso(PIVOT_OFFCUT_R)}>
              <g data-track="offcut-r" className="wl-off">
                <Prism faces={prism(OFFCUT_R, Z0, Z1, PIVOT_OFFCUT_R)} />
              </g>
            </Pivot>
            <BladeFront side={-1} />
            <BladeFront side={1} />
            <CutFlash side={-1} />
            <CutFlash side={1} />

            {/* The gap in the dash is twice the path, so that wound fully off
                the pattern's NEXT dash cannot reach in from the far end -- with
                a gap the path's own length it did, and the line's tail showed
                before its head. */}
            <path
              data-track="cut-line"
              className="wl-cut-line wl-off"
              d={CUT_PATH}
              strokeDasharray={`${CUT_PATH_LENGTH} ${CUT_PATH_LENGTH * 2}`}
              strokeDashoffset={CUT_PATH_LENGTH}
            />
            {/* What the laser takes: the sliver of box above its line, and the
                mass on it, falling together. */}
            <Pivot at={iso(PIVOT_OFFCUT_LASER)}>
              <g data-track="offcut-laser" className="wl-off">
                <Prism faces={prism(OFFCUT_SLICE, Z0, Z1, PIVOT_OFFCUT_LASER)} />
                <Bulb pivot={PIVOT_OFFCUT_LASER} />
              </g>
            </Pivot>
            {/* The beam rides the line it burns; the head it comes from is
                above the picture, so only the ray is seen. */}
            <g data-track="beam" className="wl-beam wl-off" style={{ offsetPath: `path("${CUT_PATH}")` }}>
              <g data-track="beam-pop">
                <line x1={0} y1={-140} x2={0} y2={0} className="wl-beam-ray" />
                <circle r={9} className="wl-beam-glow" />
                <circle r={3.2} className="wl-beam-dot" />
              </g>
            </g>
            {SPARKS.map((spark) => (
              <Pivot key={spark.name} at={[spark.x, spark.y]}>
                <g data-track={spark.name} className="wl-spark wl-off">
                  <line x1={0} y1={0} x2={0} y2={-13} />
                  <line x1={0} y1={0} x2={11} y2={6} />
                  <line x1={0} y1={0} x2={-10} y2={8} />
                </g>
              </Pivot>
            ))}
          </g>

          {/* THE SIDE VIEW, folded flat until the camera swings to it. The
              lathe's own screen: a ruled frame, the axis, the faceplate, and
              the piece as a filled shape -- the part the lathe leaves, and the
              parts it takes, each behind its window. */}
          <g data-track="view2d" className="wl-view2d">
            <rect
              x={-2 * UNIT}
              y={-3.6 * UNIT}
              width={4 * UNIT}
              height={4.1 * UNIT}
              className="wl-lathe-frame"
            />
            {[-1, -2, -3].map((y) => (
              <line key={y} x1={-2 * UNIT} y1={y * UNIT} x2={2 * UNIT} y2={y * UNIT} className="wl-lathe-rule" />
            ))}
            <line x1={0} y1={-3.6 * UNIT} x2={0} y2={0.5 * UNIT} className="wl-lathe-axis" />
            <rect x={-1.5 * UNIT} y={0} width={3 * UNIT} height={0.2 * UNIT} className="wl-faceplate" />

            <polygon data-track="core" points={pointsOf(CORE_2D.map(flat))} className="wl-piece" />
            <g clipPath="url(#wl-wing-clip)">
              <polygon points={pointsOf(WING_L_2D.map(flat))} className="wl-piece" />
              <polygon points={pointsOf(WING_R_2D.map(flat))} className="wl-piece" />
            </g>
            <g clipPath="url(#wl-roof-clip)">
              <polygon points={pointsOf(ROOF_2D.map(flat))} className="wl-piece" />
            </g>
            <g data-track="core">
              {[0.55, 1.25, 1.95].map((y) => (
                <line key={y} x1={-0.5 * UNIT} y1={-y * UNIT} x2={0.5 * UNIT} y2={-y * UNIT} className="wl-ring" />
              ))}
            </g>
            {/* The piece as one outline, from the facing pass on: the same
                rectangle to begin with, and then whatever the pull makes of
                it. Its `d` is what the pull's track drives. */}
            <path data-track="pulled" className="wl-piece wl-off" d={sidePath(PROFILE_RECT)} />

            {CHIPS.map((chip) => (
              <Pivot key={chip.name} at={[chip.x, chip.y]}>
                <g data-track={chip.name} className="wl-off">
                  <rect x={-3} y={-3} width={6} height={6} className="wl-chip" />
                </g>
              </Pivot>
            ))}
            <g data-track="tool" className="wl-off">
              <circle r={TOOL_R} className="wl-tool" />
              <circle r={2} className="wl-tool-centre" />
            </g>
            <g data-track="pull" className="wl-off">
              <circle r={TOOL_R} className="wl-tool-pull" />
              <circle r={2} className="wl-tool-pull-centre" />
            </g>
          </g>
        </g>
      </svg>
    </div>
  )
}

/** A prism's visible faces, each shaded by the way it points. */
function Prism({ faces }: { faces: Face[] }) {
  return (
    <>
      {faces.map((face, i) => (
        <polygon key={i} points={pointsOf(face.points)} className={`wl-${face.shade}`} />
      ))}
    </>
  )
}

/**
 * A place on the page for something to turn about. The animated group inside
 * is drawn relative to this point, so its transform's origin is the point
 * itself and nothing has to be said about `transform-origin` at all.
 */
function Pivot({ at: [x, y], children }: { at: Pt; children: ReactNode }) {
  return <g transform={`translate(${Math.round(x * 100) / 100} ${Math.round(y * 100) / 100})`}>{children}</g>
}

/**
 * The part of a cut plane within the block's reach, drawn under the solids so
 * they hide it. It rides the same track as the part over them, so the two
 * move as the one plane they are.
 */
function BladeBack({ side }: { side: -1 | 1 }) {
  const { pivot, under, underEdge } = blade(side)
  return (
    <Pivot at={iso(pivot)}>
      <g data-track={side < 0 ? 'blade-l' : 'blade-r'} className="wl-off">
        <polygon points={pointsOf(under)} className="wl-blade-fill" />
        <polyline points={pointsOf(underEdge)} className="wl-blade-edge" />
      </g>
    </Pivot>
  )
}

/** The part of the plane nothing in the block can stand in front of -- the
 *  strip before its front face and the end above its top -- over everything,
 *  with the arrow that says which way it faces. */
function BladeFront({ side }: { side: -1 | 1 }) {
  const { pivot, over, overEdge, arrow } = blade(side)
  return (
    <Pivot at={iso(pivot)}>
      <g data-track={side < 0 ? 'blade-l' : 'blade-r'} className="wl-off">
        <polygon points={pointsOf(over)} className="wl-blade-fill" />
        <polyline points={pointsOf(overEdge)} className="wl-blade-edge" />
        <line
          x1={round(arrow.base[0])}
          y1={round(arrow.base[1])}
          x2={round(arrow.tip[0])}
          y2={round(arrow.tip[1])}
          className="wl-blade-normal"
        />
        <polygon points={pointsOf(arrow.head)} className="wl-blade-head" />
      </g>
    </Pivot>
  )
}

/** The pulled mass: its silhouette, shaded across, and its flat top. Drawn
 *  standing on the base and again, relative to a pivot, as part of what the
 *  laser takes off. */
function Bulb({ pivot }: { pivot?: V3 }) {
  return (
    <>
      <polygon points={pointsOf(bulbSilhouette(PROFILE_LIP, pivot))} className="wl-bulb" />
      <polygon points={pointsOf(bulbTop(PROFILE_LIP, pivot))} className="wl-bulb-top" />
    </>
  )
}

/** The flash at the cut: the edge of the cut's section, drawn round by its
 *  dash and lit white over everything. */
function CutFlash({ side }: { side: -1 | 1 }) {
  const { pivot, section, perimeter } = blade(side)
  return (
    <Pivot at={iso(pivot)}>
      <polygon
        data-track={side < 0 ? 'flash-l' : 'flash-r'}
        className="wl-flash wl-off"
        points={pointsOf(section)}
        strokeDasharray={`${perimeter} ${perimeter * 2}`}
        strokeDashoffset={perimeter}
      />
    </Pivot>
  )
}

/** The modelling screen's ground: a line every half unit, fading out at the edge. */
function Grid() {
  const steps: number[] = []
  for (let i = -GRID_REACH; i <= GRID_REACH + 1e-9; i += GRID_STEP) steps.push(Math.round(i * 100) / 100)
  const line = (a: Pt, b: Pt, key: string, major: boolean) => (
    <line
      key={key}
      x1={round(a[0])}
      y1={round(a[1])}
      x2={round(b[0])}
      y2={round(b[1])}
      className={major ? 'wl-grid-major' : 'wl-grid-minor'}
    />
  )
  return (
    <g data-track="grid" mask="url(#wl-grid-mask)">
      {steps.map((i) => line(iso([i, 0, -GRID_REACH]), iso([i, 0, GRID_REACH]), `x${i}`, Number.isInteger(i)))}
      {steps.map((i) => line(iso([-GRID_REACH, 0, i]), iso([GRID_REACH, 0, i]), `z${i}`, Number.isInteger(i)))}
    </g>
  )
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
