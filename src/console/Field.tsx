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
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="section">
      <h2 className="section-title">
        {title}
        {hint && <span className="section-hint">{hint}</span>}
      </h2>
      {children}
    </section>
  )
}
