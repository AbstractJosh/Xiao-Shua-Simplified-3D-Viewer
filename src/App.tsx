import { useEffect } from 'react'
import type { ComponentType } from 'react'
import { Console } from './console/Console'
import { HelpScreen } from './console/HelpScreen'
import { NavBar } from './console/NavBar'
import { SettingsScreen } from './console/SettingsScreen'
import { LaserConsole } from './console/LaserConsole'
import { LatheConsole } from './console/LatheConsole'
import type { ScreenId } from './screens'
import { useTools } from './store/toolStore'
import { THEME_ATTRIBUTE } from './theme'
import { LaserViewport } from './viewport/LaserViewport'
import { LatheViewport } from './viewport/LatheViewport'
import { Viewport } from './viewport/Viewport'

/**
 * Writes the chosen theme where the stylesheet can read it.
 *
 * On the document element rather than on `.app`, because the two surfaces the
 * app does not own are painted from there: the page background behind the
 * canvas, and the scrollbars, which take their light or dark from
 * `color-scheme` on `:root`.
 *
 * `index.html` ships with the default already set, so this only ever changes an
 * attribute that is correct at first paint -- it never has to install one, and
 * there is no frame in which the app is unthemed.
 */
function useTheme() {
  const theme = useTools((s) => s.theme)
  useEffect(() => {
    document.documentElement.setAttribute(THEME_ATTRIBUTE, theme)
  }, [theme])
}

/**
 * WHAT EACH SCREEN MOUNTS: one viewport, and the console that drives it.
 *
 * The one thing `screens.ts` deliberately does not hold, because it is the one
 * thing that needs components -- that file is plain data so the store and the
 * check suite can read it without dragging a canvas along. Keyed by `ScreenId`
 * rather than a lookup with a fallback, so a screen added to that table and
 * forgotten here is a type error rather than a blank window.
 *
 * A SCREEN IS A PAIR, not a viewport with a console bolted beside it. The two
 * halves are chosen together because they are two halves of one working
 * surface: Lathe's console holds the Clipboard and its own Base precisely
 * because Lathe's viewport draws a lump and no document, and neither of those
 * facts makes sense without the other.
 */
const SCREEN_PARTS: Record<ScreenId, { Viewport: ComponentType; Console: ComponentType }> = {
  modelling: { Viewport, Console },
  lathe: { Viewport: LatheViewport, Console: LatheConsole },
  laser: { Viewport: LaserViewport, Console: LaserConsole },
}

/**
 * Two halves, split by what they are about. The bar across the top holds the
 * tools -- how you work, and what leaves the app. The console on the right holds
 * the document: what you can drop in, what is selected, and what the scene now
 * contains. Nothing appears in both.
 *
 * Which PAIR of halves is on show is the screen -- see `SCREEN_PARTS`. Only the
 * chosen one is mounted, so there is never a second WebGL context standing idle
 * behind a hidden canvas: a browser hands out somewhere between eight and
 * sixteen, and the clipboard's live thumbnails are already spending three. The
 * Lathe screen costs none of them at all -- it draws its piece as one SVG path,
 * because a solid of revolution seen from the side hides nothing. The Laser
 * Cutter spends two, the scene and the compass beside it, exactly as Modelling
 * does: a block seen square on from a chosen face is still a solid, and which
 * face is chosen is the whole of what the screen is about.
 */
export default function App() {
  useTheme()
  const screen = useTools((s) => s.screen)
  const { Viewport: ScreenViewport, Console: ScreenConsole } = SCREEN_PARTS[screen]

  return (
    <div className="app">
      <NavBar />

      {/* Keyed by the screen, so switching is a fresh mount of both halves
          rather than React reconciling one viewport into another -- two
          `<Canvas>` elements in the same slot would otherwise try to share a
          renderer built for a different scene. */}
      <main className="main" key={screen}>
        <ScreenViewport />
        <ScreenConsole />
      </main>

      {/* Outside the bar, though the buttons that open them are in the bar. Two
          reasons, and the second is load-bearing. They cover the whole app, so
          nesting one in a 44px-tall header would put a full-window overlay
          inside the one element in the layout that must not grow. And the
          bar's own click-outside handler treats everything under `.topbar` as
          inside itself -- so a backdrop mounted there could never be pressed to
          dismiss what it is behind. Each renders nothing until its own button
          is pressed, and only one can be open at a time: both answer to
          `openPanel`, which holds one id. */}
      <HelpScreen />
      <SettingsScreen />
    </div>
  )
}
