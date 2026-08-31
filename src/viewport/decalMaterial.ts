import { Vector2, Vector3 } from 'three'
import type { IUniform, Material, Texture } from 'three'
import { MAX_PLACEMENTS } from '../store/referenceStore'
import { PLANE_EPSILON } from './decalPlacement'

/**
 * Reference pictures, painted onto the block by the block's own material.
 *
 * WHY THIS IS A SHADER AND NOT A QUAD ON THE FACE. A decal drawn as its own
 * little plane sitting a hair proud of the surface is half a day's work and
 * wrong the moment the laser is used: cut the block and the plane hangs in the
 * air where the material went. What the user asked for -- and what following a
 * drawing with a beam actually needs -- is for the picture to be ON the
 * surface, so that whatever survives the cut carries its part of the picture
 * and whatever is removed takes its part away.
 *
 * Projecting in the fragment shader gives exactly that, for free and for ever:
 * the test is a question about the surface being drawn, not about the geometry
 * it came from. Rebuild the block as two halves, a lattice, a hundred pieces --
 * every fragment still asks "am I on that plane, inside that rectangle", and
 * the answer is still yes for the material that is left. There is no decal
 * geometry to keep in step, because there is no decal geometry.
 *
 * THE PLANE TEST IS WHAT MAKES IT A DECAL rather than a projector. A cut leaves
 * new faces inside the block, and some of them are parallel to the face the
 * picture is on; a projection with no depth test would paint the picture on
 * those too, like a slide projector shining through a hole. Requiring the
 * fragment to be ON the original plane -- within `PLANE_EPSILON` -- keeps the
 * picture where it was stuck and nowhere else.
 *
 * COST. One `if` per placement per fragment of the block, and the loop leaves
 * as soon as it passes the last one, so a block with no references pays for one
 * comparison. The textures are the three the panel holds, whatever the
 * placements do with them -- an image on six faces is six records against one
 * sampler, not six uploads.
 */

/**
 * How many placements can be painted at once: every slot on every face.
 *
 * Three pictures, six faces. Past that the panel is being used as a texture
 * library rather than as a set of drawings, and the store refuses the drop
 * rather than the shader dropping it silently.
 */
export const MAX_DECALS = MAX_PLACEMENTS

/** One painted picture, as the shader needs it: a plane, a frame and a size. */
export type DecalUniform = {
  normal: Vector3
  u: Vector3
  v: Vector3
  centre: Vector3
  size: Vector2
  depth: number
  /** Which of the preset's three pictures this is: 0, 1 or 2. */
  slot: number
}

export type DecalUniforms = {
  uDecalCount: IUniform<number>
  uDecalOpacity: IUniform<number>
  uDecalNormal: IUniform<Vector3[]>
  uDecalU: IUniform<Vector3[]>
  uDecalV: IUniform<Vector3[]>
  uDecalCentre: IUniform<Vector3[]>
  uDecalSize: IUniform<Vector2[]>
  uDecalDepth: IUniform<number[]>
  uDecalSlot: IUniform<number[]>
  uRefTex0: IUniform<Texture | null>
  uRefTex1: IUniform<Texture | null>
  uRefTex2: IUniform<Texture | null>
}

/** A fresh set of uniforms, all switched off. Mutated in place afterwards. */
export function makeDecalUniforms(): DecalUniforms {
  const fill = <T>(make: () => T): T[] => Array.from({ length: MAX_DECALS }, make)
  return {
    uDecalCount: { value: 0 },
    uDecalOpacity: { value: 0 },
    uDecalNormal: { value: fill(() => new Vector3(0, 0, 1)) },
    uDecalU: { value: fill(() => new Vector3(1, 0, 0)) },
    uDecalV: { value: fill(() => new Vector3(0, 1, 0)) },
    uDecalCentre: { value: fill(() => new Vector3()) },
    uDecalSize: { value: fill(() => new Vector2(1, 1)) },
    uDecalDepth: { value: fill(() => 0) },
    uDecalSlot: { value: fill(() => 0) },
    uRefTex0: { value: null },
    uRefTex1: { value: null },
    uRefTex2: { value: null },
  }
}

