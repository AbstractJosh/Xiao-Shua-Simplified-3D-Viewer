import { useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { Hsv } from '../color'
import {
  clamp01,
  hexToHsv,
  hsvToHex,
  hueAt,
  hueWheelGradient,
  valueBarGradient,
  wheelHue,
  wrapHue,
} from '../color'
import { useDoc } from '../store/docStore'
import { RECENT_COLOR_SLOTS, useTools } from '../store/toolStore'
import { Section } from './Field'

/**
 * Colour, on the View tab under Shapes.
 *
 * It sits with the palettes rather than in Edit, beside the other controls that
 * only wake up once something is selected, for a reason that is about the
 * gesture rather than about the data: the two panels above it are the ones you
 * come to the View tab to use, and choosing a colour is the same kind of act --
 * you reach for a swatch, not for a field on the thing you have selected. Apply
 * is what ties it back to the selection, and it is the only part of this panel
 * that reaches outside it.
 *
 * Four controls, in the order you use them: a hue ring, a brightness slider
 * beside it, Apply, and under Apply the hex the other three add up to -- which
 * is also a field, so a colour that has to be exact can be typed instead of
 * hunted for. Under that, the colours already applied in this session.
 *
 * The ring is HOLLOW because it carries one axis. Hue is the angle, nothing is
 * the distance, and a filled disc would be promising a second axis it does not
 * have. Saturation is reachable through the hex field, and the ring preserves
 * whatever it finds there -- see `RING_FALLBACK_SATURATION`.
 */

/** What the picker opens on, read back as a colour from its hex. */
const DEFAULT_HSV: Hsv = hexToHsv('#ff0000') ?? { h: 0, s: 1, v: 1 }

/** One arrow key's worth, in each control's own units. */
const HUE_STEP = 6
const UNIT_STEP = 0.04

/**
 * Where the knob rides, as a fraction of the ring's outer radius: the middle of
 * the coloured band.
 *
 * A band running inward from the rim by its own thickness `t` has its midline
 * at `R - t/2`, which as a fraction of `R` is `1 - t/(2R)` -- and `2R` is the
 * ring's width, so this is one minus the thickness over the width. MIRRORED IN
 * `.picker-ring` in styles.css, which owns those two lengths and cannot hand a
 * number back to TypeScript: change one, change both.
 */
const RING_MID = 1 - 24 / 132

/**
 * The saturation a drag on the ring lands on when the colour it started from
 * has none.
 *
 * The ring keeps the saturation it finds, so a muted colour typed into the hex
 * field can still have its hue steered without being blown back to full. The
 * exception is a colour with no saturation at all -- a grey, a black, a white.
 * Those have no hue to steer either, so preserving their saturation would mean
 * a ring that visibly does nothing; they come back at full strength instead.
 */
const RING_FALLBACK_SATURATION = 1

/** Painted once: the gradient is a constant, and rebuilding thirteen stops on
 *  every drag frame would be work for a string that never changes. */
const RING_GRADIENT = hueWheelGradient()

/**
 * Take a colour on, keeping what the new one cannot say.
 *
 * A grey reports hue 0 because it has no hue, and a black reports no saturation
 * either. Adopting those literally would swing the knob round to red the moment
 * a grey object was selected or `#000000` was typed, so the axes a colour is
 * silent about keep the value already on screen. The colour itself is unchanged
 * -- `hsvToHex` of the result is the colour that came in -- only the position
 * the controls rest at is remembered.
 */
function adopt(prev: Hsv, next: Hsv): Hsv {
  return {
    h: next.s === 0 ? prev.h : next.h,
    s: next.v === 0 ? prev.s : next.s,
    v: next.v,
  }
}

/**
 * A press-and-drag over a box, reported as 0..1 within it.
 *
 * Pointer capture rather than window listeners: the ring is small and a hue is
 * chosen by sweeping around it, which means most of a real gesture happens off
 * the band it started on -- inside the hole, outside the rim, or past the end
 * of the slider. Capture keeps the events coming without a subscription to tear
 * down, and the pointer never has to stay on target.
 */
function useTrack(onMove: (x: number, y: number) => void) {
  const ref = useRef<HTMLDivElement>(null)

  const report = (e: ReactPointerEvent) => {
    const box = ref.current?.getBoundingClientRect()
    if (!box || box.width === 0 || box.height === 0) return
    onMove((e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height)
  }

  return {
    ref,
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      // The console is a scroll container and these are drag targets inside it;
      // without this a sweep across the ring selects the text around it.
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      report(e)
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      // Capture means this element hears every move, held or not.
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      report(e)
    },
  }
}

export function ColorPanel() {
  const selectedIds = useDoc((s) => s.selectedObjectIds)
  const objects = useDoc((s) => s.doc.objects)
  const setObjectColor = useDoc((s) => s.setObjectColor)
  const recentColors = useTools((s) => s.recentColors)
  const noteRecentColor = useTools((s) => s.noteRecentColor)

  const [hsv, setHsv] = useState<Hsv>(DEFAULT_HSV)
  /**
   * What is in the hex field while it is being typed in, or null when the field
   * is simply showing the colour.
   *
   * A draft is unavoidable: `#3f` is three keystrokes into a valid colour and
   * no colour at all, and a field bound straight to the parsed value would
   * either refuse the keystroke or blank itself halfway through. The draft
   * holds the text, the colour follows only the parses that succeed, and
   * leaving the field drops it so the row goes back to canonical `#rrggbb`.
   */
  const [draft, setDraft] = useState<string | null>(null)

  const primaryId = selectedIds[0] ?? null
  const count = selectedIds.length

  /**
   * The picker follows the SELECTION, not the selection's colour.
   *
   * Seeding on every colour change instead would fight the user twice: an Apply
   * would bounce the knob to wherever the 8-bit round trip landed, and a colour
   * typed into the hex field would be overwritten by the object it was about to
   * be applied to. Keyed off the id, the panel re-seeds when you point it at
   * something else and holds still the rest of the time.
   *
   * Adjusted DURING render rather than in an effect, which is React's own
   * advice for state that has to follow a value from outside: the first paint
   * after a click already shows the colour of the thing that was clicked, where
   * an effect would render the previous object's colour and correct it a frame
   * later -- a visible flick of the knob, on the one control whose whole job is
   * to say what colour something is.
   */
  const [seeded, setSeeded] = useState<string | null>(null)
  if (primaryId !== seeded) {
    setSeeded(primaryId)
    // A half-typed hex belonged to the object that was selected while it was
    // being typed. Pointing the panel somewhere else abandons it.
    setDraft(null)
    const color = objects.find((o) => o.id === primaryId)?.color
    const next = color === undefined ? null : hexToHsv(color)
    if (next) setHsv((prev) => adopt(prev, next))
  }

  /** Take a colour on from outside the ring: the hex field, a recent swatch. */
  const take = (color: string) => {
    const next = hexToHsv(color)
    if (next) setHsv((prev) => adopt(prev, next))
  }

  const fromRing = (h: number) =>
    setHsv((prev) => ({
      ...prev,
      h,
      s: prev.s === 0 ? RING_FALLBACK_SATURATION : prev.s,
    }))

  const ring = useTrack((x, y) => {
    const h = wheelHue(x, y)
    if (h !== null) fromRing(h)
  })
  // Upright, and bright at the top: `v` is one minus the distance down.
  const bar = useTrack((_x, y) => setHsv((prev) => ({ ...prev, v: clamp01(1 - y) })))

  const hex = hsvToHex(hsv)
  const knob = hueAt(hsv.h, RING_MID)

  const onRingKey = (e: ReactKeyboardEvent) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowUp'
        ? HUE_STEP
        : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
          ? -HUE_STEP
          : 0
    if (step === 0) return
    e.preventDefault()
    fromRing(wrapHue(hsv.h + step))
  }

  const onBarKey = (e: ReactKeyboardEvent) => {
    const step = e.key === 'ArrowUp' ? UNIT_STEP : e.key === 'ArrowDown' ? -UNIT_STEP : 0
    if (step === 0) return
    e.preventDefault()
    setHsv((prev) => ({ ...prev, v: clamp01(prev.v + step) }))
  }

  const apply = () => {
    setObjectColor(selectedIds, hex)
    // Only what was actually applied goes on the shelf. Every colour the ring
    // sweeps past on the way to one would otherwise fill all eight slots in a
    // single gesture and bury whatever was there.
    noteRecentColor(hex)
  }

  // Fixed slots, filled from the front, so the panel keeps its height from the
  // first colour applied to the eighth.
  const slots = Array.from({ length: RECENT_COLOR_SLOTS }, (_, i) => recentColors[i] ?? null)

  return (
    <Section
      title="Colour"
      hint={count > 1 ? `${count} selected` : undefined}
      tip="Turn the ring for the hue and the slider beside it for brightness, or type an exact colour into the hex field. Apply paints whatever is selected and nothing else, and puts the colour on the shelf below for next time."
    >
      <div className="picker">
        <div
          {...ring}
          className="picker-ring"
          style={{ background: RING_GRADIENT }}
          role="application"
          aria-label={`Hue, ${Math.round(hsv.h)} degrees`}
          tabIndex={0}
          onKeyDown={onRingKey}
        >
          {/* The hollow: a disc of the panel's own colour punched through the
              band, rather than a CSS mask. The band is a background, already
              clipped to its rounded border box, so the middle only needs
              something opaque over it. */}
          <div className="picker-ring-hole" aria-hidden />
          <div
            className="picker-knob"
            style={{ left: `${knob.x * 100}%`, top: `${knob.y * 100}%`, background: hex }}
            aria-hidden
          />
        </div>

        <div
          {...bar}
          className="picker-bar"
          style={{ background: valueBarGradient(hsv.h, hsv.s) }}
          role="slider"
          aria-label="Brightness"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(hsv.v * 100)}
          tabIndex={0}
          onKeyDown={onBarKey}
        >
          {/* A bar across the slider rather than a dot on it: the track is
              narrow and upright, so the thing that says "here" wants to span it
              the way a fader's does. */}
          <div
            className="picker-thumb"
            style={{ top: `${(1 - clamp01(hsv.v)) * 100}%` }}
            aria-hidden
          />
        </div>

        <div className="picker-side">
          <button
            type="button"
            className="nav-action nav-action-primary picker-apply"
            disabled={count === 0}
            // The count rides the label for the same reason Apply cut's does:
            // this is the one control here that reaches out of the panel, and
            // how many solids it is about to repaint is the part worth reading.
            title={
              count === 0
                ? 'Select an object first -- colour only ever applies to the selection'
                : `Paints the selected object${count === 1 ? '' : 's'} ${hex}`
            }
            onClick={apply}
          >
            {count > 1 ? `Apply to ${count}` : 'Apply'}
          </button>

          <div className="picker-hex">
            <span className="picker-swatch" style={{ background: hex }} aria-hidden />
            <input
              className="picker-hex-input"
              type="text"
              value={draft ?? hex}
              spellCheck={false}
              autoComplete="off"
              aria-label="Hex colour"
              // A hash and six digits. A paste of anything longer is trimmed
              // here rather than left as an unreadable tail in the field.
              maxLength={7}
              onChange={(e) => {
                setDraft(e.target.value)
                // Every keystroke that spells a colour moves the ring and the
                // slider with it; the ones that do not are simply held in the
                // draft until they do. Typing is a path through invalid text,
                // not a mistake to reject.
                take(e.target.value)
              }}
              // The draft has served its purpose the moment the field is left.
              // Dropping it re-renders whatever the colour actually is, in
              // canonical form, so `#ABC` comes back as `#aabbcc`.
              onBlur={() => setDraft(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
          </div>

          {/* Not a second Apply. Clicking one loads it into the ring, the
              slider and the field, and Apply is still the thing that paints:
              this panel has exactly one control that changes the document, and
              a grid of eight one-click repaints beside it would be eight more. */}
          <div className="picker-recent" role="group" aria-label="Recently used colours">
            {slots.map((color, i) => (
              <button
                key={i}
                type="button"
                className={`picker-slot${color ? '' : ' picker-slot-empty'}`}
                style={color ? { background: color } : undefined}
                disabled={color === null}
                title={color ? `Load ${color}` : 'Empty -- colours land here as you apply them'}
                aria-label={color ? `Load ${color}` : 'Empty slot'}
                onClick={() => {
                  if (!color) return
                  setDraft(null)
                  take(color)
                }}
              />
            ))}
          </div>
        </div>

        {count === 0 && (
          <p className="empty picker-empty">
            Nothing selected. Click an object -- or shift-click several -- and Apply paints
            those and nothing else.
          </p>
        )}
      </div>
    </Section>
  )
}
