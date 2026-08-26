import { useState } from 'react'
import type { Vec2, Vec3 } from '../geometry/types'

type NumberFieldProps = {
  label: string
  value: number
  min: number
  max: number
  step?: number
  decimals?: number
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
  onChange,
}: NumberFieldProps) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  return (
    <div className="field">
      <div className="field-head">
        <span className="field-label">{label}</span>
        <input
          className="field-num"
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number(value.toFixed(decimals))}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v)) onChange(clamp(v))
          }}
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
  collapsible = false,
  defaultOpen = true,
  right,
}: {
  title: string
  hint?: string
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
        {hint && <span className="section-hint">{hint}</span>}
        {right && <span className="section-right">{right}</span>}
      </h2>
      {shown && children}
    </section>
  )
}

const clampTo = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v))

/** One dense axis row: tinted letter, slider, number box. */
function AxisRow({
  axis,
  tint,
  value,
  min,
  max,
  step,
  decimals,
  onChange,
}: {
  axis: string
  tint: 'x' | 'y' | 'z'
  value: number
  min: number
  max: number
  step: number
  decimals: number
  onChange: (v: number) => void
}) {
  return (
    <div className="vec3-row">
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
      <input
        className="vec3-input"
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number(value.toFixed(decimals))}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(clampTo(v, min, max))
        }}
      />
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
  onChange,
}: {
  label: string
  value: Vec3
  min: number
  max: number
  step?: number
  decimals?: number
  degrees?: boolean
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

  return (
    <div className="vec3">
      <div className="subhead">{label}</div>
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

/**
 * A switch, not a checkbox: these flip a live tool mode, and a sliding knob
 * reads as "on now" where a tick box reads as "will apply later".
 */
export function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string
  checked: boolean
  onChange: (b: boolean) => void
  hint?: string
}) {
  return (
    <button
      type="button"
      className="toggle"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span className={`toggle-track${checked ? ' toggle-on' : ''}`}>
        <span className="toggle-knob" />
      </span>
      <span className="toggle-label">{label}</span>
      {hint && <span className="toggle-hint">{hint}</span>}
    </button>
  )
}