/** Copies a decal's numbers into slot `i` of the uniforms, in place. */
export function writeDecal(uniforms: DecalUniforms, i: number, decal: DecalUniform) {
  if (i < 0 || i >= MAX_DECALS) return
  uniforms.uDecalNormal.value[i].copy(decal.normal)
  uniforms.uDecalU.value[i].copy(decal.u)
  uniforms.uDecalV.value[i].copy(decal.v)
  uniforms.uDecalCentre.value[i].copy(decal.centre)
  uniforms.uDecalSize.value[i].copy(decal.size)
  uniforms.uDecalDepth.value[i] = decal.depth
  uniforms.uDecalSlot.value[i] = decal.slot
}

/**
 * The world position and world normal of the fragment being shaded.
 *
 * Both are computed here rather than borrowed from a chunk that may or may not
 * be compiled in: the standard material only defines a world position when
 * something else has asked for one, and a material that draws references
 * correctly until the day an envmap is switched off is worse than one that
 * carries its own two varyings.
 *
 * The normal is `mat3(modelMatrix)` rather than a proper inverse transpose.
 * That is exact for the transforms this screen applies -- translation and an
 * axis-aligned scale -- and the test it feeds only ever accepts axis-aligned
 * faces anyway, so a skew that would break it is a skew that fails the test.
 */
const VERTEX_HEAD = `
varying vec3 vRefWorld;
varying vec3 vRefNormal;
`

const FRAGMENT_HEAD = `
varying vec3 vRefWorld;
varying vec3 vRefNormal;
uniform int uDecalCount;
uniform float uDecalOpacity;
uniform vec3 uDecalNormal[${MAX_DECALS}];
uniform vec3 uDecalU[${MAX_DECALS}];
uniform vec3 uDecalV[${MAX_DECALS}];
uniform vec3 uDecalCentre[${MAX_DECALS}];
uniform vec2 uDecalSize[${MAX_DECALS}];
uniform float uDecalDepth[${MAX_DECALS}];
uniform int uDecalSlot[${MAX_DECALS}];
uniform sampler2D uRefTex0;
uniform sampler2D uRefTex1;
uniform sampler2D uRefTex2;

// Samplers cannot be indexed, so the choice of picture is three branches
// rather than an array lookup. Three is the whole of a preset.
vec4 refFetch(int slot, vec2 uv) {
  if (slot == 0) return texture2D(uRefTex0, uv);
  if (slot == 1) return texture2D(uRefTex1, uv);
  return texture2D(uRefTex2, uv);
}
`

/**
 * The blend, injected after the material has settled its own colour.
 *
 * OVER the diffuse colour and under everything else: a reference is ink on the
 * surface, so it takes the surface's light. Painted after the lighting instead
 * it would glow in the shadows, which is what a floating quad looks like and
 * exactly the thing this is not.
 */
const FRAGMENT_BLEND = `
#include <map_fragment>
{
  vec3 refN = normalize(vRefNormal);
  for (int i = 0; i < ${MAX_DECALS}; i++) {
    if (i >= uDecalCount) break;
    if (dot(refN, uDecalNormal[i]) < 0.999) continue;
    if (abs(dot(vRefWorld, uDecalNormal[i]) - uDecalDepth[i]) > ${PLANE_EPSILON.toFixed(6)}) continue;
    vec3 rel = vRefWorld - uDecalCentre[i];
    vec2 uv = vec2(
      dot(rel, uDecalU[i]) / uDecalSize[i].x + 0.5,
      0.5 - dot(rel, uDecalV[i]) / uDecalSize[i].y
    );
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
    vec4 ink = refFetch(uDecalSlot[i], uv);
    diffuseColor.rgb = mix(diffuseColor.rgb, ink.rgb, ink.a * uDecalOpacity);
  }
}
`

/**
 * Teaches a standard material to paint references, and hands back the uniforms
 * to steer it with.
 *
 * `customProgramCacheKey` is not optional here: without it three hands this
 * material the cached program of any other standard material with the same
 * defines -- one that has never heard of a decal -- and the references
 * disappear the moment a second grey solid is on screen.
 */
export function paintDecals(material: Material, uniforms: DecalUniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_HEAD}`)
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvRefWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      )
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\nvRefNormal = normalize(mat3(modelMatrix) * objectNormal);'
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_HEAD}`)
      .replace('#include <map_fragment>', FRAGMENT_BLEND)
  }
  material.customProgramCacheKey = () => 'reference-decals'
}
