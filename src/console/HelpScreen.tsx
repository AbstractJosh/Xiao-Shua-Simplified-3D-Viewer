import { HELP_SECTIONS } from '../helpTopics'
import { useTools } from '../store/toolStore'
import { ScreenOverlay } from './ScreenOverlay'

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
 * THE SHELL AROUND IT -- the backdrop, the card, the lid and the few frames it
 * takes to arrive and leave -- is `ScreenOverlay`, which Settings wears too.
 * What is left in this file is what Help alone knows: its rail, its pages, and
 * which page is open.
 */
export function HelpScreen() {
  const chosen = useTools((s) => s.helpSection)
  const setHelpSection = useTools((s) => s.setHelpSection)

  // Falls back rather than throwing. The id in the store is typed, so this can
  // only be reached by a section being deleted while its id is still held --
  // and a Help screen that renders the first page is a better answer to that
  // than one that takes the app down.
  const section = HELP_SECTIONS.find((s) => s.id === chosen) ?? HELP_SECTIONS[0]

  return (
    <ScreenOverlay
      id="help"
      card="help-screen"
      title="Controls"
      lede="What each tool does, and how to work in each viewport."
      closeLabel="Close help"
    >
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
    </ScreenOverlay>
  )
}
