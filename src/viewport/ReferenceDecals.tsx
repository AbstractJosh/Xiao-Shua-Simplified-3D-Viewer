import { useEffect, useMemo, useRef, useState } from 'react'
import { Line } from '@react-three/drei'
import {
  FrontSide,
  Matrix3,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
} from 'three'
import type { MeshStandardMaterial, Object3D } from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import { useEditedUrl } from '../console/editedImage'
import { aspectOf } from '../console/referenceImage'
import { useLaser } from '../store/laserStore'
import { activePreset, useReference } from '../store/referenceStore'
import type { Face, Placement, RefImage } from '../store/referenceStore'
import { useTools } from '../store/toolStore'
import { makeDecalUniforms, paintDecals, writeDecal } from './decalMaterial'
import type { BlockDims, DecalRect } from './decalPlacement'
import {
  CORNERS,
  MIN_DECAL,
  PLANE_EPSILON,
  clampCentre,
  dropSize,
  faceOfNormal,
  faceOffset,
  placementRect,
  resizeFromCorner,
} from './decalPlacement'
import { useSceneColors } from './useSceneColors'

/**
 * References on the block: the paint, the handles, and the hand that moves them.
 *
 * THREE PIECES, and they are separate because they live in three places. The
 * PAINT is the block's own material -- see `decalMaterial.ts` for why a decal
 * cannot be a quad if a laser is going to cut it. The HANDLES are little
 * objects floating a hair off the face: an outline so you can see where the
 * picture ends, and four corners to pull. The HAND is a set of pointer handlers
 * that belong to the BLOCK rather than to any of them, because a drag that
 * starts on a corner finishes wherever the pointer has got to, and the block is
 * the only thing out there wide enough to catch it.
 *
 * THE HANDLES ARE THE MOVE TOOL'S, and they exist only while it is in hand.
 * There used to be a padlock on every decal instead, pinning it so that a cut
 * could be drawn across it without shoving the drawing about -- a per-picture
 * switch for a question that was never about one picture. A tool answers it
 * once for all of them: with a cutter in hand nothing on the face can be
 * shifted, and with Move in hand nothing on the face can be cut. See
 * `LaserTool`.
 *
 * AND THEY BELONG TO THE LIT SLOT. The tool says WHAT you are doing; the panel
 * says WHICH picture you are doing it to -- light a slot and that drawing takes
 * the handles, on every face it is on. Move in hand with nothing lit puts grips
 * on nothing, which is what makes a block wearing three drawings readable. See
 * `highlightId`.
 *
 * A FOURTH PIECE, since a cut stopped being allowed to eat a drawing: the
 * GHOST, which is each picture again as a quad on its own plane, sunk a hair
 * into the block so the block hides it wherever the block still is. See
 * `DecalGhosts`.
 */

/** How far off the face the outlines and grips float, in scene units. */
const LIFT = 0.0008

/**
 * A corner grip, as a share of the decal's shorter side.
 *
 * A SHARE and not a size, with only a floor under it. A fixed size in scene
 * units is a grip that is half the picture on a millimetre block and a speck
 * on a five-metre one -- and this screen's whole point is that both of those
 * are looked at square on, at whatever zoom suits them. Sized against the decal
 * it belongs to, it is the same grip on screen at every size of block.
 *
 * Smaller than the single corner badge that came before it, because there are
 * four of them now and they are on the corners of the picture being traced:
 * four big squares would hide more of the drawing than they help you place.
 */
const GRIP_SHARE = 0.13

/** Never smaller than half the smallest thing this app draws. */
const GRIP_FLOOR = MIN_DECAL / 2

/**
 * How far the ghost sinks BELOW the face it belongs to.
 *
 * The whole trick, in one number. The ghost is the same picture on the same
 * plane as the painted one; standing it a hair INSIDE the block means the
 * block's own surface is in front of it wherever the block still has one, so
 * the depth test hides it there and the painted version -- lit, on the surface,
 * the thing you cut along -- is what you see. Where a cut has taken the
 * material away there is nothing in front of it any more, and the same picture
 * carries on through the gap.
 *
 * No test of what has been cut, no rebuilding when it is: the depth buffer
 * already knows what is left of the block, and this asks it.
 *
 * Twice the plane tolerance, so it is unambiguously behind the surface the
 * shader paints and still far too small to see as an offset.
 */
