import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { Vec2, Vec3 } from '../geometry/types'
import { SCRUB_SLOP, scrubbed } from './scrub'
import { Tip } from './Tip'

/**
 * The number box every field in the app is edited through: drag it sideways to
 * change the value, double-click it to type one.
 *
 * A slider finds roughly the right place and a keyboard settles an exact one,
 * and between them there was nothing -- the box was a place to type five
 * characters to move a solid by a twentieth of a unit. Dragging the number
 * itself is the missing middle: it is the slider's feel at the box's
 * resolution, in the same square of screen the value is already being read in,
 * which matters most in the viewport panel where a slider is 130 pixels long.
 *
 * THE THREE GESTURES ARE KEPT APART BY WHAT THEY COST. A drag past
 * `SCRUB_SLOP` changes the value; a press that never gets there changes
 * nothing at all; and typing is behind a double click, because a box that took
 * a caret on every press would be a box that swallowed the first drag of every
 * gesture. Focus is refused on the way in for the same reason -- `mousedown`'s
 * default is what focuses an input, and preventing it leaves click and double
 * click untouched.
 *
 * Tabbing in still opens it for typing: a keyboard has no drag to offer, so
 * focus arriving on its own is taken as the ask that a double click otherwise
 * makes.
 *
 * WHILE TYPING, THE BOX HOLDS TEXT RATHER THAN A NUMBER. An `input[type=number]`
 * reports "" for anything not yet a valid figure, and "2." on the way to "2.5"
 * is exactly that -- so a box driven straight from the parsed value would take
 * the decimal point, read zero, and rewrite what was typed. The draft is what
 * is shown for as long as the box is being typed into, and the number is
 * committed alongside it whenever the draft parses.
 */
