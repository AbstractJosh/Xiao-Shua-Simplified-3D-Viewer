import { useEffect } from 'react'
import { Console } from './console/Console'
import { HelpScreen } from './console/HelpScreen'
import { NavBar } from './console/NavBar'
import { useTools } from './store/toolStore'
import { THEME_ATTRIBUTE } from './theme'
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
 * Two halves, split by what they are about. The bar across the top holds the
 * tools -- how you work, and what leaves the app. The console on the right holds
 * the document: what you can drop in, what is selected, and what the scene now
 * contains. Nothing appears in both.
 */
export default function App() {
  useTheme()

  return (
    <div className="app">
      <NavBar />

      <main className="main">
        <Viewport />
        <Console />
      </main>

      {/* Outside the bar, though the button that opens it is in the bar. Two
          reasons, and the second is load-bearing. It covers the whole app, so
          nesting it in a 44px-tall header would put a full-window overlay
          inside the one element in the layout that must not grow. And the
          bar's own click-outside handler treats everything under `.topbar` as
          inside itself -- so a backdrop mounted there could never be pressed to
          dismiss what it is behind. It renders nothing unless Help is open. */}
      <HelpScreen />
    </div>
  )
}
