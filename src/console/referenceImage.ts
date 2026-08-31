import type { Crop, RefEdit, RefImage } from '../store/referenceStore'

/**
 * Getting a picture in, and getting the edited version of it back out.
 *
 * TWO HALVES, and the split is the point. The arithmetic -- what size a picture
 * is after a turn, what part of it a crop keeps, which way round a flip puts it
 * -- is pure and sits at the top, where a headless check can walk every case.
 * The half that needs a browser -- reading a file, rasterising an SVG, drawing
 * the result on a canvas -- sits at the bottom and does no thinking.
 *
 * WHY THE EDIT IS NOT BAKED IN. Flip, turn and crop are kept beside the picture
 * and applied on the way out, so opening the editor a second time shows what
 * was set the first time and a crop can be widened again. Baking would make
 * every one of those a one-way door, and a reference drawing is exactly the
 * thing somebody re-crops after seeing it on the block.
 */

/**
 * The longest side a stored picture may have, in pixels.
 *
 * Two thousand and forty-eight: enough that a drawing fills a face without the
 * lines going soft, and small enough that three of them are megabytes rather
 * than tens of them. A bigger file is drawn down to this on the way in, which
 * is also what turns a 12-megapixel photograph of a sketch into something the
 * GPU will take without complaint.
 */
export const RASTER_MAX = 2048

/**
 * How big an SVG is rasterised when it declines to say how big it is.
 *
 * A vector has no natural pixel size, and a good many exports carry no width or
 * height at all -- only a viewBox. Something has to be picked, and it should be
 * big enough to enlarge on a face without going soft.
 */
export const SVG_FALLBACK = 1024

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml']
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.svg']

/**
 * Whether this is a file the panel takes.
 *
 * By type where the browser gives one and by extension where it does not: a
 * file dragged from some file managers arrives with an empty type, and refusing
 * a .png because the desktop forgot to say so is a rejection nobody can act on.
 */
export function isReferenceFile(file: { name: string; type: string }): boolean {
  if (IMAGE_TYPES.includes(file.type)) return true
  const name = file.name.toLowerCase()
  return !file.type && IMAGE_EXTENSIONS.some((ext) => name.endsWith(ext))
}

/** Whether an edit does anything at all, which is what the reset button reads. */
export function isEdited(edit: RefEdit): boolean {
  return edit.flipX || edit.flipY || edit.turns !== 0 || edit.crop !== null
}

/** The whole picture, as a crop. */
export const FULL_CROP: Crop = { x: 0, y: 0, w: 1, h: 1 }

/**
 * A crop with no side thinner than this, as a fraction.
 *
 * A crop can be dragged to nothing, and a picture of nothing cannot be got hold
 * of again to widen it -- so the drag stops here instead. Two per cent of the
 * picture is still a crop nobody wants and one they can undo.
 */
export const MIN_CROP = 0.02

/** A crop pulled back inside the picture, and never thinner than `MIN_CROP`. */
export function clampCrop(crop: Crop): Crop {
  const w = Math.min(1, Math.max(MIN_CROP, crop.w))
  const h = Math.min(1, Math.max(MIN_CROP, crop.h))
  return {
    w,
    h,
    x: Math.min(1 - w, Math.max(0, crop.x)),
    y: Math.min(1 - h, Math.max(0, crop.y)),
  }
}

/** Which corner of the crop is in hand, or the whole of it. */
export type CropHandle = 'nw' | 'ne' | 'se' | 'sw' | 'move'

/**
 * The shapes the editor will hold a crop to, as width:height of the PIXELS it
 * keeps.
 *
 * Pixels rather than fractions, which is the whole reason this is not simply a
 * number the crop is multiplied by: a crop is stored as a fraction of a picture
 * that has its own shape, so half by half of a 4000 x 3000 photograph is not a
 * square. Every ratio here is converted through `fractionRatio` before any
 * arithmetic touches a crop.
 *
 * FIVE, and the first one is Free. 1:1 is the one that was asked for and the
 * one that is genuinely hard to hit by hand -- a square eyeballed on a picture
 * of some other shape is never quite square -- and the other three are the
 * ratios drawings actually arrive in. Written as they are read, so 4:3 is four
 * wide by three high whatever way up the picture is.
 */
export const CROP_RATIOS: { label: string; ratio: number | null }[] = [
  { label: 'Free', ratio: null },
  { label: '1:1', ratio: 1 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '3:2', ratio: 3 / 2 },
  { label: '16:9', ratio: 16 / 9 },
]

/**
 * A pixel ratio, as the width-over-height a CROP has to have to hit it.
 *
 * The conversion the whole lock rests on. A crop of w by h fractions on a
 * picture of W by H pixels keeps w*W by h*H pixels, so the pixel ratio is
 * (w/h) * (W/H) -- and the fraction ratio that lands on a wanted R is
 * therefore R divided by the picture's own aspect. Done once, at the edge,
 * so that every function below stays in fraction space.
 */
export function fractionRatio(pixelRatio: number, shownAspect: number): number {
  return shownAspect > 0 ? pixelRatio / shownAspect : pixelRatio
}

