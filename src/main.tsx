import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { remember } from './store/persist'
import { resume } from './store/projectStore'

/**
 * Preferences and the shelf, back from last time, BEFORE the first render.
 *
 * Here rather than in an effect inside `App`, and the theme is the reason:
 * an effect runs after the first paint, so a user who chose Light would watch
 * the window come up dark and flip. This half of the restore is synchronous
 * and lands before React has drawn anything. See `persist.ts`.
 */
remember()

/**
 * And the projects, which is WORK and is therefore restored on different terms.
 *
 * AFTER `remember`, and the order is load-bearing rather than tidy. The
 * preferences half above is synchronous and carries `openTo` -- the setting
 * that says whether the app should open at the front door or walk straight
 * through to the last project. Reading the projects first would mean deciding
 * where to open before knowing where the user asked to open.
 *
 * Nothing here blocks the first paint. The app comes up at the front door
 * because that is the store's own initial state, so a slow disk shows an empty
 * navigator filling in rather than a blank window. See `projectStore.ts`.
 */
resume()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
