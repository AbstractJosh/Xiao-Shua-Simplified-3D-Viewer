import { useLayoutEffect, useRef } from 'react'
import type { ComponentProps } from 'react'
import { Grid } from '@react-three/drei'
import { ShaderChunk } from 'three'
import type { Mesh, ShaderMaterial, WebGLProgramParametersWithUniforms } from 'three'

/**
 * The ground grid, with two things put right that drei's `Grid` cannot know
 * about: this canvas has a LOGARITHMIC DEPTH BUFFER, and there are two of these
 * stacked almost exactly on top of each other.
 *
 * Either one alone makes the grid shimmer while the camera moves and go on
 * shimmering until it stops. Together they make it unmissable.
 *
 * WHAT GOES WRONG, FIRST: `Grid` is a custom `ShaderMaterial`, and a custom
 * shader in a log-depth scene writes the WRONG DEPTH unless it says otherwise.
 * Three defines `USE_LOGARITHMIC_DEPTH_BUFFER` for every non-raw program and
 * hands it a `logDepthBufFC` uniform, but the chunks that USE them have to be
 * `#include`d by the shader itself -- built-in materials do, drei's grid does
 * not. So every solid in the scene writes `gl_FragDepth` on the logarithmic
 * curve while the grid writes the hardware's own, and the two are not
 * comparable: a grid fragment at ten units reports 0.9995 where a solid at the
 * same ten units reports 0.35.
 *
 * It nearly gets away with it, which is why it survived this long. The grid is
 * transparent, so it draws after the opaque pass, and its inflated depth loses
 * to every solid and beats the cleared background -- which happens to look like
 * "grid behind objects, grid on empty space". What it cannot survive is being
 * compared against ANOTHER grid.
 *
 * AND SECOND: there are two, a fine one and a coarse one, half a thousandth of
 * a unit apart, and both wrote depth. On the hardware curve, in a frustum
 * running from 5 mm to a kilometre, half a thousandth of a unit is far below
 * what the buffer resolves at any distance the scene is worked at -- and the
 * coarse grid's quad, blown up by `infiniteGrid` to some seven thousand units
 * across, carries interpolation error across a single triangle that dwarfs the
 * gap several times over. So the two fought, pixel by pixel, and which one won
 * was decided by rounding that changed with every camera angle.
 *
 * On top of that they are both TRANSPARENT and centred on the same point, so
 * three sorted them against each other by a depth difference of essentially
 * zero -- and the order flipped as the camera came round, swapping which of the
 * two got to write depth first. That is the "and after": the flip happens on
 * whatever frame the sort tips over, and OrbitControls' damping keeps the
 * camera creeping for the better part of a second after the hand has stopped.
 *
 * THE FIX IS BOTH HALVES. The material is taught the log depth buffer, so its
 * depth is finally on the same curve as everything else it is tested against;
 * and the two grids stop writing depth at all, taking a fixed `renderOrder`
 * instead, so which of them lands on top is a decision rather than a race. They
 * are the ground: nothing in the scene needs to be occluded BY them, and every
 * solid is already drawn, and depth-tested against, before they are.
 */

/**
 * The three places the patch keys off in drei's own shader source.
 *
 * Exported and checked against `node_modules` in `ui-check`, the same bargain
 * the axis colours strike with `styles.css`: this is string surgery on somebody
 * else's shader, and a drei upgrade that reworded any one of these would
 * silently put the shimmer back. A check that reads their source is the only
 * thing standing between that and a bug nobody can explain.
 */
export const GRID_MAIN = 'void main() {'
export const GRID_CLIP = 'gl_Position = projectionMatrix * viewMatrix * worldPosition;'
export const GRID_BODY = 'float g1 = getGrid(cellSize, cellThickness);'

/**
 * Teach a copy of drei's grid shader to write logarithmic depth.
 *
 * Built from `ShaderChunk` rather than from hand-written GLSL so it stays
 * three's own definition of what log depth means -- change the version and this
 * follows. The one thing that has to be added by hand is `<common>`, in the
 * vertex shader: `logdepthbuf_vertex` calls `isPerspectiveMatrix`, which lives
 * there, and drei's grid includes no chunks in its vertex shader at all.
 *
 * Pure, and separate from the material it is applied to, so `ui-check` can run
 * it and read the result without a GPU.
 */
export function withLogDepth(shader: {
  vertexShader: string
  fragmentShader: string
}): void {
  shader.vertexShader = shader.vertexShader
    .replace(
      GRID_MAIN,
      `#include <common>\n${ShaderChunk.logdepthbuf_pars_vertex}\n${GRID_MAIN}`
    )
    // After the clip position, because that is what the chunk reads: it keeps
    // `gl_Position.w`, the eye distance, for the fragment stage to take a
    // logarithm of.
    .replace(GRID_CLIP, `${GRID_CLIP}\n${ShaderChunk.logdepthbuf_vertex}`)

  shader.fragmentShader = shader.fragmentShader
    // The FIRST `void main()`: `getGrid` is declared above it and is not a
    // `void main`, so there is nothing else here for this to catch.
    .replace(GRID_MAIN, `${ShaderChunk.logdepthbuf_pars_fragment}\n${GRID_MAIN}`)
    // At the top of main, where three puts it in every material of its own.
    // Ahead of the `discard` below, which is harmless: a discarded fragment
    // writes no depth whatever it assigned to `gl_FragDepth` on the way past.
    .replace(GRID_BODY, `${ShaderChunk.logdepthbuf_fragment}\n      ${GRID_BODY}`)
}

/** Said once if drei's shader has moved out from under the patch, so the
 *  shimmer coming back is at least explained in the console rather than only
 *  visible. `ui-check` is what should catch this first. */
let warned = false

/**
 * One of the two ground grids: drei's, with its material corrected on the way
 * in.
 *
 * A wrapper rather than the corrections written twice at the call site, because
 * both grids need exactly the same treatment and the treatment is the subtle
 * part. Everything drei's `Grid` takes passes straight through; `renderOrder`
 * goes to the mesh, which is where three reads it from.
 */
export function GuideGrid(props: ComponentProps<typeof Grid>) {
  const mesh = useRef<Mesh>(null)

  useLayoutEffect(() => {
    const material = mesh.current?.material as ShaderMaterial | undefined
    if (!material) return

    // Not through `<Grid>`'s props: those are spread onto the MESH, and depth
    // writing is a property of the material. This is the only way in.
    material.depthWrite = false

    material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      const before = shader.vertexShader + shader.fragmentShader
      withLogDepth(shader)
      if (before === shader.vertexShader + shader.fragmentShader && !warned) {
        warned = true
        console.error(
          'GuideGrid: drei\'s Grid shader no longer carries the anchors this patch needs, ' +
            'so the grid is writing hardware depth into a logarithmic depth buffer. See GuideGrid.tsx.'
        )
      }
    }
    // The material was compiled on the first frame, before this ran.
    material.needsUpdate = true
  }, [])

  return <Grid ref={mesh} {...props} />
}