/**
 * A crop reshaped to `ratio` (width over height, in fractions), about its own
 * centre.
 *
 * IT SHRINKS, never grows: the new rectangle fits inside the one you had, so
 * pressing 1:1 cannot quietly take back in something you had already cropped
 * out. Centred on what was there, because a crop is aimed before it is shaped
 * -- the middle is the part you meant.
 */
export function fitCrop(crop: Crop, ratio: number): Crop {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return crop
  // The widest this ratio can be and still fit the picture, and the narrowest
  // it can be and still be grabbable at both sides.
  const maxW = Math.min(1, ratio)
  const minW = Math.min(maxW, Math.max(MIN_CROP, MIN_CROP * ratio))
  const w = Math.min(maxW, Math.max(minW, Math.min(crop.w, crop.h * ratio)))
  const h = w / ratio
  const cx = crop.x + crop.w / 2
  const cy = crop.y + crop.h / 2
  return {
    w,
    h,
    x: Math.min(1 - w, Math.max(0, cx - w / 2)),
    y: Math.min(1 - h, Math.max(0, cy - h / 2)),
  }
}

/**
 * A crop with one corner dragged to (x, y), in fractions of the picture.
 *
 * The OPPOSITE corner is what stays put, which is the whole behaviour of a
 * corner handle: the rectangle is rebuilt from the two corners rather than the
 * dragged edge being nudged, so dragging past the far side flips the rectangle
 * through it instead of collapsing it to nothing.
 *
 * GIVEN A `ratio` IT IS HELD TO IT -- width over height, in fractions, from
 * `fractionRatio`. The corner then follows the pointer only as far as that
 * shape allows: whichever of the two directions has been pulled further sets
 * the size, and the other one is derived, so the drag still feels like a drag
 * rather than like one axis being ignored. The anchor never moves, and the
 * rectangle stops at the edge of the picture rather than going over it -- which
 * is why the room either side of the anchor is measured before anything else.
 */
export function resizeCrop(
  crop: Crop,
  handle: Exclude<CropHandle, 'move'>,
  x: number,
  y: number,
  ratio?: number | null
): Crop {
  const left = crop.x
  const top = crop.y
  const right = crop.x + crop.w
  const bottom = crop.y + crop.h
  const px = Math.min(1, Math.max(0, x))
  const py = Math.min(1, Math.max(0, y))

  const anchorX = handle === 'nw' || handle === 'sw' ? right : left
  const anchorY = handle === 'nw' || handle === 'ne' ? bottom : top

  if (!ratio || !(ratio > 0) || !Number.isFinite(ratio)) {
    return clampCrop({
      x: Math.min(anchorX, px),
      y: Math.min(anchorY, py),
      w: Math.abs(anchorX - px),
      h: Math.abs(anchorY - py),
    })
  }

  const toLeft = px < anchorX
  const toTop = py < anchorY
  // How much picture there is between the anchor and the edge the drag is
  // heading for. A ratio-locked rectangle is capped by whichever of the two
  // runs out first.
  const roomW = toLeft ? anchorX : 1 - anchorX
  const roomH = toTop ? anchorY : 1 - anchorY
  const maxW = Math.min(roomW, roomH * ratio)
  // A corner with no room in front of it -- the anchor is already on that edge
  // -- has nothing to drag out, so the crop stands still rather than collapsing.
  if (!(maxW > 0)) return crop

  const wanted = Math.max(Math.abs(px - anchorX), Math.abs(py - anchorY) * ratio)
  const w = Math.min(maxW, Math.max(Math.min(MIN_CROP, maxW), wanted))
  const h = w / ratio

  return {
    w,
    h,
    x: toLeft ? anchorX - w : anchorX,
    y: toTop ? anchorY - h : anchorY,
  }
}

/** A crop slid across the picture, never off the edge of it. */
export function moveCrop(crop: Crop, dx: number, dy: number): Crop {
  return {
    ...crop,
    x: Math.min(1 - crop.w, Math.max(0, crop.x + dx)),
    y: Math.min(1 - crop.h, Math.max(0, crop.y + dy)),
  }
}

/**
 * The size a picture is SHOWN at, in pixels, before its crop.
 *
 * A quarter turn swaps the sides; a flip does not touch them. Half turns are
 * two quarters, so they land back on the original way round.
 */
export function turnedSize(
  width: number,
  height: number,
  turns: number
): { width: number; height: number } {
  return ((turns % 2) + 2) % 2 === 1 ? { width: height, height: width } : { width, height }
}

/** The size the edited picture ends up, in pixels: turned, then cropped. */
export function editedSize(image: {
  width: number
  height: number
  edit: RefEdit
}): { width: number; height: number } {
  const turned = turnedSize(image.width, image.height, image.edit.turns)
  const crop = image.edit.crop ?? FULL_CROP
  return {
    width: Math.max(1, Math.round(turned.width * crop.w)),
    height: Math.max(1, Math.round(turned.height * crop.h)),
  }
}

/**
 * How wide the edited picture is against its height.
 *
 * The one number the block needs from all of this: a decal is laid on a face at
 * whatever size fits, and only its shape has to survive the trip.
 */