const SINK = PLANE_EPSILON * 2

/**
 * A unit quad whose v runs DOWN the picture.
 *
 * `planeGeometry`'s own v runs UP it, and the reference textures are loaded
 * unflipped because the projection in the shader reads v down -- see
 * `useUrlTexture`. One or the other has to turn round, and it is this: the
 * geometry is made once and shared by every ghost, where a flipped texture
 * would be a second copy of every picture on the shelf.
 */
const GHOST_QUAD = (() => {
  const quad = new PlaneGeometry(1, 1)
  const uv = quad.attributes.uv
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i))
  uv.needsUpdate = true
  return quad
})()

/** A ghost is a picture, not a thing to point at. */
const noRaycast: Object3D['raycast'] = () => {}

/** A face frame, as the little square handles need it. */
type Frame = { u: Vector3; v: Vector3; normal: Vector3 }

/**
 * The block's three sides.
 *
 * THE ONE PLACE the reference code knows how the block is measured. It is one
 * number today and three when the panel below it grows two more fields, and
 * everything else here takes the three.
 */
export function useBlockDims(): BlockDims {
  return useLaser((s) => s.dims)
}

/** A picture loaded into a texture, or null while it is still arriving. */
function useUrlTexture(url: string | null): Texture | null {
  const [texture, setTexture] = useState<Texture | null>(null)

  useEffect(() => {
    if (!url) {
      setTexture(null)
      return
    }
    let live = true
    let made: Texture | null = null
    const img = new Image()
    img.onload = () => {
      if (!live) return
      made = new Texture(img)
      // A picture is sRGB. A texture that does not say so is taken for linear
      // and comes out washed against the surface it is painted on.
      made.colorSpace = SRGBColorSpace
      // NOT FLIPPED, which three does by default. Its default suits a quad
      // whose own v runs up the picture; the projection here reads v DOWN the
      // picture, the way a canvas and a texture are both indexed -- see
      // `pointUv`. Left flipped, every reference lands upside down, which is a
      // drawing you would cut back to front.
      made.flipY = false
      made.anisotropy = 4
      made.needsUpdate = true
      setTexture(made)
    }
    img.src = url
    return () => {
      live = false
      made?.dispose()
      setTexture(null)
    }
  }, [url])

  return texture
}

/**
 * The three textures the preset in hand paints with.
 *
 * Three calls rather than a loop, because a hook cannot be called in one -- and
 * three is not an implementation detail, it is what a preset IS.
 */
function useSlotTextures(): (Texture | null)[] {
  const preset = useReference(activePreset)
  const first = useUrlTexture(useEditedUrl(preset.slots[0] ?? null))
  const second = useUrlTexture(useEditedUrl(preset.slots[1] ?? null))
  const third = useUrlTexture(useEditedUrl(preset.slots[2] ?? null))
  return useMemo(() => [first, second, third], [first, second, third])
}

/** The decals the block should be wearing, with the slot each paints from. */
function useVisibleDecals(): { placement: Placement; slot: number; image: RefImage }[] {
  const preset = useReference(activePreset)
  const placements = useReference((s) => s.placements)
  const activeId = useReference((s) => s.activePresetId)

  return useMemo(() => {
    const out: { placement: Placement; slot: number; image: RefImage }[] = []
    for (const placement of placements) {
      if (placement.presetId !== activeId) continue
      const slot = preset.slots.findIndex((held) => held?.id === placement.imageId)
      const image = slot >= 0 ? preset.slots[slot] : null
      if (image) out.push({ placement, slot, image })
    }
    return out
  }, [placements, activeId, preset])
}

/**
 * The block's material, taught to paint references.
 *
 * A drop-in for the `meshStandardMaterial` that was there before: same colour,
 * same metalness, same roughness. What it adds is the shader patch and one
 * effect keeping the uniforms in step with the store, so the block's own
 * component does not have to know that references exist at all.
 */
