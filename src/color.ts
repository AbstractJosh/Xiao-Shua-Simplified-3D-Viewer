/**
 * Colour arithmetic: sRGB hex in, HSV out, and back.
 *
 * At the top level beside `appInfo` rather than inside `console/`, for the same
 * reason that one is: more than one folder needs it. The picker is why it
 * exists, but the viewport lifts a selected solid's colour with `lighten` from
 * here -- doing that with three's `Color.lerp` instead blends in LINEAR space,
 * which at any lift worth seeing washes a saturated solid out to pastel rather
 * than brightening it.
 *
 * The picker is a ring and a bar, which is to say it is HSV with the axes split
 * one-and-one-and-typed: the ring carries hue round it, the bar carries value,
 * and saturation has no control of its own -- the hex field is the way to reach
 * it. A ring is the whole reason this is not three sliders: hue is an angle,
 * and a control that admits it is one is the only kind you can aim at a colour
 * rather than search for.
 *
 * Every number here is pure and every conversion round-trips, which is what
 * lets the check suite prove the knob sits where the colour says it does. The
 * CSS gradients that paint the two controls are generated from these same
 * functions rather than written out by hand, so the picture and the value it
 * reports cannot disagree.
 */

/** Hue in degrees 0..360, saturation and value 0..1. */
export type Hsv = { h: number; s: number; v: number }

export const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/** Degrees, wrapped into 0..360 -- negative angles included. */
export const wrapHue = (deg: number): number => ((deg % 360) + 360) % 360

function channelHex(n: number): string {
  return Math.round(clamp01(n) * 255)
    .toString(16)
    .padStart(2, '0')
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const hue = wrapHue(h) / 60
  const sat = clamp01(s)
  const val = clamp01(v)
  // The standard sextant walk. `k` is the distance round the wheel to each of
  // the three primaries' peaks, so one expression covers all six sextants
  // instead of a switch that has six chances to be typed wrong.
  const f = (n: number) => {
    const k = (n + hue) % 6
    return val - val * sat * Math.max(0, Math.min(k, 4 - k, 1))
  }
  return `#${channelHex(f(5))}${channelHex(f(3))}${channelHex(f(1))}`
}

/** Parses `#rgb` and `#rrggbb`. Null for anything else, so a stored value that
 *  is not a colour cannot silently become black. */
export function parseHex(hex: string): [number, number, number] | null {
  const body = hex.trim().replace(/^#/, '')
  const full =
    body.length === 3
      ? body
          .split('')
          .map((c) => c + c)
          .join('')
      : body
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  const n = parseInt(full, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export function hexToHsv(hex: string): Hsv | null {
  const rgb = parseHex(hex)
  if (!rgb) return null
  const [r, g, b] = rgb
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const span = max - min
  // A grey has no hue and a black has no saturation either. Reporting 0 for
  // both is the honest answer; the panel is what decides to keep the angle the
  // user last aimed at rather than snapping the marker to red -- see ColorPanel.
  const h =
    span === 0
      ? 0
      : max === r
        ? 60 * (((g - b) / span + 6) % 6)
        : max === g
          ? 60 * ((b - r) / span + 2)
          : 60 * ((r - g) / span + 4)
  return { h, s: max === 0 ? 0 : span / max, v: max }
}

/**
 * Which hue a point on the ring is aimed at, in the ring's own square: x and y
 * run 0..1 across it, with y DOWNWARD as the DOM measures it.
 *
 * The angle clockwise from twelve o'clock, matching `conic-gradient`'s own
 * convention so the value and the paint underneath it agree. Only the direction
 * is read, never the distance -- which is what makes the ring hollow rather
 * than a disc: there is nothing inside it to mean anything, so a drag that
 * wanders into the hole or off past the rim keeps reporting the hue it points
 * at instead of stalling or jumping.
 *
 * `null` for the exact centre alone, which is the one point with no direction:
 * `atan2(0, 0)` is 0, and a knob snapping to red as the pointer crosses the
 * middle is precisely where that would show.
 */
export function wheelHue(x: number, y: number): number | null {
  const dx = x * 2 - 1
  const dy = y * 2 - 1
  if (dx === 0 && dy === 0) return null
  return wrapHue((Math.atan2(dx, -dy) * 180) / Math.PI)
}

/**
 * The inverse: where the knob for this hue sits, 0..1 across the ring's square,
 * y downward.
 *
 * `radius` is how far out to place it as a fraction of the ring's outer radius,
 * so the caller decides -- the knob rides the middle of the band, which is a
 * number the panel derives from the band's own thickness rather than one this
 * file could guess.
 */
export function hueAt(h: number, radius: number): { x: number; y: number } {
  const a = (wrapHue(h) * Math.PI) / 180
  const r = clamp01(radius)
  return { x: (1 + r * Math.sin(a)) / 2, y: (1 - r * Math.cos(a)) / 2 }
}

/** Stops every 30 degrees round the rim. Six would be enough for a browser
 *  interpolating in sRGB, but the extra ones cost nothing and keep the
 *  in-between hues where the arithmetic says they are. */
export const HUE_STOP_STEP = 30

export function hueWheelGradient(): string {
  const stops: string[] = []
  for (let h = 0; h <= 360; h += HUE_STOP_STEP) {
    stops.push(`${hsvToHex({ h, s: 1, v: 1 })} ${h}deg`)
  }
  return `conic-gradient(from 0deg, ${stops.join(', ')})`
}

/**
 * The brightness bar, painted top-down: the colour at full value at the top,
 * black at the bottom. Upright and bright-at-the-top because that is the way a
 * brightness slider reads -- higher is more.
 */
export function valueBarGradient(h: number, s: number): string {
  return `linear-gradient(to bottom, ${hsvToHex({ h, s, v: 1 })}, #000000)`
}

/**
 * The same colour, brighter: each sRGB channel moved `amount` of the way to
 * full.
 *
 * In sRGB deliberately. The obvious alternative -- three's `Color.lerp` -- runs
 * in the linear space three keeps its colours in, where the same fraction is a
 * far larger perceptual step at the dark end than at the light one, so a
 * saturated solid lifted enough to read as highlighted comes back noticeably
 * washed out. Straight sRGB blending keeps the hue and most of the strength and
 * only raises the brightness, which is the whole of what a highlight wants.
 *
 * A colour this cannot parse is handed back untouched: a highlight is not worth
 * turning a solid black over.
 */
export function lighten(hex: string, amount: number): string {
  const rgb = parseHex(hex)
  if (!rgb) return hex
  const t = clamp01(amount)
  return `#${rgb.map((c) => channelHex(c + (1 - c) * t)).join('')}`
}
