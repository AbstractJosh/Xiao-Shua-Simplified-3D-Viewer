import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { Vec2, Vec3 } from '../geometry/types'
import { SCRUB_SLOP, scrubbed } from './scrub'
import { Tip } from './Tip'
import { trackWindow } from './scrub'
import { useTools } from '../store/toolStore'
import type { Unit } from '../units'
import { UNITS, decimalsOf, fromDisplay, stepIn, suffixOf, toDisplay } from '../units'

/**
 * The stretch of range a slider track shows, held steady while it is dragged.
 *
 * The window follows the value, so without the hold it would follow the value
 * being dragged -- recentring under the thumb every frame, which is a thumb
 * that can never reach the edge of its own track. Frozen at the press, the
 * track behaves like a track for the whole gesture and recentres once, on
 * release.
 *
 * The same rule as `scrubbed` and as the gizmo: a
 * gesture is measured from the press, never accumulated as it goes.
 */
function useHeldWindow(value: number, min: number, max: number, step: number) {
  const held = useRef<{ lo: number; hi: number } | null>(null)
  // Only to force the recentre on release; the window itself lives in the ref
  // so that freezing it costs no render in the middle of a drag.
  const [, settle] = useState(0)
  const window = held.current ?? trackWindow(value, min, max, step)
  return {
    lo: window.lo,
    hi: window.hi,
    grab: () => {
      held.current = window
    },
    drop: () => {
      if (!held.current) return
      held.current = null
      settle((n) => n + 1)
    },
  }
}

/**
 * The unit a whole SECTION shows its lengths in.
 *
 * A panel used to write its unit on every row -- "cm" under Position X, under
 * Y, under Z, under Width, under Height, under Depth -- which is the same word
 * six times and, in the viewport panel where a row is one line of a grid, six
 * extra lines of height for it. Said once at the top of the panel it costs one
 * corner nothing else was using.
 *
 * Null for a field outside any such section -- the snap distance in the tool
 * island -- which goes on labelling its own.
 *
 * IT USED TO CARRY A HOLD as well, and does not need to any more: with `auto`
 * gone there is no rule that could change a unit under a dragging hand, so
 * there is nothing to freeze for the length of a gesture. What is left is the
 * unit itself. See `Unit` in `units.ts`.
 */
const UnitScope = createContext<Unit | null>(null)

/** The app's unit, for a control that is showing a length. Null for one that is
 *  not a length at all, which is what takes the suffix off a plain number. */
function useShownUnit(active: boolean): Unit | null {
  const unit = useTools((s) => s.displayUnit)
  return active ? unit : null
}

/**
 * The unit a field shows, and whether the field has to SAY it.
 *
 * Inside a section that has settled on one, the section says it -- once, in its
 * header -- and the row shows the bare number. Outside one the field is on its
 * own and wears its own suffix, exactly as it always did.
 *
 * The hook runs whatever the answer, which is what keeps the hook order fixed.
 */