export function ReferenceMaterial({
  color,
  emissive = '#000000',
  emissiveIntensity = 0,
  metalness = 0.15,
  roughness = 0.55,
}: {
  color: string
  emissive?: string
  emissiveIntensity?: number
  metalness?: number
  roughness?: number
}) {
  const material = useRef<MeshStandardMaterial>(null)
  const uniforms = useMemo(() => makeDecalUniforms(), [])
  const dims = useBlockDims()
  const decals = useVisibleDecals()
  const textures = useSlotTextures()
  const opacity = useReference((s) => s.opacity)

  useEffect(() => {
    const mat = material.current
    if (!mat) return
    paintDecals(mat, uniforms)
    mat.needsUpdate = true
  }, [uniforms])

  useEffect(() => {
    uniforms.uDecalCount.value = decals.length
    uniforms.uDecalOpacity.value = opacity
    uniforms.uRefTex0.value = textures[0]
    uniforms.uRefTex1.value = textures[1]
    uniforms.uRefTex2.value = textures[2]
    decals.forEach(({ placement, slot }, i) => {
      const rect = placementRect(placement, dims)
      writeDecal(uniforms, i, {
        normal: new Vector3(...rect.normal),
        u: new Vector3(...rect.u),
        v: new Vector3(...rect.v),
        centre: new Vector3(...rect.centre),
        size: new Vector2(rect.w, rect.h),
        depth: rect.depth,
        slot,
      })
    })
  }, [decals, dims, opacity, textures, uniforms])

  return (
    <meshStandardMaterial
      ref={material}
      color={color}
      emissive={emissive}
      emissiveIntensity={emissiveIntensity}
      metalness={metalness}
      roughness={roughness}
    />
  )
}

const NORMALS = new Matrix3()

/** Which face was hit, and where -- or null for a surface that is not a face. */
function faceHit(e: ThreeEvent<PointerEvent>): { face: Face; point: Vector3 } | null {
  if (!e.face) return null
  const normal = e.face.normal
    .clone()
    .applyMatrix3(NORMALS.getNormalMatrix(e.object.matrixWorld))
    .normalize()
  const face = faceOfNormal([normal.x, normal.y, normal.z])
  return face ? { face, point: e.point } : null
}

/**
 * The pointer handler the BLOCK wears while references are about.
 *
 * Spread onto the block's mesh, and doing three jobs with one event: following
 * a drag out of the panel, sliding a decal about on its face, and pulling one
 * bigger or smaller. All three are the same question -- where on which face is
 * the pointer -- which is why they are one handler and not three.
 */
export function useReferencePointer() {
  const dims = useBlockDims()
  const drag = useReference((s) => s.drag)
  const grab = useReference((s) => s.grab)
  const placements = useReference((s) => s.placements)
  const preset = useReference(activePreset)
  const dragOver = useReference((s) => s.dragOver)
  const movePlacement = useReference((s) => s.movePlacement)
  const sizePlacement = useReference((s) => s.sizePlacement)

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!drag && !grab) return
    const hit = faceHit(e)
    if (!hit) {
      if (drag) dragOver(null)
      return
    }
    const here = faceOffset([hit.point.x, hit.point.y, hit.point.z], hit.face, dims)

    if (drag) {
      dragOver({ face: hit.face, u: here.u, v: here.v })
      return
    }
    if (!grab) return

    const placement = placements.find((p) => p.id === grab.id)
    // A drag that has wandered onto another face does nothing rather than
    // teleporting the picture round the corner: a decal belongs to the face it
    // was dropped on, and moving it to another one is a new drop.
    if (!placement || placement.face !== hit.face) return
    const image = preset.slots.find((held) => held?.id === placement.imageId)
    if (!image) return

    if (grab.mode === 'move') {
      const centred = clampCentre(here.u, here.v, placement.w, placement.h, hit.face, dims)
      movePlacement(placement.id, centred.u, centred.v)
      return
    }

    // The corner in hand follows the pointer, the one opposite it stays nailed
    // down, and the picture keeps its own shape throughout. All of that is
    // arithmetic, so all of it is next door where a check can hold it to
    // account -- see `resizeFromCorner`.
    sizePlacement(
      placement.id,
      resizeFromCorner(placement, grab.corner, here, aspectOf(image), dims)
    )
  }

  return { onPointerMove }
}

