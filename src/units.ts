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

/**
 * The unit a length is shown in. One of these, always, everywhere.
 *
 * THERE IS NO `auto` AND NO RULE THAT CHOOSES. There used to be: a mode that
 * picked a unit per value, so a 2 mm fillet read as 2 mm and a 4 m wall as
 * 4 m. It bought readability at the two ends of the range and charged for it in
 * the middle -- a scale that renames itself under the hand aiming it cannot be
 * aimed, so every control that SETS a length had to opt out of it, and half the
 * unit machinery in this app existed to hold the choice still for the length of
 * a drag. A chosen unit is one number on screen and one number in the head.
 *
 * Metres went with it. They were only ever somewhere `auto` could arrive at on
 * its own; nobody could ask for them, and nothing can reach them now.
 */
export type Unit = 'mm' | 'cm' | 'in'

/**
 * The units a person may pick, in the order every picker shows them.
 *
 * Metric first and finest first, then the imperial one. `in` is the same kind
 * of thing as the other two -- a fixed factor and a number of places -- so
 * nothing downstream knows it is a different system.
 */
export const UNITS: Unit[] = ['mm', 'cm', 'in']

/**
 * How many of each unit make one scene unit.
 *
 * The inch is the only one that is not a power of ten, and it is exact: an inch
 * is 25.4 mm by definition, so one scene unit is 100/25.4 of them. Written as
 * the division rather than as a decimal nobody can check.
 */
const PER_UNIT: Record<Unit, number> = { mm: 100, cm: 10, in: 100 / 25.4 }

/**
 * Places to show, chosen so the finest step the app allows -- a hundredth of a
 * unit, which is one millimetre -- is still visible in every unit.
 *
 * Three for inches, which is more than that rule needs (a millimetre is 0.039
 * of one) and is what an inch is worked in: thousandths are the unit's own
 * convention, and two places would round a 1 mm nudge to 0.04 and a 2 mm one to
 * 0.08, so the field would read as though it were stepping in halves.
 */
const PLACES: Record<Unit, number> = { mm: 1, cm: 2, in: 3 }

const SUFFIX: Record<Unit, string> = { mm: 'mm', cm: 'cm', in: 'in' }

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
export function formatLength(sceneValue: number, unit: Unit): string {
  return `${toDisplay(sceneValue, unit).toFixed(PLACES[unit])} ${SUFFIX[unit]}`
}

/**
 * SEVERAL lengths in one unit, said once at the end.
 *
 * `formatLength` would write the suffix after every number; a size is one
 * measurement, so the unit is said once for all of its sides.
 *
 * Two sides or three -- a rectangle in the scene tree and a block on the
 * clipboard are the same sentence at different lengths.
 */
export function formatSize(values: readonly number[], unit: Unit): string {
  const places = PLACES[unit]
  return `${values.map((n) => toDisplay(n, unit).toFixed(places)).join(' x ')} ${SUFFIX[unit]}`
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