function useFieldUnit(active: boolean, pinned?: Unit): { unit: Unit | null; labelled: boolean } {
  const scope = useContext(UnitScope)
  const own = useShownUnit(active && pinned === undefined && scope === null)
  // A PIN ANSWERS AHEAD OF BOTH: the field is not in the section's unit, so the
  // section cannot take the label off it.
  if (pinned) return { unit: pinned, labelled: true }
  if (active && scope) return { unit: scope, labelled: false }
  return { unit: own, labelled: own !== null }
}

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
  hoverText = true,
  onChange,
}: {
  className: string
  value: number
  min: number
  max: number
  step: number
  decimals: number
  /** Whether to name the two gestures on hover. See `NumberFieldProps`. */
  hoverText?: boolean
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
      title={hoverText ? 'Drag to change, double-click to type' : undefined}
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
  /**
   * This value is a LENGTH in scene units: show it in whatever unit the tool
   * island is set to, and convert back on the way in.
   *
   * `min`, `max` and `step` stay in SCENE units here -- the opposite of the
   * `degrees` convention on `Vec3Field`, and deliberately. A rotation's unit is
   * fixed, so a caller can express its bounds in degrees; a length's is whatever
   * the app is set to, and a caller cannot write bounds in a unit it has no way
   * of knowing.
   */
  unit?: boolean
  /**
   * PIN this field to one unit and let the reader change it, instead of taking
   * the app's. Implies `unit`, and overrides both it and any `Section` unit the
   * field sits inside; `min`, `max` and `step` stay in SCENE units exactly as
   * they do above.
   *
   * For a control somebody wants read in a unit of its own -- a brush size in
   * centimetres while the readouts are in millimetres. See `erodeSizeUnit`. The
   * suffix becomes the picker, so the unit is chosen where it is read and the
   * row costs no extra height.
   */
  ownUnit?: { unit: Unit; onChange: (unit: Unit) => void }
  /**
   * Pinned to a unit chosen ELSEWHERE -- a picker in the panel's header rather
   * than on the row.
   *
   * The same pin `ownUnit` applies, without the buttons: for a panel whose
   * lengths all mean the same kind of thing, one switch at the top says it once
   * instead of every row saying it again. See `UnitPicker` and `HollowTool`.
   */
  pinUnit?: Unit
  /**
   * Whether this field may explain itself on HOVER -- the browser tooltip
   * naming the scrub gesture on the number, and the one on the reset button.
   *
   * On by default, because in a console panel that hint is the only thing that
   * says a number box can be dragged, and there is no room on the row to write
   * it. Turned off by the settings screen, which is built on the opposite rule:
   * everything there is said in the open, beside the control, where a touch
   * screen and a keyboard can reach it too. It takes only the TITLES -- the
   * reset button keeps its `aria-label`, so nothing becomes nameless.
   */
  hoverText?: boolean
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
  unit = false,
  ownUnit,
  pinUnit,
  hoverText = true,
  onChange,
}: NumberFieldProps) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  const { unit: shown, labelled } = useFieldUnit(
    unit || ownUnit !== undefined || pinUnit !== undefined,
    ownUnit?.unit ?? pinUnit
  )

  // Everything the control shows moves together -- value, both bounds and the
  // step. That is what keeps the FEEL identical across units: `scrubTravel` is
  // built from the step and the range, so scaling all three by the same factor
  // scales the travel with them and a pixel is worth the same distance in the
  // WORLD whichever unit is written on screen.
  const ui = (v: number) => (shown ? toDisplay(v, shown) : v)
  const raw = (v: number) => (shown ? fromDisplay(v, shown) : v)
  const uiStep = shown ? stepIn(step, shown) : step
  const uiPlaces = shown ? decimalsOf(shown) : decimals
  const track = useHeldWindow(ui(value), ui(min), ui(max), uiStep)

  return (
    <div className="field">
      <div className="field-head">
        <span className="field-label">{label}</span>
        {tip && <Tip>{tip}</Tip>}
        {resetTo !== undefined && (
          <ResetButton
            label={`Reset ${label.toLowerCase()}`}
            hoverText={hoverText}
            disabled={Math.abs(value - resetTo) <= RESET_EPS}
            onClick={() => onChange(resetTo)}
          />
        )}
        <ScrubNumber
          className="field-num"
          value={ui(value)}
          min={ui(min)}
          max={ui(max)}
          step={uiStep}
          decimals={uiPlaces}
          hoverText={hoverText}
          onChange={(v) => onChange(clamp(raw(v)))}
        />
        {/* Where the bare suffix goes when the field owns its unit. In the same
            slot on purpose: the unit is changed where it is already being read,
            and the row does not grow. */}
        {ownUnit ? (
          <UnitPicker unit={ownUnit.unit} onChange={ownUnit.onChange} of={label} />
        ) : (
          shown && labelled && <span className="field-unit">{suffixOf(shown)}</span>
        )}
      </div>
      <input
        className="field-range"
        type="range"
        min={track.lo}
        max={track.hi}
        step={uiStep}
        value={ui(value)}
        onPointerDown={track.grab}
        onPointerUp={track.drop}
        onPointerCancel={track.drop}
        onChange={(e) => onChange(clamp(raw(Number(e.target.value))))}
      />
    </div>
  )
}