/**
 * What is drawn ON the block for each reference: an outline, and -- with Move
 * in hand -- four corners to pull.
 *
 * Deliberately quiet. The picture is the thing being looked at, and a drawing
 * surrounded by furniture is harder to follow than one with a hairline round
 * it. Which is the other half of why the handles belong to a tool: most of the
 * time they are not there at all.
 */
export function ReferenceHandles() {
  const dims = useBlockDims()
  const decals = useVisibleDecals()
  const drag = useReference((s) => s.drag)
  const grab = useReference((s) => s.grab)
  const preset = useReference(activePreset)
  const dropDrag = useReference((s) => s.dropDrag)
  const cancelDrag = useReference((s) => s.cancelDrag)
  const endGrab = useReference((s) => s.endGrab)

  // A press that ends ANYWHERE ends the gesture. Without this a drag released
  // off the block leaves the picture stuck to the pointer for ever, which is
  // the bug every drag-and-drop has had at least once.
  useEffect(() => {
    if (!drag && !grab) return
    const done = () => {
      if (grab) endGrab()
      if (!drag) return
      const image = preset.slots.find((held) => held?.id === drag.imageId)
      if (!image || !drag.at) {
        cancelDrag()
        return
      }
      dropDrag(dropSize(drag.at.face, dims, aspectOf(image)))
    }
    window.addEventListener('pointerup', done)
    window.addEventListener('pointercancel', done)
    return () => {
      window.removeEventListener('pointerup', done)
      window.removeEventListener('pointercancel', done)
    }
  }, [drag, grab, preset, dims, dropDrag, cancelDrag, endGrab])

  return (
    <>
      <DecalGhosts />
      {decals.map(({ placement }) => (
        <DecalHandles key={placement.id} placement={placement} dims={dims} />
      ))}
      <DropGhost dims={dims} />
    </>
  )
}

/**
 * The half of each picture that has nothing under it any more.
 *
 * WHY A DRAWING IS NO LONGER EATEN BY A CUT. The picture is painted by the
 * block's own material, so it can only be where the block is -- and a cut made
 * from another axis takes the whole face away, drawing and all, which left
 * somebody who had just squared a reference up on the front face with nothing
 * to cut the rest of it by. A reference is not part of the piece: it is the
 * thing you are working FROM, so taking the material away must not take it
 * away.
 *
 * So every placement also gets its picture as a quad, on its own plane, exactly
 * where it was put -- and sunk a hair into the block so that the block hides it
 * wherever the block still exists. See `SINK`. What you get is one continuous
 * drawing: on the surface where there is a surface, hanging in the air where
 * the laser has been, at the one Opacity the panel sets for all of them.
 *
 * IT IS NEVER IN THE WAY. It does not take a pointer, it writes no depth, and
 * it faces outward only, so a face turned away shows nothing and a press aimed
 * at the block reaches the block.
 */
function DecalGhosts() {
  const dims = useBlockDims()
  const decals = useVisibleDecals()
  const textures = useSlotTextures()
  const opacity = useReference((s) => s.opacity)

  return (
    <>
      {decals.map(({ placement, slot }) => (
        <DecalGhost
          key={placement.id}
          placement={placement}
          dims={dims}
          texture={textures[slot]}
          opacity={opacity}
        />
      ))}
    </>
  )
}

