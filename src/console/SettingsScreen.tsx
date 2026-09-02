import type { CSSProperties } from 'react'
import { MOTION_LABELS, MOTION_MODES } from '../motion'
import { OPEN_TO, OPEN_TO_LABELS, SCREEN_HAS_GAME_CONTROLS } from '../screens'
import { useTools } from '../store/toolStore'
import { THEMES, THEME_LABELS } from '../theme'
import { UNITS } from '../units'
import {
  FLIGHT_SPEED_DEFAULT,
  FLIGHT_SPEED_MAX,
  FLIGHT_SPEED_MIN,
} from '../viewport/gameCamera'
import { NumberField } from './Field'
import { ScreenOverlay } from './ScreenOverlay'

/**
 * One setting's answer: a track with the options written across it, and one
 * moving part that slides to whichever is chosen.
 *
 * WHY A COMPONENT AND NOT FOUR `map`S. The moving part has to know WHICH option
 * is lit -- an index, not a boolean -- and the track has to know how many there
 * are to divide itself into. Written per row that is the same arithmetic four
 * times, and the day a fifth option is added to one of them the slider is the
 * thing that quietly stops lining up with its own labels. Here the index is
 * derived from the value, once, beside the list it indexes.
 *
 * THE MOVING PART IS `::before` ON THE TRACK, not a fifth element among the
 * buttons -- see `.settings-row .seg` in the stylesheet. It is told where to go
 * by two custom properties written here: `--of` divides the track into cells,
 * and `--at` says which cell to stand in. So a press changes ONE number and
 * CSS animates the travel; nothing in React moves anything, and there is no
 * measuring, no ref and no resize to keep up with.
 *
 * The buttons keep the classes every segment in the app uses -- `seg`,
 * `seg-btn`, `seg-active` -- so a settings switch is still recognisably the
 * same control, wearing a physical face the console's rows have no room for.
 */
