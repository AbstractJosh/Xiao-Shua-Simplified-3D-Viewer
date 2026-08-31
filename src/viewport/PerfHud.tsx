import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useEvalStatus } from '../store/evalStore'
import { PERF_ON, noteFrame, perf } from './perfProbe'

/**
 * The half of the readout that lives INSIDE the canvas, because that is where
 * the renderer is.
 *
 * Draws nothing. It exists to read `gl.info` once a frame and fold the frame
 * interval in, which is the only work in this file that has to happen on the
 * render loop.
 *
 * IT READS LAST FRAME'S COUNTERS, and that is correct rather than a bug to fix.
 * `gl.info.autoReset` is on by default and three zeroes the counters at the
 * start of each render; react-three-fiber runs every default-priority
 * `useFrame` callback BEFORE that render. So what is standing in `gl.info` when
 * this runs is the frame that just finished. One frame of lag on a number that
 * is smoothed over a hundred and twenty of them is nothing, and the alternative
 * -- a negative-priority callback, or resetting by hand -- would put this file
 * in charge of three's bookkeeping for the sake of it.
 */
export function PerfProbe() {
  const { gl } = useThree()

  useFrame(() => {
    noteFrame(performance.now())
    const render = gl.info.render
    perf.calls = render.calls
    perf.triangles = render.triangles
    perf.lines = render.lines
    perf.geometries = gl.info.memory.geometries
    perf.textures = gl.info.memory.textures
    perf.programs = gl.info.programs?.length ?? 0
  })

  return null
}

/**
 * The half that lives outside it, as plain DOM.
 *
 * Driven by rAF and written straight into `textContent`, for the same reason
 * `RotationReadout` and the ruler chips are: this changes every frame, and
 * React state at that rate is precisely the cost the numbers exist to expose.
 * A HUD that re-rendered the tree sixty times a second would be measuring
 * itself and reporting the app.
 *
 * The evaluator's own two numbers are pulled in beside the renderer's on
 * purpose. They are the question this whole readout was added to settle: the
 * bar says "145,637 tris · 0.4 ms" and the scene still stutters, so which half
 * of the frame is the expensive one -- the boolean solve, or the draw? Standing
 * them next to each other is the answer, and `tri` far exceeding `doc` is the
 * outline pass rather than the model.
 */
export function PerfHud() {
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!PERF_ON) return
    let frame = 0
    let shown = ''
    const tick = () => {
      const node = box.current
      if (node) {
        const evaluation = useEvalStatus.getState()
        const fps = perf.frameMs > 0 ? 1000 / perf.frameMs : 0
        const text = [
          `${perf.frameMs.toFixed(1)} ms  (${fps.toFixed(0)} fps)`,
          `worst ${perf.worstMs.toFixed(1)} ms / 2 s`,
          `${perf.calls} calls`,
          `gpu ${perf.triangles.toLocaleString()} tri  ${perf.lines.toLocaleString()} line`,
          `doc ${evaluation.triangles.toLocaleString()} tri  ${evaluation.millis.toFixed(1)} ms`,
          `${perf.picks} pick  ${perf.pickMs.toFixed(2)} ms`,
          `${perf.geometries} geom  ${perf.textures} tex  ${perf.programs} prog`,
        ].join('\n')
        // Compared before writing: the browser relayouts on a textContent write
        // whether or not the text changed, and most frames it has not.
        if (text !== shown) {
          node.textContent = text
          shown = text
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  if (!PERF_ON) return null
  return <div className="perf-hud" ref={box} />
}
