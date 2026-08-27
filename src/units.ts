/**
 * What a scene unit MEANS, and the only place that is written down.
 *
 * The geometry has always been unitless -- `dimensions.ts` bounds it, nothing
 * interprets it -- and the one place a real length was ever asserted was the
 * STEP exporter, in a comment. That was fine while a model was an abstract
 * couple of units across. It stops being fine the moment the app claims to make
 * a five-metre part, because "5" on a slider has to mean something.
 *
 * ONE SCENE UNIT IS TEN CENTIMETRES. Everything else here follows from that.
 *
 * The rule this module exists to keep is one-directional: SCENE UNITS NEVER
 * LEAVE THE GEOMETRY, AND DISPLAY UNITS NEVER ENTER IT. Panels convert on the
 * way out and back on the way in; nothing between here and `dimensions.ts` ever
 * sees a millimetre. It is the same discipline `Field.tsx` already keeps for
 * rotations, which are radians underneath and degrees on screen.
 */

/** The unit a length is actually shown in, once `auto` has made up its mind. */
export type Unit = 'mm' | 'cm' | 'm'

/**
 * What the user picked in the tool island.
 *
 * `auto` is not a fourth unit -- it is a rule for choosing one of the three per
 * value, so a 2 mm fillet and a 4 m wall are both readable without either
 * turning into a row of zeroes.
 */
export type UnitMode = Unit | 'auto'

export const UNIT_MODES: UnitMode[] = ['mm', 'cm', 'auto']

/** How many of each unit make one scene unit. */
const PER_UNIT: Record<Unit, number> = { mm: 100, cm: 10, m: 0.1 }

/** Places to show, chosen so the finest step the app allows -- a hundredth of a
 *  unit, which is one millimetre -- is still visible in every unit. */
const PLACES: Record<Unit, number> = { mm: 1, cm: 2, m: 3 }

const SUFFIX: Record<Unit, string> = { mm: 'mm', cm: 'cm', m: 'm' }

/**
 * Which unit to show a given length in.
 *
 * The thresholds are round numbers in the unit being left, not in scene units:
 * `auto` switches out of millimetres at 10 mm and out of centimetres at 100 cm,
 * so the number on screen stays between roughly 1 and 1000 whatever is being
 * measured. Zero and anything near it stays in millimetres rather than becoming
 * "0.000 m".
 */
export function resolveUnit(sceneValue: number, mode: UnitMode): Unit {
  if (mode !== 'auto') return mode
  const mm = Math.abs(sceneValue) * PER_UNIT.mm
  if (mm < 10) return 'mm'
  if (mm < 1000) return 'cm'
  return 'm'
}

/** Scene units to the unit on screen. */
export function toDisplay(sceneValue: number, unit: Unit): number {
  return sceneValue * PER_UNIT[unit]
}

/** And back. Every value written to the document goes through here. */
export function fromDisplay(shown: number, unit: Unit): number {
  return shown / PER_UNIT[unit]
}

/**
 * A length as a person reads it: the number, its places, and the unit it is in.
 *
 * For the places that SHOW a length rather than edit one -- a ruler's readout,
 * a row in the ruler list -- where `NumberField`'s box, spinner and scrub are
 * all machinery for a value nobody is going to type. It goes through the same
 * three functions the fields do, so a ruler saying 50.0 mm and a dimension row
 * saying 50.0 mm cannot start disagreeing about what 0.5 units is.
 */
export function formatLength(sceneValue: number, mode: UnitMode): string {
  const unit = resolveUnit(sceneValue, mode)
  return `${toDisplay(sceneValue, unit).toFixed(PLACES[unit])} ${SUFFIX[unit]}`
}

export function suffixOf(unit: Unit): string {
  return SUFFIX[unit]
}

export function decimalsOf(unit: Unit): number {
  return PLACES[unit]
}

/**
 * The step to show in a given unit, from the step in scene units.
 *
 * Rounded to something a person would type. A raw conversion of the 0.01-unit
 * dimension step gives exactly 1 mm, but the 0.05-unit position step gives
 * 5 mm and 0.5 cm, and a box stepping in halves reads as broken -- so anything
 * that lands off a decimal is nudged onto one.
 */
export function stepIn(sceneStep: number, unit: Unit): number {
  const raw = sceneStep * PER_UNIT[unit]
  const decade = 10 ** Math.floor(Math.log10(raw))
  for (const tidy of [1, 2, 5, 10]) {
    if (raw <= tidy * decade * 1.0001) return Number((tidy * decade).toPrecision(6))
  }
  return Number(raw.toPrecision(6))
}