export function aspectOf(image: { width: number; height: number; edit: RefEdit }): number {
  const size = editedSize(image)
  return size.height > 0 ? size.width / size.height : 1
}

/** Where a picture's own name ends, for a tile that has to show it small. */
export function shortName(name: string, max = 22): string {
  if (name.length <= max) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot) : ''
  const stem = dot > 0 ? name.slice(0, dot) : name
  const room = Math.max(3, max - ext.length - 1)
  return `${stem.slice(0, room)}…${ext}`
}

/* -------------------------------------------------------------------------- *
 * The half that needs a browser.
 * -------------------------------------------------------------------------- */

/** The file's bytes as a data URL, which is what an `<img>` and a texture both take. */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read'))
    reader.readAsDataURL(file)
  })
}

/** An `<img>` that has finished loading, or a rejection saying it did not. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('The image could not be decoded'))
    img.src = src
  })
}

/** A canvas of this size, or a failure that says what could not be had. */
function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser would not give a 2D canvas')
  return { canvas, ctx }
}

/**
 * A picture read off disk and made ready to hold: decoded, measured, and drawn
 * down to `RASTER_MAX` if it arrived bigger.
 *
 * SVG IS RASTERISED HERE rather than kept as vector, and the trade is honest:
 * the crop, the flip and the turn all end up on a canvas, the decal ends up as
 * a texture, and a texture is pixels however it started. Rasterising once on
 * the way in means every later step is the same step for every format -- and
 * `SVG_FALLBACK` is generous enough that a drawing enlarged over a whole face
 * still holds its lines.
 */
export async function readReferenceFile(
  file: File
): Promise<{ name: string; src: string; width: number; height: number }> {
  const raw = await readAsDataUrl(file)
  const img = await loadImage(raw)

  // An SVG with no intrinsic size decodes to a zero- or default-sized image,
  // depending on the browser. Either way there is no size to trust, so one is
  // chosen and the vector is drawn into it.
  const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')
  const natural = {
    width: img.naturalWidth || (isSvg ? SVG_FALLBACK : 0),
    height: img.naturalHeight || (isSvg ? SVG_FALLBACK : 0),
  }
  if (!natural.width || !natural.height) throw new Error('That image has no size to read')

  const longest = Math.max(natural.width, natural.height)
  const scale = isSvg
    ? // A vector is drawn AT the size it will be held at rather than shrunk
      // afterwards, so enlarging it costs nothing in sharpness up to the cap.
      Math.min(RASTER_MAX / longest, longest < SVG_FALLBACK ? SVG_FALLBACK / longest : 1)
    : Math.min(1, RASTER_MAX / longest)

  if (!isSvg && scale === 1) {
    return { name: file.name, src: raw, width: natural.width, height: natural.height }
  }

  const width = Math.max(1, Math.round(natural.width * scale))
  const height = Math.max(1, Math.round(natural.height * scale))
  const { canvas, ctx } = canvasOf(width, height)
  ctx.drawImage(img, 0, 0, width, height)
  // PNG rather than JPEG whatever came in: a reference drawing is line work on
  // white or on nothing, and both of those are exactly what JPEG is worst at.
  return { name: file.name, src: canvas.toDataURL('image/png'), width, height }
}

/**
 * The picture as the editor left it: flipped, turned, then cropped.
 *
 * IN THAT ORDER, and the order is the contract the crop is stored under. The
 * crop is a rectangle on the picture as SHOWN -- which is what the user dragged
 * -- so it can only be applied once the flip and the turn have been done. Flip
 * and turn are one canvas transform between them; the crop is the source
 * rectangle taken out of the result.
 */
export async function drawEdited(image: RefImage): Promise<HTMLCanvasElement> {
  const img = await loadImage(image.src)
  const { edit } = image

  const turned = turnedSize(image.width, image.height, edit.turns)
  const stage = canvasOf(turned.width, turned.height)
  stage.ctx.save()
  stage.ctx.translate(turned.width / 2, turned.height / 2)
  // FLIP OUTSIDE THE TURN, which is the order the buttons promise: "flip
  // horizontal" mirrors what is on screen left-to-right, whatever the picture
  // has been turned to. Applied inside the turn instead, the same button
  // mirrors a quarter-turned picture top-to-bottom -- which is correct
  // arithmetic and a broken control. The editor's CSS transform composes the
  // same way round, so the preview is what this bakes.
  stage.ctx.scale(edit.flipX ? -1 : 1, edit.flipY ? -1 : 1)
  stage.ctx.rotate((edit.turns * Math.PI) / 2)
  stage.ctx.drawImage(img, -image.width / 2, -image.height / 2, image.width, image.height)
  stage.ctx.restore()

  if (!edit.crop) return stage.canvas

  const crop = clampCrop(edit.crop)
  const sx = crop.x * turned.width
  const sy = crop.y * turned.height
  const sw = Math.max(1, crop.w * turned.width)
  const sh = Math.max(1, crop.h * turned.height)
  const out = canvasOf(sw, sh)
  out.ctx.drawImage(stage.canvas, sx, sy, sw, sh, 0, 0, out.canvas.width, out.canvas.height)
  return out.canvas
}