function ScrubNumber({
  className,
  value,
  min,
  max,
  step,
  decimals,
  onChange,
}: {
  className: string
  value: number
  min: number
  max: number
  step: number
  decimals: number
  onChange: (v: number) => void
}) {
  const box = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  /** The press in progress: where it started, and what the value was then.
   *  A ref rather than state -- it changes on every pointer move and nothing
   *  drawn depends on it. */
  const press = useRef<{ x: number; from: number; live: boolean } | null>(null)
  /** What to put back if the typing is abandoned. */
  const before = useRef(value)

  useEffect(() => {
    if (!editing) return
    const node = box.current
    if (!node) return
    node.focus()
    node.select()
  }, [editing])

  const open = () => {
    if (editing) return
    before.current = value
    setDraft(String(Number(value.toFixed(decimals))))
    setEditing(true)
  }

  const down = (e: ReactPointerEvent<HTMLInputElement>) => {
    if (editing || e.button !== 0) return
    press.current = { x: e.clientX, from: value, live: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const move = (e: ReactPointerEvent<HTMLInputElement>) => {
    const held = press.current
    if (!held) return
    const dx = e.clientX - held.x
    if (!held.live && Math.abs(dx) < SCRUB_SLOP) return
    held.live = true
    onChange(scrubbed(held.from, dx, min, max, step))
  }

  const up = (e: ReactPointerEvent<HTMLInputElement>) => {
    if (!press.current) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    press.current = null
  }

  return (
    <input
      ref={box}
      className={className}
      type="number"
      min={min}
      max={max}
      step={step}
      value={editing ? draft : Number(value.toFixed(decimals))}
      readOnly={!editing}
      // Not `onPointerDown`: preventing a pointerdown's default is allowed to
      // take the click and the double click with it, and those are the other
      // two gestures this box answers. A mousedown's default is only the focus.
      onMouseDown={(e) => {
        if (!editing) e.preventDefault()
      }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={open}
      onFocus={open}
      onChange={(e) => {
        const text = e.target.value
        setDraft(text)
        const v = Number(text)
        if (text !== '' && Number.isFinite(v)) {
          onChange(Math.min(max, Math.max(min, v)))
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') {
          onChange(before.current)
          e.currentTarget.blur()
        }
      }}
      onBlur={() => setEditing(false)}
      title="Drag to change, double-click to type"
    />
  )
}

type NumberFieldProps = {
  label: string
  value: number
  min: number
  max: number
  step?: number
  decimals?: number
  /** A caveat about this control, shown on hover rather than under it. */
  tip?: ReactNode
  /** Shows a reset control beside the label. Omitted leaves the field as it was. */
  resetTo?: number
  onChange: (v: number) => void
}

/** Slider for feel, number box for precision -- the plan's "drag plus panel". */
export function NumberField({
  label,
  value,
  min,
  max,
  step = 0.01,
  decimals = 2,
  tip,
  resetTo,
  onChange,
}: NumberFieldProps) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  return (
    <div className="field">
      <div className="field-head">
        <span className="field-label">{label}</span>
        {tip && <Tip>{tip}</Tip>}
        {resetTo !== undefined && (
          <ResetButton
            label={`Reset ${label.toLowerCase()}`}
            disabled={Math.abs(value - resetTo) <= RESET_EPS}
            onClick={() => onChange(resetTo)}
          />
        )}
        <ScrubNumber
          className="field-num"
          value={value}
          min={min}
          max={max}
          step={step}
          decimals={decimals}
          onChange={(v) => onChange(clamp(v))}
        />
      </div>
      <input
        className="field-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
      />
    </div>
  )
}

export function Section({
  title,
  children,
  hint,
  tip,
  collapsible = false,
  defaultOpen = true,
  right,
}: {
  title: string
  /**
   * A short VALUE beside the title -- a count, the solid's name, which face a
   * sketch sits on. Prose belongs in `tip`, where it costs no vertical space.
   */
  hint?: string
  tip?: React.ReactNode
  children: React.ReactNode
  collapsible?: boolean
  defaultOpen?: boolean
  right?: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  // Collapsed state is local, so a section that later loses `collapsible` can
  // never stay stuck shut behind a flag nobody can reach any more.
  const shown = collapsible ? open : true

  return (
    <section className="section">
      <h2 className="section-title">
        {collapsible ? (
          <button
            type="button"
            className="collapse-btn"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {/* Caret points right at rest and is rotated by CSS off aria-expanded,
                so the open state lives in exactly one place. */}
            <svg className="collapse-caret" viewBox="0 0 10 10" aria-hidden>
              <path
                d="M3.2 1.6 L6.8 5 L3.2 8.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {title}
          </button>
        ) : (
          title
        )}
        {tip && <Tip>{tip}</Tip>}
        {hint && <span className="section-hint">{hint}</span>}
        {right && <span className="section-right">{right}</span>}
      </h2>
      {shown && children}
    </section>
  )
}

const clampTo = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v))

/**
 * Below this an axis counts as already reset, and its button stands down.
 *
 * A live button that does nothing is worse than no button: it invites a click
 * that costs an undo entry and changes nothing. Loose enough to catch a value
 * a drag left at 1e-17 rather than exactly zero.
 */
const RESET_EPS = 1e-9

/**
 * Send one value, or a whole rotation, back to where it started.
 *
 * Its own control rather than a number to type because zero is the value people
 * want most often and the hardest to hit by dragging -- and because a rotation
 * built by the gizmo's ring lands on Euler triples like (pi, 0, pi) that are a
 * chore to undo a row at a time.
 */
function ResetButton({
  label,
  disabled,
  onClick,
}: {
  label: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="reset-btn"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <svg viewBox="0 0 12 12" aria-hidden>
        <path
          d="M8.31 3.24 A3.6 3.6 0 1 1 3.69 3.24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
        <path
          d="M1.9 3.4 L3.69 3.24 L3.23 4.98"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

/** One dense axis row: tinted letter, slider, number box. */
function AxisRow({
  axis,
  tint,
  value,
  min,
  max,
  step,
  decimals,
  resetTo,
  onChange,
}: {
  axis: string
  tint: 'x' | 'y' | 'z'
  value: number
  min: number
  max: number
  step: number
  decimals: number
  /** Shows a reset control for this axis alone. Omitted leaves the row as it was. */
  resetTo?: number
  onChange: (v: number) => void
}) {
  return (
    <div className={`vec3-row${resetTo === undefined ? '' : ' vec3-row-resettable'}`}>
      <span className={`vec3-axis vec3-axis-${tint}`}>{axis}</span>
      <input
        className="field-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(clampTo(Number(e.target.value), min, max))}
      />
      <ScrubNumber
        className="vec3-input"
        value={value}
        min={min}
        max={max}
        step={step}
        decimals={decimals}
        onChange={(v) => onChange(clampTo(v, min, max))}
      />
      {resetTo !== undefined && (
        <ResetButton
          label={`Reset ${axis}`}
          disabled={Math.abs(value - resetTo) <= RESET_EPS}
          onClick={() => onChange(resetTo)}
        />
      )}
    </div>
  )
}

const TINTS = ['x', 'y', 'z'] as const

/**
 * Three axes under one label. With `degrees`, `value` and `onChange` speak
 * RADIANS while the rows show and edit DEGREES; `min`/`max`/`step` are read in
 * the unit on screen (degrees), because they describe the control, not the
 * stored number. Callers therefore never convert in either direction.
 */
export function Vec3Field({
  label,
  value,
  min,
  max,
  step,
  decimals,
  degrees = false,
  resetTo,
  onChange,
}: {
  label: string
  value: Vec3
  min: number
  max: number
  step?: number
  decimals?: number
  degrees?: boolean
  /**
   * Adds a reset control to every axis, and one on the heading that takes all
   * three at once. In the UNIT SHOWN, like min and max -- so a rotation field
   * asks for degrees here even though it stores radians.
   */
  resetTo?: number
  onChange: (v: Vec3) => void
}) {
  // Whole degrees are the useful granularity for a tilt; lengths need hundredths.
  const stepped = step ?? (degrees ? 1 : 0.01)
  const places = decimals ?? (degrees ? 0 : 2)
  const toUi = (v: number) => (degrees ? (v * 180) / Math.PI : v)
  const fromUi = (v: number) => (degrees ? (v * Math.PI) / 180 : v)

  const setAxis = (i: number, ui: number) => {
    const next: Vec3 = [value[0], value[1], value[2]]
    next[i] = fromUi(ui)
    onChange(next)
  }

  const atRest =
    resetTo !== undefined &&
    value.every((v) => Math.abs(toUi(v) - resetTo) <= RESET_EPS)

  return (
    <div className="vec3">
      <div className="subhead subhead-row">
        {label}
        {resetTo !== undefined && (
          <ResetButton
            label={`Reset ${label.toLowerCase()}`}
            disabled={atRest}
            onClick={() =>
              onChange([fromUi(resetTo), fromUi(resetTo), fromUi(resetTo)])
            }
          />
        )}
      </div>
      {TINTS.map((tint, i) => (
        <AxisRow
          key={tint}
          axis={tint.toUpperCase()}
          tint={tint}
          value={toUi(value[i])}
          min={min}
          max={max}
          step={stepped}
          decimals={places}
          resetTo={resetTo}
          onChange={(v) => setAxis(i, v)}
        />
      ))}
    </div>
  )
}

/**
 * Two in-plane axes, same row idiom as Vec3Field. The pair borrows the X and Y
 * tints on purpose: a lateral offset reads faster when its letters are coloured
 * by the same scheme as the 3D rows sitting above it in the panel.
 */
export function Vec2Field({
  label,
  labels = ['U', 'V'],
  value,
  min,
  max,
  step = 0.01,
  onChange,
}: {
  label: string
  labels?: [string, string]
  value: Vec2
  min: number
  max: number
  step?: number
  onChange: (v: Vec2) => void
}) {
  return (
    <div className="vec2">
      <div className="subhead">{label}</div>
      {labels.map((axis, i) => (
        <AxisRow
          key={i}
          axis={axis}
          tint={i === 0 ? 'x' : 'y'}
          value={value[i]}
          min={min}
          max={max}
          step={step}
          decimals={2}
          onChange={(v) =>
            onChange(i === 0 ? [v, value[1]] : [value[0], v])
          }
        />
      ))}
    </div>
  )
}
