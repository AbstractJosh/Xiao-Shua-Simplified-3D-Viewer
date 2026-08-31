import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { HELP_SECTIONS } from '../helpTopics'
import { useTools } from '../store/toolStore'

/**
 * How long the screen takes to leave, in milliseconds.
 *
 * Named here and handed to the stylesheet as a custom property rather than
 * stated in both places. The fade is a CSS animation, but React is what decides
 * when the element stops existing, and the two have to agree exactly: a
 * stylesheet edited to 200ms against a component that unmounts at 110 cuts the
 * card off mid-fade, and the reverse leaves a finished animation sitting on
 * screen. One number, read by both.
 *
 * Shorter than the 140ms entrance on purpose. An entrance is announcing
 * something and can afford to be watched arriving; an exit is getting out of
 * the way of whatever you just pressed to dismiss it, and every millisecond of
 * it is time spent waiting to have the app back.
 */
const HELP_EXIT_MS = 110

/**
 * The manual, as a screen over the whole app rather than a menu hanging off a
 * button.
 *
 * WHY IT LEFT THE BAR. Help was a `nav-panel` like Snap's or Export's -- a
 * 330px column dropped under the button, holding sixty sentences behind a
 * scrollbar. Every other panel in the bar is a handful of controls you aim and
 * dismiss, and Help is the one thing up there that is READ. At that width the
 * lines wrapped after nine or ten words, there was no room for a heading beside
 * a paragraph, and the whole document had to be scrolled past to reach the one
 * line you wanted. None of that is a styling problem: a document does not fit
 * in a dropdown, and giving it the window is what lets it be structured at all.
 *
 * WHAT THE SHAPE BUYS. Two columns. The rail on the left is the table of
 * contents and the only navigation there is; the pane on the right is one
 * section at a time. Showing one section rather than the whole book behind
 * anchor links is the deliberate half: eight short pages can each be read to
 * the end, where one long page is scrolled through and abandoned. The rail
 * carries a count per section so the length of what you are about to open is
 * visible before you open it.
 *
 * WHICH SECTION IS OPEN LIVES IN THE STORE, not in a `useState` here, for the
 * reason `openPanel` does: the whole UI stays a pure function of store state,
 * so `ui-check` can walk every section headlessly and assert what each one says
 * -- which is the only way a help screen stays true as the app changes under
 * it. A component-local state would have made seven of the eight sections
 * unreachable to any test.
 *
 * OPENING AND CLOSING is `openPanel === 'help'`, the same field every other
 * tool panel uses. That is what gives the screen Escape and click-outside for
 * free, off the one handler in `NavBar` -- and it is why the backdrop is
 * deliberately NOT in that handler's list of what counts as inside: a press on
 * the dark surround falls through to it and closes the screen, which is what a
 * dark surround is for.
 */
