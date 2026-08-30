import {
  CLAY_WALL_MAX,
  CLAY_WALL_MIN,
  DEFAULT_CLAY_WALL,
  bore,
} from '../geometry/clay'
import { useLathe } from '../store/latheStore'
import { useTools } from '../store/toolStore'
import { NumberField, UnitPicker } from './Field'
import { NavTool } from './NavTool'
import { HollowIcon } from './navIcons'

/**
 * HOLLOW: take the middle out and leave a wall.
 *
 * ON THE ISLAND, BELOW THE RULE, and it is the one button there that is not
 * aimed at anything. Push, Pull and Smooth are held against the clay; this is a
 * switch with two settings behind it. It is here anyway, and the rule above it
 * is the reason it can be: the island's own idiom for "these are a group and
 * that is not" is a hairline, borrowed from the modelling screen, which uses it
 * to separate what acts on a selection from what puts something new in a scene.
 *
 * The alternative was the console, beside Base -- which is genuinely the same
 * KIND of thing, a fact about the piece rather than a gesture. What settles it
 * the other way is that hollowing is something you do PART WAY THROUGH, usually
 * once the outside is roughly right, and reaching across the window for it
 * would break a rhythm the other three tools keep. Base is picked once and left;
 * this gets flipped on and off while you look at the section.
 *
 * WHAT IT ACTUALLY DOES lives in `bore`: this writes one thickness and two
 * booleans, and everything else -- how far the cavity reaches, whether an end
 * really is open, where the floor sits -- is worked out from the wall as it
 * stands, every time anything asks. So a stroke made after hollowing thins the
 * wall with it, which is what happens on a wheel and what nobody would expect
 * from a stored inner profile.
 */

/** What the piece is when the switch is first thrown: a cup. Open at the top
 *  and standing on a floor is what "hollow" means to almost everybody, and the
 *  two other combinations are one press away from it. */
const DEFAULT_HOLLOW = { thickness: DEFAULT_CLAY_WALL, capTop: false, capBottom: true }

/**
 * One end of the piece: closed by material, or open to the cavity.
 *
 * A segmented pair rather than a checkbox, because the two states have names
 * and the names are what make the control readable. "Bottom: [Closed|Open]"
 * says what the piece IS; a ticked box labelled "cap bottom" makes the reader
 * work out what the unticked state would be.
 */
function EndPair({
  label,
  capped,
  onChange,
}: {
  label: string
  capped: boolean
  onChange: (capped: boolean) => void
}) {
  return (
    <div className="hollow-end">
      <span className="hollow-end-label">{label}</span>
      <div className="seg" role="group" aria-label={`${label} end`}>
        <button
          type="button"
          className={`seg-btn${capped ? ' seg-active' : ''}`}
          aria-pressed={capped}
          onClick={() => onChange(true)}
        >
          Closed
        </button>
        <button
          type="button"
          className={`seg-btn${capped ? '' : ' seg-active'}`}
          aria-pressed={!capped}
          onClick={() => onChange(false)}
        >
          Open
        </button>
      </div>
    </div>
  )
}

export function HollowTool() {
  const clay = useLathe((s) => s.clay)
  const setHollow = useLathe((s) => s.setHollow)
  const hollow = clay.hollow
  const on = hollow !== null

  // What the piece HAS, as against what was asked for. An end is open only if
  // the cavity reaches it -- ask for a pipe and pinch the neck shut and you get
  // a blind hole -- and the note below says so rather than letting the user
  // find out on the clipboard. See `bore`.
  const cavity = bore(clay)

  // ONE UNIT FOR THE PANEL, chosen at its top right rather than on the row.
  // Every length in here is the same kind of thing -- a thickness of clay --
  // so the switch belongs to the panel, and the field wears the answer instead
  // of a picker of its own. Millimetres to start with: see `hollowSizeUnit`.
  const sizeUnit = useTools((s) => s.hollowSizeUnit)
  const setSizeUnit = useTools((s) => s.setHollowSizeUnit)

  return (
    <NavTool
      id="hollow"
      label="Hollow"
      icon={<HollowIcon />}
      active={on}
      onToggle={(next) => setHollow(next ? DEFAULT_HOLLOW : null)}
      panelTitle="Hollow"
      panelRight={<UnitPicker unit={sizeUnit} onChange={setSizeUnit} of="Wall thickness" />}
      tip="Take the middle out and leave a wall. The inside follows the outside, so shaping afterwards thins the wall with it."
    >
      <div className="tool-group">
        <NumberField
          pinUnit={sizeUnit}
          label="Wall"
          value={hollow?.thickness ?? DEFAULT_CLAY_WALL}
          min={CLAY_WALL_MIN}
          max={CLAY_WALL_MAX}
          step={0.005}
          resetTo={DEFAULT_CLAY_WALL}
          onChange={(thickness) => setHollow({ ...(hollow ?? DEFAULT_HOLLOW), thickness })}
          tip="How much clay is left. The floor and the lid are the same thickness."
        />

        {/* The two ends, independently. Bottom first, because it is the one that
            is usually closed and because the piece is read from the faceplate
            up everywhere else on this screen. */}
        <EndPair
          label="Bottom"
          capped={hollow?.capBottom ?? true}
          onChange={(capBottom) => setHollow({ ...(hollow ?? DEFAULT_HOLLOW), capBottom })}
        />
        <EndPair
          label="Top"
          capped={hollow?.capTop ?? false}
          onChange={(capTop) => setHollow({ ...(hollow ?? DEFAULT_HOLLOW), capTop })}
        />

        {/* WHAT CAME OF IT, which is not always what was asked for -- and this
            is the only place that can say so. A wall thicker than the piece is
            wide leaves nothing to bore; a neck narrower than two walls stops
            the cavity before it reaches the rim, so an end asked to be open
            comes out blind. Both are the honest answer rather than a refusal,
            and both are invisible in the drawing at a glance. */}
        {on && (
          <p className="hollow-note">
            {cavity === null ? (
              <>Nothing to bore: the wall is as thick as the piece.</>
            ) : (
              <>
                {cavity.openTop && cavity.openBottom
                  ? 'Open all the way through.'
                  : cavity.openTop
                    ? 'Open at the top, standing on a floor.'
                    : cavity.openBottom
                      ? 'Open underneath, closed at the rim.'
                      : 'A sealed void, which shows only when something cuts it.'}
                {((!cavity.openTop && hollow.capTop === false) ||
                  (!cavity.openBottom && hollow.capBottom === false)) &&
                  ' The piece is too narrow to bore through to the end you asked for.'}
              </>
            )}
          </p>
        )}
      </div>
    </NavTool>
  )
}
