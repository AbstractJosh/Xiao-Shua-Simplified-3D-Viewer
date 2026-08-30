import { useRef } from 'react'
import { CLAY_SIDES } from '../geometry/clay'
import { useLathe } from '../store/latheStore'
import { Section } from './Field'
import { DEFAULT_SIDES, NGON_NAMES, ngonPoints } from './ngon'

/**
 * What the piece is turned ON: a circle, or a polygon from a triangle to a
 * decagon.
 *
 * IN THE CONSOLE, and it is the first control on this screen that belongs
 * there, so the line is worth drawing. The two tools are on the island because
 * they are AIMED -- you point them at the clay. The stock is in the corner over
 * the piece because it is a size, and a number you type while watching the
 * shape it grows. Neither is true of this. The base cannot be aimed, it is not
 * a length, and -- the part that settles it -- IT DOES NOT SHOW IN THE DRAWING:
 * a hexagonal piece and a round one have the same profile, so a control for it
 * over the viewport would be a control sitting on top of the one view that
 * cannot answer it. The console is for what a screen CONTAINS, and what this
 * screen contains is one lump with a section. This is that section.
 *
 * TWO LEVELS, because that is the choice as it is actually made: round or
 * faceted first, and only then how many facets. A flat run of nine tiles would
 * put the circle -- the thing most pieces are, and the app's own default -- in
 * a row of polygons as though it were the tenth of them, and would ask everyone
 * who wants the ordinary answer to read past eight shapes to find it.
 *
 * WHAT IT COSTS THE REST OF THE APP: nothing. See `Clay.sides` -- the wall is
 * one row of radii on every base, and the section is not spent until the piece
 * is swept into triangles for the clipboard. This panel writes one number.
 */

/** What a base is called: the circle by its own name, the rest by the polygon
 *  they stand on. Shared with the Shapes palette, so the two panels cannot
 *  disagree about what a nonagon is. */
export function baseName(sides: number | null): string {
  return sides === null ? 'Circle' : (NGON_NAMES[sides] ?? `${sides}-sided`)
}

function SideTile({
  sides,
  chosen,
  onPick,
}: {
  sides: number
  chosen: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      className={`base-side${chosen ? ' base-side-on' : ''}`}
      aria-pressed={chosen}
      // The shape, its name and its count: the icon is the fast read, and the
      // number under it is the one that settles a heptagon from an octagon at
      // twenty pixels across.
      title={`${baseName(sides)}, ${sides} sides`}
      aria-label={`${baseName(sides)}, ${sides} sides`}
      onClick={onPick}
    >
      <svg viewBox="0 0 32 32" className="base-side-icon" aria-hidden>
        <polygon
          points={ngonPoints(sides, 11)}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
      <span className="base-side-count">{sides}</span>
    </button>
  )
}

export function BasePanel() {
  const sides = useLathe((s) => s.clay.sides)
  const setSides = useLathe((s) => s.setSides)

  /**
   * Which polygon Polygon means, for somebody who has gone round to Circle and
   * back.
   *
   * A ref rather than state, because nothing renders off it directly -- it is
   * read at the instant the button is pressed -- and because it must not be
   * able to fight the store: what is CHOSEN is `sides`, and this only remembers
   * what was chosen last. Seeded from the clay, so a piece that is already a
   * hexagon comes back a hexagon.
   */
  const remembered = useRef(sides ?? DEFAULT_SIDES)
  if (sides !== null) remembered.current = sides

  const round = sides === null

  return (
    <Section
      title="Base"
      hint={baseName(sides)}
      tip={
        <>
          The shape the piece is turned on, seen end-on. Every base has the same{' '}
          <b>profile</b> -- a hexagonal piece and a round one are the same
          rectangle from the side -- so the drawing does not change when you pick
          one. What changes is the solid that lands on the clipboard.
        </>
      }
    >
      <div className="seg base-modes" role="group" aria-label="Base shape">
        <button
          type="button"
          className={`seg-btn${round ? ' seg-active' : ''}`}
          aria-pressed={round}
          onClick={() => setSides(null)}
        >
          Circle
        </button>
        <button
          type="button"
          className={`seg-btn${round ? '' : ' seg-active'}`}
          aria-pressed={!round}
          // Back to the polygon it was last on rather than to a fixed six: a
          // trip through Circle to compare the two must not cost the count
          // somebody had settled on.
          onClick={() => setSides(remembered.current)}
        >
          Polygon
        </button>
      </div>

      {/* Shown only under Polygon, and not merely dimmed. Eight tiles is the
          biggest thing in this console after the clipboard shelf, and a round
          piece has no use for any of them -- the seg above says which of the
          two questions is live, and this is the second one. */}
      {!round && (
        <div className="base-sides" role="group" aria-label="Number of sides">
          {CLAY_SIDES.map((n) => (
            <SideTile
              key={n}
              sides={n}
              chosen={n === sides}
              onPick={() => setSides(n)}
            />
          ))}
        </div>
      )}
    </Section>
  )
}