export function HelpScreen() {
  const open = useTools((s) => s.openPanel === 'help')
  const chosen = useTools((s) => s.helpSection)
  const setHelpSection = useTools((s) => s.setHelpSection)
  const setOpenPanel = useTools((s) => s.setOpenPanel)

  /**
   * Whether the screen is still mounted ONLY to finish leaving.
   *
   * The dialog is driven by `openPanel`, which goes null the instant anything
   * dismisses it -- so the card used to be simply gone between two frames.
   * An entrance animation with no exit is worse than neither: the thing you
   * watched arrive blinks out, and the eye reports that as a glitch rather than
   * as speed. React has to be told to keep the element for the length of the
   * fade, because CSS cannot animate a node that no longer exists.
   *
   * Local state rather than a field in the store, and it is the one piece of
   * this screen that should be. `helpSection` is in the store because a check
   * has to drive it; this is a few frames of paint that nothing outside this
   * component can act on, and putting it in the store would mean an exit
   * animation could leave a stale flag behind that reopens the screen mid-fade.
   */
  const [leaving, setLeaving] = useState(false)
  const wasOpen = useRef(open)

  /*
   * DERIVED DURING RENDER, NOT IN AN EFFECT, and that is the whole of the fix
   * for a real bug rather than a style preference.
   *
   * The first version of this set `leaving` from a `useEffect`. An effect runs
   * AFTER React has committed the render it belongs to -- and that render, with
   * `open` already false and `leaving` still false, returned null. So closing
   * the screen tore the card out of the DOM and rebuilt it one frame later
   * wearing the leaving class. A DevTools mutation watcher showed it exactly:
   *
   *     -backdrop @4ms, +backdrop @5ms, -backdrop @117ms
   *
   * The rebuild is a NEW node, so everything the old one was holding goes with
   * it: the pane's scroll position snaps back to the top mid-fade, and the
   * opacity restarts rather than continuing. That jump is what reads as the
   * screen glitching out -- the animation itself was fine.
   *
   * Setting state during render is the supported way to derive state from a
   * changing input: React re-runs this function immediately and throws the
   * first pass away, so nothing is committed and nothing is painted in between.
   * The same DOM node simply gains a class, which is what an exit animation
   * needs to be given.
   *
   * `isLeaving` is read rather than `leaving` for the rest of this render,
   * because `leaving` still holds the previous value in the pass that schedules
   * it -- and the early return below has to agree with the class name above.
   */
  let isLeaving = leaving
  if (wasOpen.current !== open) {
    wasOpen.current = open
    // Closing starts the exit; reopening cancels one in flight, so pressing
    // Help again mid-fade does not bring the card back still fading out.
    isLeaving = !open
    setLeaving(isLeaving)
  }

  // The unmount, once the fade has had its time. Keyed on `leaving` rather than
  // on `open` so that reopening -- which sets it false -- clears the timer
  // through this effect's own cleanup.
  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => setLeaving(false), HELP_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [leaving])

  if (!open && !isLeaving) return null

  // Falls back rather than throwing. The id in the store is typed, so this can
  // only be reached by a section being deleted while its id is still held --
  // and a Help screen that renders the first page is a better answer to that
  // than one that takes the app down.
  const section = HELP_SECTIONS.find((s) => s.id === chosen) ?? HELP_SECTIONS[0]

  return (
    <div
      className={`help-backdrop${isLeaving ? ' help-leaving' : ''}`}
      style={{ '--help-exit': `${HELP_EXIT_MS}ms` } as CSSProperties}
      // On its way out it is no longer a dialog anybody can use: it takes no
      // clicks and is not announced. It is a picture of one, being taken away.
      aria-hidden={isLeaving || undefined}
    >
      <div
        className="help-screen"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-screen-title"
      >
        <div className="help-head">
          <div className="help-head-text">
            <h2 className="help-screen-title" id="help-screen-title">
              Controls
            </h2>
            <p className="help-lede">What each tool does, and how to work in each viewport.</p>
          </div>
          <button
            type="button"
            className="help-close"
            aria-label="Close help"
            onClick={() => setOpenPanel(null)}
          >
            <svg viewBox="0 0 10 10" aria-hidden>
              <path
                d="M2.4 2.4 L7.6 7.6 M7.6 2.4 L2.4 7.6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="help-columns">
          {/* Buttons rather than links. There is nothing to navigate TO -- no
              URL, no anchor, no history worth pushing -- so a link would be a
              lie about what pressing one does. `aria-pressed` says which page
              you are on, which is the same thing the accent bar says visually. */}
          <nav className="help-rail" aria-label="Help sections">
            {HELP_SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`help-rail-btn${s.id === section.id ? ' help-rail-on' : ''}`}
                aria-pressed={s.id === section.id}
                onClick={() => setHelpSection(s.id)}
              >
                <span className="help-rail-name">{s.title}</span>
                <span className="help-rail-count">{s.entries.length}</span>
              </button>
            ))}
          </nav>

          {/* Keyed by the section, so switching pages remounts the column and
              hands it back scrolled to the top. Without that, opening a short
              section after a long one lands you halfway down an empty page. */}
          <div className="help-pane" key={section.id}>
            <header className="help-pane-head">
              <h3 className="help-pane-title">{section.title}</h3>
              <p className="help-pane-blurb">{section.blurb}</p>
            </header>

            <ul className="help-entries">
              {section.entries.map((entry) => (
                <li className="help-entry" key={entry.title}>
                  <h4 className="help-entry-title">
                    {entry.title}
                    {entry.key && <kbd className="help-key">{entry.key}</kbd>}
                  </h4>
                  {entry.summary && <p className="help-text">{entry.summary}</p>}

                  {/* The gestures, as a two-column grid rather than as
                      sentences. `dl` because that is what this is: a term and
                      what it means. The verb column is what the eye runs down,
                      so it is the one that stays narrow and left-aligned. */}
                  {entry.steps && (
                    <dl className="help-steps">
                      {entry.steps.map((step, i) => (
                        <div className="help-step" key={i}>
                          <dt className="help-step-do">{step.action}</dt>
                          <dd className="help-step-is">{step.result}</dd>
                        </div>
                      ))}
                    </dl>
                  )}

                  {/* Last, and marked off by a rule down its left edge: a note
                      is the thing you did not come looking for, so it must not
                      sit in the way of the thing you did. */}
                  {entry.notes?.map((note, i) => (
                    <p className="help-note" key={i}>
                      {note}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