function DecalGhost({
  placement,
  dims,
  texture,
  opacity,
}: {
  placement: Placement
  dims: BlockDims
  texture: Texture | null
  opacity: number
}) {
  const rect = placementRect(placement, dims)

  // Built from the face's own axes, for the reason `FacePlane` is: no ordering
  // of Euler angles is right for all six faces.
  const quaternion = useMemo(
    () =>
      new Quaternion().setFromRotationMatrix(
        new Matrix4().makeBasis(
          new Vector3(...rect.u),
          new Vector3(...rect.v),
          new Vector3(...rect.normal)
        )
      ),
    [rect.u, rect.v, rect.normal]
  )

  if (!texture) return null

  return (
    <mesh
      geometry={GHOST_QUAD}
      raycast={noRaycast}
      quaternion={quaternion}
      position={[
        rect.centre[0] - rect.normal[0] * SINK,
        rect.centre[1] - rect.normal[1] * SINK,
        rect.centre[2] - rect.normal[2] * SINK,
      ]}
      scale={[rect.w, rect.h, 1]}
    >
      <meshBasicMaterial
        map={texture}
        transparent
        opacity={opacity}
        // FRONT ONLY, so the picture is not readable back to front through a
        // hole the laser has just cut in the face behind it.
        side={FrontSide}
        // A picture in mid-air must not stop anything behind it being drawn:
        // it is read against whatever is back there, block or room.
        depthWrite={false}
      />
    </mesh>
  )
}

/** The outline that follows a drag out of the panel, before it has landed. */
function DropGhost({ dims }: { dims: BlockDims }) {
  const drag = useReference((s) => s.drag)
  const preset = useReference(activePreset)
  const colors = useSceneColors()

  const at = drag?.at ?? null
  const image = drag ? preset.slots.find((held) => held?.id === drag.imageId) ?? null : null

  const rect = useMemo(() => {
    if (!at || !image) return null
    const size = dropSize(at.face, dims, aspectOf(image))
    const centred = clampCentre(at.u, at.v, size.w, size.h, at.face, dims)
    return placementRect(
      {
        id: 'ghost',
        presetId: '',
        imageId: image.id,
        face: at.face,
        u: centred.u,
        v: centred.v,
        w: size.w,
        h: size.h,
      },
      dims
    )
  }, [at, image, dims])

  return rect ? <RectOutline rect={rect} color={colors.accent} dashed /> : null
}

function DecalHandles({ placement, dims }: { placement: Placement; dims: BlockDims }) {
  const colors = useSceneColors()
  const startGrab = useReference((s) => s.startGrab)
  const grabbed = useReference((s) => s.grab?.id === placement.id)
  /**
   * WITHOUT MOVE IN HAND THE PICTURE IS ONLY A PICTURE.
   *
   * The whole point of a reference is that the line is drawn ALONG it -- so
   * with a cutter in hand, every handle here would be a hole in the face where
   * the cut cannot be started. The outline stays, because it says where the
   * picture ends; the grab surface and the four corners exist only while the
   * tool that uses them is held.
   *
   * Which is the whole of the old padlock's job, done by a tool instead: you
   * cannot shove a reference you are not holding, so there is nothing left to
   * pin it against.
   */
  const moving = useTools((s) => s.laserTool === 'move')
  /**
   * AND ONLY THE LIT ONE, which is the other half of the same rule.
   *
   * Move in hand used to arm every decal on the block at once, so a face
   * wearing three drawings was a face wearing twelve grips and no way to say
   * which picture you meant. The panel says which: light a slot and that
   * picture -- on every face it is on -- is the one with handles on it, and the
   * one Delete acts on. See `highlightId`.
   */
  const lit = useReference((s) => s.highlightId === placement.imageId)
  const armed = moving && lit

  const rect = placementRect(placement, dims)
  const grip = Math.max(GRIP_FLOOR, Math.min(rect.w, rect.h) * GRIP_SHARE)

  const frame: Frame = useMemo(
    () => ({
      u: new Vector3(...rect.u),
      v: new Vector3(...rect.v),
      normal: new Vector3(...rect.normal),
    }),
    [rect.u, rect.v, rect.normal]
  )

  /** A point on the face, in fractions of the decal's own half-width. */
  const at = (su: number, sv: number, lift = LIFT) =>
    new Vector3(
      rect.centre[0] + (rect.u[0] * su * rect.w) / 2 + (rect.v[0] * sv * rect.h) / 2 + rect.normal[0] * lift,
      rect.centre[1] + (rect.u[1] * su * rect.w) / 2 + (rect.v[1] * sv * rect.h) / 2 + rect.normal[1] * lift,
      rect.centre[2] + (rect.u[2] * su * rect.w) / 2 + (rect.v[2] * sv * rect.h) / 2 + rect.normal[2] * lift
    )

  return (
    <group>
      {/* Lit in the accent while its slot is: on a face you have turned away
          from, and with no tool in hand, the outline is the only thing saying
          which picture Delete would take off. */}
      <RectOutline rect={rect} color={grabbed || lit ? colors.accent : colors.edgeIdle} />

      {/* The whole picture is a grab surface while Move is in hand and its slot
          is lit. Invisible, and no bigger than the picture: it must not take a
          press meant for the block anywhere else. */}
      {armed && (
        <FacePlane
          frame={frame}
          position={at(0, 0)}
          width={rect.w}
          height={rect.h}
          onPointerDown={(e) => {
            // Left button only, the rule the cut layer already follows: the
            // right button pans the camera on this screen, and a right-drag
            // that began over a picture would slide the view and the picture
            // at once. See `PanAcrossFace`.
            if (e.button !== 0) return
            e.stopPropagation()
            startGrab({ id: placement.id, mode: 'move' })
          }}
        />
      )}

      {/* All four corners, and each anchors the one across from it.

          A HAIR IN FRONT of the grab surface, and that is not decoration: a
          grip sits ON the picture, so the two overlap by a quarter of the
          grip's width, and a raycast that finds them at the same distance
          picks by array order rather than by what the user was pointing at.
          Standing them off further makes the corner win every time, which is
          what a press on a corner means. */}
      {armed &&
        CORNERS.map((corner) => (
          <FacePlane
            key={`${corner.su}${corner.sv}`}
            frame={frame}
            position={at(corner.su, corner.sv, LIFT * 2)}
            width={grip}
            height={grip}
            color={colors.accent}
            visible
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              startGrab({ id: placement.id, mode: 'size', corner })
            }}
          />
        ))}
    </group>
  )
}

