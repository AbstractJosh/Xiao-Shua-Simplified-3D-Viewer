import { Fragment } from 'react'
import { SCREENS, SCREEN_LABELS } from '../screens'
import { useTools } from '../store/toolStore'

/**
 * Which screen you are on, as a row of tabs at the left of the bar.
 *
 * TABS RATHER THAN A SEGMENTED CONTROL, and the difference is what they are
 * choosing between. `.seg` picks a VALUE -- a unit, a theme, a brush -- and
 * fills the chosen one with the accent to say "this is the setting". These pick
 * a PLACE: the whole window below changes, viewport and console together. So
 * they are drawn as tabs, lit by a bar sitting on the bar's own bottom border,
 * which is the one mark that ties a control to the thing underneath it.
 *
 * Beside the app's name rather than in the cluster on the right, because they
 * are the largest thing the bar decides -- the right-hand cluster acts on what
 * is on screen, and this chooses what is on screen at all. Identity first, then
 * where you are in it: the same order a browser puts a title before its tabs.
 *
 * Exactly one is on, and no code enforces it: the store holds ONE screen, so
 * choosing any of them is choosing against the rest.
 *
 * SET IN CAPITALS BY THE STYLESHEET, not by the labels. `SCREEN_LABELS` holds
 * "Modelling" because that is the screen's name, and a table of shouted strings
 * is a table nothing else can reuse -- a tooltip, a menu or a receipt would all
 * have to shout too. Casing is a way of DRAWING a word, so it is drawn here,
 * the same way the island's title and every console heading are.
 */
export function ScreenTabs() {
  const screen = useTools((s) => s.screen)
  const setScreen = useTools((s) => s.setScreen)

  return (
    <nav className="screen-tabs" aria-label="Screen">
      {SCREENS.map((id, index) => (
        <Fragment key={id}>
          {/* A hairline between one tab and the next: the smallest of the bar's
              three, because it divides two items of one kind where the others
              divide whole groups. See `.screen-tab-rule`. */}
          {index > 0 && <span className="screen-tab-rule" aria-hidden />}
          <button
            type="button"
            className="screen-tab"
            // `aria-current`, not `aria-pressed`: these are not switches that
            // are on or off, they are places, and exactly one of them is where
            // you are. It is the attribute a set of navigation links uses, and
            // the stylesheet lights the tab off it.
            aria-current={screen === id ? 'page' : undefined}
            onClick={() => setScreen(id)}
          >
            {SCREEN_LABELS[id]}
          </button>
        </Fragment>
      ))}
    </nav>
  )
}