function Switch<T extends string | boolean>({
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
 * The two states of the outline switch, in the order the slider travels.
 *
 * Off first, and ordered by STATE rather than by default. These two rows do
 * not share a default -- outlines start on, game controls start off -- so
 * ordering each from its own default outwards aimed two identical-looking
 * tracks opposite ways, and the slider sitting right would have meant "on" in
 * one row and "off" in the other. Off then On in both: the slider travels from
 * nothing to something, so how far right it sits is how much is turned on.
 *
 * A list rather than two hand-written buttons, so the row is built by the same
 * `Switch` the units and the themes are and cannot drift into a different
 * control. It stays local -- unlike `THEMES` and `UNITS`, which are exported
 * because the geometry and the stylesheet have to agree with them, this is two
 * labels for one boolean and nothing outside this screen needs them.
 */
const OUTLINE_CHOICES = [
  { value: false, label: 'Off' },
  { value: true, label: 'On' },
] as const

/** The same two labels for the camera scheme. See `OUTLINE_CHOICES`. */
const GAME_CHOICES = [
  { value: false, label: 'Off' },
  { value: true, label: 'On' },
] as const

/** The units, as the switch wants them: the suffix is its own label. */
const UNIT_CHOICES = UNITS.map((unit) => ({ value: unit, label: unit }))

/** Where the app starts, under the names the screens table gives them. */
const OPEN_TO_CHOICES = OPEN_TO.map((where) => ({ value: where, label: OPEN_TO_LABELS[where] }))

/** And the palettes, each under the name the theme table gives it. */
const THEME_CHOICES = THEMES.map((name) => ({ value: name, label: THEME_LABELS[name] }))

/** And the three answers about movement, under the names the motion table
 *  gives them. */
const MOTION_CHOICES = MOTION_MODES.map((mode) => ({ value: mode, label: MOTION_LABELS[mode] }))

/**
 * Everything about how the app is READ and DRIVEN, as a screen over the whole
 * app rather than a menu hanging off the cog.
 *
 * WHY THESE TOGETHER. A unit and a theme are the same kind of thing, and it
 * took having a second one to see it: neither touches the document. The geometry
 * is scene units whatever is on screen and whatever palette is around it, so a
 * millimetre and a dark background are both facts about this viewer rather than
 * about the model -- which is exactly what a preferences screen is for.
 *
 * A NAME AND A SWITCH PER ROW, AND NOTHING ELSE. No sentence under the name, no
 * lede under the title, no `title` on any control -- see `CLAUDE.md`, which is
 * where that rule lives for the whole app. What each setting does belongs in
 * Help, which is a document and is built to be read; this screen is a set of
 * controls and is built to be used, and prose beside every one of them made
 * four one-line answers into four paragraphs to scroll past.
 *
 * The shell -- backdrop, card, lid, and the fade in and out -- is
 * `ScreenOverlay`, shared with Help. What is in this file is the four rows.
 *
 * Discrete buttons rather than dropdowns, reusing the `seg` control the side
 * count already uses: every option in here is one or two words, and a select
 * would hide all but one of them behind a click to save no space at all.
 */
export function SettingsScreen() {
  const openTo = useTools((s) => s.openTo)
  const setOpenTo = useTools((s) => s.setOpenTo)
  const displayUnit = useTools((s) => s.displayUnit)
  const setDisplayUnit = useTools((s) => s.setDisplayUnit)
  const theme = useTools((s) => s.theme)
  const setTheme = useTools((s) => s.setTheme)
  const showOutlines = useTools((s) => s.showOutlines)
  const setShowOutlines = useTools((s) => s.setShowOutlines)
  const motion = useTools((s) => s.motion)
  const setMotion = useTools((s) => s.setMotion)
  const gameControls = useTools((s) => s.gameControls)
  const setGameControls = useTools((s) => s.setGameControls)
  const flightSpeed = useTools((s) => s.flightSpeed)
  const setFlightSpeed = useTools((s) => s.setFlightSpeed)
  // Dimmed rather than hidden on the screens with no room to walk about in.
  // The same bargain the bar strikes with the document controls: a screen that
  // changed shape between screens would hide the feature from the two screens
  // it is most likely to be looked for from. See `SCREEN_HAS_GAME_CONTROLS`.
  // And dead at the front door too, which is not a screen with a room to walk
  // about in either -- it is a list of projects. The check is `atWelcome` rather
  // than another column in that table for the reason the table has no row for
  // it: Welcome is not a screen. See `atWelcome` in `toolStore`.
  //
  // BOTH READ BEFORE EITHER IS TESTED, and that is not a style preference. The
  // screen used to be read inside the expression -- `!atWelcome &&
  // SCREEN_HAS_GAME_CONTROLS[useTools((s) => s.screen)]` -- which puts a HOOK
  // behind a short circuit: at the front door the second operand never ran, so
  // this component called one hook fewer than it had the render before, and the
  // first press of New Project tore the app down with React error #310. A hook
  // is not an expression and cannot be skipped.
  const atWelcome = useTools((s) => s.atWelcome)
  const screen = useTools((s) => s.screen)
  const flies = !atWelcome && SCREEN_HAS_GAME_CONTROLS[screen]

  return (
    <ScreenOverlay id="settings" card="settings-screen" title="Settings" closeLabel="Close settings">
      {/* One row per setting: its name on the left, the control that answers it
          on the right, a rule between each pair. */}
      <div className="settings-rows">
        {/* FIRST, because it is the only row that decides something before the
            app is on screen at all. The four below change what you are looking
            at or what your hands do, and both of those are answers about a
            session already under way; this one answers where a session begins.

            The names are the two places it can begin, not "On" and "Off": both
            options are somewhere real, and a switch reading `Off | On` beside
            the word "Welcome" would leave the alternative unnamed. See
            `OPEN_TO`. */}
        <div className="tool-group settings-row open-modes">
          <p className="subhead">Open to</p>
          <Switch options={OPEN_TO_CHOICES} value={openTo} onPick={setOpenTo} />
        </div>

        <div className="tool-group settings-row units-modes">
          <p className="subhead">Units</p>
          <Switch options={UNIT_CHOICES} value={displayUnit} onPick={setDisplayUnit} />
        </div>

        {/* One theme today, and it is still drawn as a chooser rather than as a
            line of text saying "Dark". A control that shows the state it is in
            is honest at one option and needs no rewriting at two; a label would
            have to become a control the moment the second palette lands, and
            until then it would not even say that the choice exists. */}
        <div className="tool-group settings-row theme-modes">
          <p className="subhead">Theme</p>
          <Switch options={THEME_CHOICES} value={theme} onPick={setTheme} />
        </div>

        {/* A yes-or-no, and the same two-cell track the other rows wear rather
            than a tickbox. It keeps the screen one kind of control, so four
            rows read as four answers to the same shape of question -- and it
            NAMES both states: `Off | On` with the slider on one says what the
            alternative is, which an empty square leaves you to infer. */}
        <div className="tool-group settings-row outline-modes">
          <p className="subhead">Outlines</p>
          <Switch options={OUTLINE_CHOICES} value={showOutlines} onPick={setShowOutlines} />
        </div>

        {/* Three cells rather than two, because the middle one is a real answer
            of its own: follow the system, which is what the app did before
            there was a row. Off and On either side of it overrule the system in
            that direction -- On is where a fresh app starts -- and the slider
            still travels from nothing moving to everything moving. */}
        <div className="tool-group settings-row motion-modes">
          <p className="subhead">Motion</p>
          <Switch options={MOTION_CHOICES} value={motion} onPick={setMotion} />
        </div>

        {/* LAST, because it is the largest claim of the four. The three above
            change what you are looking at; this one changes what your hands do,
            and a row that rebinds the keyboard belongs below the rows that
            recolour the background rather than above them.

            A fieldset rather than a dimmed div, so the disabled state reaches
            both buttons and the field without either having to be told
            separately -- and so a screen reader is told the group is off rather
            than finding four controls that happen to be grey. */}
        <fieldset className="tool-group settings-row game-modes" disabled={!flies}>
          <p className="subhead">Game Controls</p>
          <div className="settings-row-control">
            <Switch options={GAME_CHOICES} value={gameControls} onPick={setGameControls} />
            {/* The one control on this screen that is not a segment, and it
                earns the exception: a speed is a number over a two-hundred-to-
                one range and there is no pair of words that names it. It stays
                MOUNTED with the mode off rather than appearing with it -- the
                same rule the snap distance follows a panel away -- because a
                row that materialises only once you have found the switch is a
                row nobody knows the switch leads to.

                PINNED TO THE APP'S OWN UNIT, which is the picker three rows
                above it: the two controls are on the same screen, and a speed
                written in centimetres under a picker set to millimetres would
                be one screen disagreeing with itself.

                NO PICKER OF ITS OWN, unlike the brushes: there is one unit
                control already on this screen and it is the app's, so a second
                one three rows beneath it would be two answers to one question.

                `hoverText` off, like everything else here: it is what keeps the
                field's own two browser tooltips -- the scrub hint and the reset
                button's -- off a screen that carries none. */}
            <fieldset className="tool-group game-speed" disabled={!gameControls}>
              <NumberField
                label="Speed"
                pinUnit={displayUnit}
                value={flightSpeed}
                min={FLIGHT_SPEED_MIN}
                max={FLIGHT_SPEED_MAX}
                step={0.2}
                resetTo={FLIGHT_SPEED_DEFAULT}
                hoverText={false}
                onChange={setFlightSpeed}
              />
            </fieldset>
          </div>
        </fieldset>
      </div>
    </ScreenOverlay>
  )
}