/** A rectangle drawn on the face, a hair proud of it. */
function RectOutline({
  rect,
  color,
  opacity = 1,
  dashed = false,
}: {
  rect: DecalRect
  color: string
  opacity?: number
  dashed?: boolean
}) {
  const points = useMemo(
    () =>
      [...rect.corners, rect.corners[0]].map(
        (c) =>
          [
            c[0] + rect.normal[0] * LIFT,
            c[1] + rect.normal[1] * LIFT,
            c[2] + rect.normal[2] * LIFT,
          ] as [number, number, number]
      ),
    [rect]
  )
  return (
    <Line
      points={points}
      color={color}
      lineWidth={1}
      transparent
      opacity={opacity}
      dashed={dashed}
      dashSize={0.01}
      gapSize={0.008}
    />
  )
}

/** A little square lying flat on the face: visible or not, and always pressable. */
function FacePlane({
  frame,
  position,
  width,
  height,
  color,
  visible = false,
  onPointerDown,
}: {
  frame: Frame
  position: Vector3
  width: number
  height: number
  color?: string
  visible?: boolean
  onPointerDown: (e: ThreeEvent<PointerEvent>) => void
}) {
  // Built from the face's own axes rather than from Euler angles: there is no
  // ordering of angles that is right for all six faces, and three of them come
  // out upside down.
  const quaternion = useMemo(
    () =>
      new Quaternion().setFromRotationMatrix(
        new Matrix4().makeBasis(frame.u, frame.v, frame.normal)
      ),
    [frame]
  )

  return (
    <mesh position={position} quaternion={quaternion} onPointerDown={onPointerDown}>
      <planeGeometry args={[width, height]} />
      <meshBasicMaterial
        color={color ?? '#ffffff'}
        transparent
        opacity={visible ? 1 : 0}
        depthWrite={false}
        // An invisible grab surface still has to be RAYCAST, so it is drawn
        // with no colour rather than switched off: `visible={false}` takes an
        // object out of the raycaster along with the picture.
        colorWrite={visible}
        toneMapped={false}
      />
    </mesh>
  )
}