/**
 * The two-button unit switch: the one every control that SETS a length wears.
 *
 * ITS OWN COMPONENT because there are now two places it belongs. On a field it
 * stands where the suffix would, so the unit is changed where it is read and
 * the row costs no extra height -- see `ownUnit`. In a tool panel's header it
 * stands at the top right and speaks for the whole panel, which is the right
 * arrangement once a panel has one length in it and a settled opinion about
 * what that length is measured in. Two copies of five buttons and an
 * `aria-pressed` would have drifted the first time either was touched.
 *
 * `of` names what is being measured, for the accessible name and for a reader
 * who arrives at the buttons with no idea what they apply to. Given as the
 * control's own label, in the case it is written in -- the tooltip lowercases
 * it, since there it lands mid-sentence.
 */
export function UnitPicker({
  unit,
  onChange,
  of,
  className = 'field-units',
}: {
  unit: Unit
  onChange: (unit: Unit) => void
  of: string
  className?: string
}) {
  return (
    <div className={`seg ${className}`} role="group" aria-label={`${of} unit`}>
      {UNITS.map((option) => (
        <button
          key={option}
          type="button"
          className={`seg-btn${unit === option ? ' seg-active' : ''}`}
          aria-pressed={unit === option}
          title={`Read and type ${of.toLowerCase()} in ${option}`}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
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
  hasLengths,
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
  /**
   * THIS SECTION SHOWS LENGTHS: wear the app's unit at the top right, and let
   * every length field inside show itself in it rather than writing it out
   * again per row. See `UnitScope`.
   *
   * A FLAG, where it used to be the values themselves. `auto` chose a unit per
   * magnitude, so the section had to be handed its lengths to pick the same one
   * its rows would have picked; there is one unit now and nothing to choose
   * from. Left off, nothing changes: the fields label their own, one at a time.
   */
  hasLengths?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const unit = useShownUnit(hasLengths === true)
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
        {/* The one loud thing in a muted header, because it is the key to every
            number under it: take it away and the panel is a column of bare
            figures that could be millimetres or metres. */}
        {unit && (
          <span className="section-unit" title={`Every length here is in ${suffixOf(unit)}`}>
            {suffixOf(unit)}
          </span>
        )}
        {right && <span className="section-right">{right}</span>}
      </h2>
      {shown &&
        (unit === null ? (
          children
        ) : (
          <UnitScope.Provider value={unit}>{children}</UnitScope.Provider>
        ))}
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
  hoverText = true,
  disabled,
  onClick,
}: {
  label: string
  /** Whether the name is also shown on hover. The `aria-label` stays either
   *  way -- this is a tooltip, not the button's name. See `NumberFieldProps`. */
  hoverText?: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="reset-btn"
      title={hoverText ? label : undefined}
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
  suffix,
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
  suffix?: string
  onChange: (v: number) => void
}) {
  const track = useHeldWindow(value, min, max, step)
  return (
    <div className={`vec3-row${resetTo === undefined ? '' : ' vec3-row-resettable'}`}>
      <span className={`vec3-axis vec3-axis-${tint}`}>{axis}</span>
      <input
        className="field-range"
        type="range"
        min={track.lo}
        max={track.hi}
        step={step}
        value={value}
        onPointerDown={track.grab}
        onPointerUp={track.drop}
        onPointerCancel={track.drop}
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
      {suffix && <span className="vec3-unit">{suffix}</span>}
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
  unit = false,
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
  /** Lengths in scene units, shown in the tool island's unit. `min`/`max`/`step`
   *  stay in SCENE units -- see the note on `NumberField`. Never with `degrees`:
   *  a rotation is not a length. */
  unit?: boolean
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
  const { unit: shown, labelled } = useFieldUnit(unit && !degrees)
  const toUi = (v: number) =>
    degrees ? (v * 180) / Math.PI : shown ? toDisplay(v, shown) : v
  const fromUi = (v: number) =>
    degrees ? (v * Math.PI) / 180 : shown ? fromDisplay(v, shown) : v

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
          min={shown ? toDisplay(min, shown) : min}
          max={shown ? toDisplay(max, shown) : max}
          step={shown ? stepIn(stepped, shown) : stepped}
          decimals={shown ? decimalsOf(shown) : places}
          resetTo={resetTo}
          suffix={shown && labelled ? suffixOf(shown) : undefined}
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
  unit = false,
  onChange,
}: {
  label: string
  labels?: [string, string]
  value: Vec2
  min: number
  max: number
  step?: number
  /** Lengths in scene units, shown in the island's unit -- as `NumberField`. */
  unit?: boolean
  onChange: (v: Vec2) => void
}) {
  const { unit: shown, labelled } = useFieldUnit(unit)
  const ui = (v: number) => (shown ? toDisplay(v, shown) : v)
  const raw = (v: number) => (shown ? fromDisplay(v, shown) : v)

  return (
    <div className="vec2">
      <div className="subhead">{label}</div>
      {labels.map((axis, i) => (
        <AxisRow
          key={i}
          axis={axis}
          tint={i === 0 ? 'x' : 'y'}
          value={ui(value[i])}
          min={ui(min)}
          max={ui(max)}
          step={shown ? stepIn(step, shown) : step}
          decimals={shown ? decimalsOf(shown) : 2}
          suffix={shown && labelled ? suffixOf(shown) : undefined}
          onChange={(u) =>
            onChange(i === 0 ? [raw(u), value[1]] : [value[0], raw(u)])
          }
        />
      ))}
    </div>
  )
}

/**
 * One yes-or-no, or one of a few named answers: a track with the options
 * written across it, and one moving part that slides to whichever is chosen.
 *
 * WHY A COMPONENT AND NOT A `map` PER ROW. The moving part has to know WHICH
 * option is lit -- an index, not a boolean -- and the track has to know how
 * many there are to divide itself into. Written per row that is the same
 * arithmetic every time, and the day a third option is added to one of them
 * the slider is the thing that quietly stops lining up with its own labels.
 * Here the index is derived from the value, once, beside the list it indexes.
 *
 * THE MOVING PART IS `::before` ON THE TRACK, not an extra element among the
 * buttons -- see `.settings-row .seg` in the stylesheet. It is told where to go
 * by two custom properties written here: `--of` divides the track into cells,
 * and `--at` says which cell to stand in. So a press changes ONE number and
 * CSS animates the travel; nothing in React moves anything, and there is no
 * measuring, no ref and no resize to keep up with. Anywhere the stylesheet
 * draws no moving part -- the console's own panels -- the two properties are
 * simply unread, and the lit button is the whole of the answer.
 *
 * The buttons keep the classes every segment in the app uses -- `seg`,
 * `seg-btn`, `seg-active` -- so a switch is still recognisably the same
 * control as the side-count chips, wearing a physical face where the row has
 * room for one. It lives here rather than on the Settings screen that first
 * needed it because the Object panel's Lock row is the same control asking the
 * same shape of question, and two copies would be two switches to keep alike.
 */
export function Switch<T extends string | boolean>({
  options,
  value,
  onPick,
}: {
  /** In the order they are shown, which is the order the slider travels. */
  options: readonly { value: T; label: string }[]
  value: T
  onPick: (value: T) => void
}) {
  // Clamped rather than left at -1: a value that matches no option would park
  // the slider a cell to the LEFT of the track and hang it out of the box.
  const at = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <div
      className="seg"
      style={{ '--at': at, '--of': options.length } as CSSProperties}
    >
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={`seg-btn${o.value === value ? ' seg-active' : ''}`}
          aria-pressed={o.value === value}
          onClick={() => onPick(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * The two states of a yes-or-no switch, in the order the slider travels.
 *
 * Off first, and ordered by STATE rather than by default. Rows do not share a
 * default -- outlines start on, game controls start off -- so ordering each
 * from its own default outwards aimed two identical-looking tracks opposite
 * ways, and the slider sitting right would have meant "on" in one row and
 * "off" in the other. Off then On everywhere: the slider travels from nothing
 * to something, so how far right it sits is how much is turned on.
 *
 * A list rather than two hand-written buttons, so every yes-or-no row is built
 * by the same `Switch` the units and the themes are and cannot drift into a
 * different control.
 */
export const OFF_ON = [
  { value: false, label: 'Off' },
  { value: true, label: 'On' },
] as const
