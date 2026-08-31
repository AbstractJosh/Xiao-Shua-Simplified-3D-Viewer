/**
 * What the frame actually cost, for a readout that must not itself cost a frame.
 *
 * The bar already prints `N objects · N tris · N ms`, and every one of those
 * numbers comes from the GEOMETRY EVALUATOR -- see `evalStore`. They are the
 * boolean solve's triangles and the boolean solve's time. Neither says anything
 * about how long a frame took to draw, how many draw calls it took to draw it,
 * or how much of the GPU the scene is holding. So a scene can be reported at
 * "145,637 tris · 0.2 ms" and still stutter, and until now there was no way to
 * see why. This is that missing half.
 *
 * Module-level and mutable, for the reason `rotationIndicator` and
 * `snapIndicator` are: it is written once a frame from inside the canvas and
 * read once a frame by a DOM node outside it, and routing sixty updates a
 * second through the store would re-render the console to move a number that is
 * measuring how expensive re-rendering is. A probe that perturbs what it
 * measures is worse than no probe.
 */

/**
 * Whether any of this runs at all.
 *
 * TWO GATES, and both are deliberate. `import.meta.env.DEV` is what lets the
 * bundler drop every branch below out of a production build -- the constant
 * folds to `false` and the dead code goes with it, so the shipped app carries
 * no probe, no ring buffer and no per-frame `gl.info` read. The query parameter
 * is what keeps it off during ordinary development too: a HUD that is always
 * there is a HUD nobody reads, and this one covers the corner of the viewport
 * that the tools island lives in.
 *
 * Open the app at `?perf` to arm it.
 *
 * WRITTEN AS `typeof import.meta.env` RATHER THAN `import.meta.env?.DEV`, and
 * the difference is the whole point of the line. Vite substitutes the literal
 * text `import.meta.env.DEV` for `false` in a production build, which is what
 * lets the minifier fold this constant and drop every branch that reads it --
 * the shipped app carries no probe, no ring buffer and no per-frame `gl.info`
 * read. An optional chain is a different expression, so the substitution misses
 * it, nothing folds, and the whole HUD ships inert instead of not shipping.
 *
 * The `typeof` guard is what keeps that safe outside a bundler. The check suite
 * imports this module tree headlessly through `picking.ts`, and under `tsx`
 * there is no substitution and no `import.meta.env` -- reading `.DEV` off
 * undefined throws at import time and takes all five check scripts down with
 * it. Asking whether the object exists first is the one form that both node and
 * the bundler answer correctly.
 */
const BUNDLED_FOR_DEV: boolean =
  typeof import.meta.env !== 'undefined' && import.meta.env.DEV === true

export const PERF_ON: boolean =
  BUNDLED_FOR_DEV &&
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('perf')

/**
 * How many frames the worst-case figure looks back over.
 *
 * Two seconds at sixty. A mean alone hides exactly the thing being hunted here
 * -- a scene that draws at 8 ms and hitches to 40 every time the evaluator runs
 * averages out to something that looks fine -- so the number worth showing next
 * to the mean is the worst of a window long enough to have caught a hitch and
 * short enough to forget one that has been fixed.
 */
const WINDOW = 120

/**
 * The last frame's readings.
 *
 * `calls`, `triangles` and `lines` are what the RENDERER did, which is the
 * number to compare against the bar's evaluator triangles: if the GPU is
 * drawing far more than the document contains, the excess is outlines and the
 * ground, not the model. `lines` being non-zero at all is the outline pass.
 */
export const perf = {
  /** Exponential mean of the frame interval, in milliseconds. */
  frameMs: 0,
  /** Worst frame interval in the last `WINDOW` frames, in milliseconds. */
  worstMs: 0,
  /** Draw calls last frame. */
  calls: 0,
  /** Triangles the renderer submitted last frame. */
  triangles: 0,
  /** Line segments the renderer submitted last frame -- the outline pass. */
  lines: 0,
  /** Live geometries, textures and compiled programs. A count that climbs
   *  across a session with the scene unchanged is a leak. */
  geometries: 0,
  textures: 0,
  programs: 0,
  /** Raycasts against document geometry since the last frame was read, and what
   *  they cost. The brush ghost alone spends one of these per frame, and a
   *  stroke spends one per pointer sample -- see `dragErode`. */
  picks: 0,
  pickMs: 0,
}

const intervals = new Float32Array(WINDOW)
let cursor = 0
let filled = 0
let last = 0

/** Picks accumulate between frames and are read out by the probe. */
let pickCount = 0
let pickMillis = 0

/**
 * Fold one frame's interval in.
 *
 * Called by `PerfProbe` from inside the canvas. The FIRST call only starts the
 * clock: there is no interval before there are two timestamps, and counting the
 * gap between mount and first frame as a frame time would open every session
 * with a fictional hitch.
 */
export function noteFrame(now: number): void {
  if (!PERF_ON) return
  if (last !== 0) {
    const delta = now - last
    // 0.12, the same smoothing the orbit controls damp with, for no deeper
    // reason than that it settles at about the rate an eye reads a number.
    perf.frameMs = perf.frameMs === 0 ? delta : perf.frameMs + (delta - perf.frameMs) * 0.12
    intervals[cursor] = delta
    cursor = (cursor + 1) % WINDOW
    if (filled < WINDOW) filled += 1
    let worst = 0
    for (let i = 0; i < filled; i += 1) if (intervals[i] > worst) worst = intervals[i]
    perf.worstMs = worst
  }
  last = now

  perf.picks = pickCount
  perf.pickMs = pickMillis
  pickCount = 0
  pickMillis = 0
}

/**
 * One raycast against document geometry, and what it cost.
 *
 * Called from `raycastLocal`, which is the single place every pick in the app
 * goes through. Compiled away when the probe is off: `PERF_ON` is a constant,
 * so the body folds out and the call sites are left holding nothing.
 */
export function notePick(millis: number): void {
  if (!PERF_ON) return
  pickCount += 1
  pickMillis += millis
}
