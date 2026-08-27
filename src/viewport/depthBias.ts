import { extend } from '@react-three/fiber'
import type { ThreeElement } from '@react-three/fiber'
import { MeshStandardMaterial } from 'three'
import type { WebGLProgramParametersWithUniforms } from 'three'

/**
 * The tiebreak between two solids presenting the SAME surface -- and the one
 * mechanism left that can still express it in this scene.
 *
 * WHAT TEARS. Two objects that overlap and are then severed by one cut plane
 * end up with cut faces that are coplanar AND overlapping. The depth buffer has
 * no tiebreak for that: the shared face stipples into both colours, differing
 * pixel to pixel on rounding alone. Merging the two solids fixes it by deleting
 * the question -- the union removes the surface they share, so there is nothing
 * left to tie -- which is exactly why a merge has always looked right while
 * everything else went on tearing. Two objects that are NOT merged each keep
 * their face, and the tie is all there is.
 *
 * WHY NOT POLYGON OFFSET. Because in this canvas it does nothing at all. The
 * scene runs a LOGARITHMIC depth buffer -- a 200,000:1 frustum is far past what
 * 24 bits resolve linearly, so it is not an optimisation here but the thing
 * that keeps faces from tearing everywhere at once. Under it, three's materials
 * write `gl_FragDepth` themselves, on a curve taken from the clip-space `w` the
 * vertex stage kept:
 *
 *     gl_FragDepth = log2( vFragDepth ) * logDepthBufFC * 0.5
 *
 * Polygon offset is applied by the RASTERIZER, to the depth that assignment
 * throws away. So `polygonOffsetUnits` here is not too small, it is INERT --
 * and that is the whole of the bug this replaces. The offset was written while
 * the buffer was still linear and was silently unplugged the day the scene took
 * a log buffer for its real-world scale: nothing failed, nothing warned, and
 * coplanar faces went quietly back to stippling. Depth written by a shader can
 * only be biased by that shader, which is what the rest of this file is for.
 * See `GuideGrid`, which pays the same toll for the same reason.
 */

/**
 * The smallest difference a 24-bit depth buffer can hold, and the unit this
 * whole file counts in: WINDOW depth, the [0, 1] value that lands in the
 * buffer, not GL's offset units and not world units.
 */
const DEPTH_LSB = 1 / 2 ** 24

/**
 * Depth pulled toward the camera per step down the scene tree.
 *
 * Sixty-four of those smallest steps. The rounding it has to beat is the last
 * bit or so of an interpolated float -- a part in ten million of a varying,
 * which works out well under a single step -- so this clears the noise by more
 * than two orders of magnitude while staying far below anything an eye can
 * find: at the distance the app opens at it is a couple of hundredths of a
 * millimetre of real depth.
 *
 * One number serves the entire envelope, and that is the log buffer giving
 * something back. A fixed step in window depth is a fixed RELATIVE step in the
 * world, so this is the same tiny fraction of the viewing distance for a
 * millimetre part held close and for a five-metre one framed from eleven metres
 * out. A linear buffer would have needed a different number for each.
 */
export const BIAS_STEP = 64 * DEPTH_LSB

/**
 * Which of two solids presenting the same surface gets drawn.
 *
 * Geometry cannot answer it, because both are equally there. The scene tree
 * can: it has always been an order, and this makes the order mean something.
 * Higher in the list wins -- see `moveObject`, which is how the user says so.
 *
 * A depth NUDGE rather than a draw-order swap on purpose. `renderOrder` decides
 * which mesh is submitted first, and for opaque geometry the depth test then
 * throws that away and the tie comes straight back. Only a depth offset settles
 * it.
 *
 * The bottom row is left exactly unbiased, so a scene of one object writes the
 * depth it always did and the nudges only ever pull the rows above it forward.
 * Exported for the check suite.
 */
export function depthBias(rank: number, count: number): { depthBias: number } {
  return { depthBias: Math.max(0, count - 1 - rank) * BIAS_STEP }
}

/**
 * The two names the patch below keys off in three's own standard shader.
 *
 * Exported and checked against `node_modules` in `ui-check`, the same bargain
 * `GuideGrid` and the axis colours strike: this is string surgery on somebody
 * else's shader, and a three upgrade that renamed the chunk would take the
 * tiebreak out again as quietly as the log buffer did the first time.
 */
export const BIAS_ANCHOR = '#include <logdepthbuf_fragment>'
export const BIAS_UNIFORM = 'uDepthBias'

/**
 * Teach a copy of three's standard shader to answer a depth bias.
 *
 * Subtracted AFTER the chunk that writes the depth, because that assignment
 * overwrites whatever was there -- a bias applied before it would be discarded
 * exactly the way polygon offset is. Guarded on the same define the chunk is,
 * so with the log buffer off this leaves a declaration nobody reads rather than
 * a shader that writes depth for no reason.
 *
 * The declaration goes at the very top of the source. Three's own prefix --
 * version, precision, defines -- is prepended to this string later, so the top
 * of it is already inside the shader proper, and the anchor itself sits in the
 * middle of `main()`, where a uniform cannot be declared.
 *
 * Pure, and separate from the material that applies it, so `ui-check` can run
 * it and read the result without a GPU.
 */
export function withDepthBias(shader: { fragmentShader: string }): void {
  if (!shader.fragmentShader.includes(BIAS_ANCHOR)) return
  shader.fragmentShader =
    `uniform float ${BIAS_UNIFORM};\n` +
    shader.fragmentShader.replace(
      BIAS_ANCHOR,
      `${BIAS_ANCHOR}\n\t#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )\n\t\tgl_FragDepth -= ${BIAS_UNIFORM};\n\t#endif`
    )
}

/** Said once if three's standard shader has moved out from under the patch, so
 *  the tearing coming back is at least explained in the console rather than
 *  only visible. `ui-check` is what should catch this first. */
let warned = false

/**
 * A standard material that can be pulled a hair toward the camera.
 *
 * A subclass rather than an `onBeforeCompile` prop at the call site, for two
 * reasons both about the program cache. Three keys compiled programs by
 * `customProgramCacheKey`, which for a patched material is the SOURCE TEXT of
 * its `onBeforeCompile`: a method on the prototype is one string for every
 * instance, so the whole scene shares one compiled program, where a closure
 * written per material would recompile the standard shader once per object.
 * And the bias rides a UNIFORM, so moving an object up the tree changes a
 * number the next frame uploads -- it never touches the shader, and nothing
 * recompiles.
 */
export class BiasedStandardMaterial extends MeshStandardMaterial {
  /** Handed to the compiled program by reference, which is what makes the
   *  setter below the whole of an update. */
  private readonly bias = { value: 0 }

  get depthBias(): number {
    return this.bias.value
  }

  /** Window depth, toward the camera. See `BIAS_STEP`. */
  set depthBias(units: number) {
    this.bias.value = units
  }

  onBeforeCompile(shader: WebGLProgramParametersWithUniforms): void {
    shader.uniforms[BIAS_UNIFORM] = this.bias
    const before = shader.fragmentShader
    withDepthBias(shader)
    if (before === shader.fragmentShader && !warned) {
      warned = true
      console.error(
        `BiasedStandardMaterial: three's standard shader no longer carries ${BIAS_ANCHOR}, ` +
          'so coplanar faces of different objects have nothing to separate them. See depthBias.ts.'
      )
    }
  }
}

extend({ BiasedStandardMaterial })

declare module '@react-three/fiber' {
  interface ThreeElements {
    biasedStandardMaterial: ThreeElement<typeof BiasedStandardMaterial>
  }
}
