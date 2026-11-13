import { CONTROL_SCHEMES, CONTROL_SCHEME_LABELS } from '../controlScheme'
import { MOTION_LABELS, MOTION_MODES } from '../motion'
import { OPEN_TO, OPEN_TO_LABELS } from '../screens'
import { useTools } from '../store/toolStore'
import { THEMES, THEME_LABELS } from '../theme'
import { UNITS } from '../units'
import {
  FLIGHT_SPEED_DEFAULT,
  FLIGHT_SPEED_MAX,
  FLIGHT_SPEED_MIN,
} from '../viewport/gameCamera'
import { NumberField, OFF_ON, Switch } from './Field'
import { ScreenOverlay } from './ScreenOverlay'

// The switch itself, and the `Off | On` pair the yes-or-no rows share, live in
// `Field.tsx` with the rest of the console's controls: the Object panel's Lock
// row asks the same shape of question, and one switch is what keeps the two
// alike. See `Switch` and `OFF_ON` there.

/** The units, as the switch wants them: the suffix is its own label. */
const UNIT_CHOICES = UNITS.map((unit) => ({ value: unit, label: unit }))

/** Where the app starts, under the names the screens table gives them. */
const OPEN_TO_CHOICES = OPEN_TO.map((where) => ({ value: where, label: OPEN_TO_LABELS[where] }))

/** And the palettes, each under the name the theme table gives it. */
const THEME_CHOICES = THEMES.map((name) => ({ value: name, label: THEME_LABELS[name] }))

/** And the three answers about movement, under the names the motion table
 *  gives them. */
const MOTION_CHOICES = MOTION_MODES.map((mode) => ({ value: mode, label: MOTION_LABELS[mode] }))

/** And whose controls the app is driven with, under the names the scheme table
 *  gives them. */
const SCHEME_CHOICES = CONTROL_SCHEMES.map((scheme) => ({
  value: scheme,
  label: CONTROL_SCHEME_LABELS[scheme],
}))

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
  const controlScheme = useTools((s) => s.controlScheme)
  const setControlScheme = useTools((s) => s.setControlScheme)
  const flightSpeed = useTools((s) => s.flightSpeed)
  const setFlightSpeed = useTools((s) => s.setFlightSpeed)

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
          <Switch options={OFF_ON} value={showOutlines} onPick={setShowOutlines} />
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

        {/* LAST, because it is the largest claim of them all. The rows above
            change what you are looking at; this one changes what your hands do,
            and a row that rebinds the mouse and the keyboard belongs below the
            rows that recolour the background rather than above them.

            LIVE ON EVERY SCREEN, where the switch it replaced was dimmed on two
            of them: that one only offered flying, which the lathe and the laser
            cutter have no room for, and this one says which button turns the
            camera, which is a question all three screens ask. `Game` picked
            from a screen that cannot be walked simply drives like Default there
            -- see `flyingHere`. */}
        <div className="tool-group settings-row control-modes">
          <p className="subhead">Controls</p>
          <div className="settings-row-control">
            <Switch options={SCHEME_CHOICES} value={controlScheme} onPick={setControlScheme} />
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
            {/* A fieldset rather than a dimmed div, so a screen reader is told
                the field is off rather than finding one that happens to be
                grey. It means something under one scheme of the five. */}
            <fieldset className="tool-group game-speed" disabled={controlScheme !== 'game'}>
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
        </div>
      </div>
    </ScreenOverlay>
  )
}
