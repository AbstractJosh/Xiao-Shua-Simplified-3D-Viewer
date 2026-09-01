import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useTools } from '../store/toolStore'
import type { NavPanel } from '../store/toolStore'

/**
 * How long a screen takes to leave, in milliseconds.
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
export const OVERLAY_EXIT_MS = 110

/**
 * A screen over the whole app: the backdrop, the card, the lid with a title and
 * a way out, and the few frames it takes to arrive and leave.
 *
 * WHY IT IS ITS OWN COMPONENT. Help was the first thing here that outgrew a
 * dropdown, and Settings is the second -- so the shell stopped being part of
 * Help and became the thing both of them are. What is shared is not the styling
 * so much as the TIMING: the derive-during-render exit below is subtle enough
 * that a second copy of it would be a second chance to get it wrong, and the
 * two screens would drift apart in exactly the way the eye notices.
 *
 * WHAT IS NOT IN HERE is everything about what a screen SAYS. This takes an id,
 * a title, a sentence and its contents; Help's two columns and Settings' rows
 * of preferences are their own files, because a shell that knew about either
 * would be a shell only those two could use.
 *
 * OPENING AND CLOSING is `openPanel === id`, the same field every tool panel in
 * the bar uses. That is what gives a screen Escape and click-outside for free,
 * off the one handler in `NavBar` -- and it is why the backdrop is deliberately
 * NOT in that handler's list of what counts as inside: a press on the dark
 * surround falls through to it and closes the screen, which is what a dark
 * surround is for. The CARD wears `overlay-card`, which is the class that
 * handler names, so a screen added here is dismissable without editing it.
 */
export function ScreenOverlay({
  id,
  card,
  title,
  lede,
  closeLabel,
  children,
}: {
  /** The panel id this screen answers to. Opened by pressing its button. */
  id: NonNullable<NavPanel>
  /**
   * The card's own class, which is where its SIZE lives.
   *
   * The one thing two screens cannot share. Help is a document and takes a
   * reading width and a fixed height, so turning its pages does not resize the
   * window; Settings is a short list and would be a mostly empty 720px box at
   * the same measure. Everything else about the card -- the surface, the
   * border, the motion -- is `overlay-card` and is the same for both.
   */
  card: string
  title: string
  /**
   * One sentence under the title saying what the screen is for.
   *
   * OPTIONAL, and left off by Settings. Help is a document, so a line saying
   * what the document covers is part of it; a screen that is nothing but
   * controls does not get explained above them -- see `CLAUDE.md`. The head
   * closes up around the title when there is none rather than leaving a gap
   * where a sentence used to be.
   */
  lede?: string
  /** What the close cross is called, since the cross itself says nothing. */
  closeLabel: string
  children: ReactNode
}) {
  const open = useTools((s) => s.openPanel === id)
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
   * Local state rather than a field in the store, and it is the one piece of a
   * screen that should be. `helpSection` is in the store because a check has to
   * drive it; this is a few frames of paint that nothing outside this component
   * can act on, and putting it in the store would mean an exit animation could
   * leave a stale flag behind that reopens the screen mid-fade.
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
    // Closing starts the exit; reopening cancels one in flight, so pressing the
    // button again mid-fade does not bring the card back still fading out.
    isLeaving = !open
    setLeaving(isLeaving)
  }

  // The unmount, once the fade has had its time. Keyed on `leaving` rather than
  // on `open` so that reopening -- which sets it false -- clears the timer
  // through this effect's own cleanup.
  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => setLeaving(false), OVERLAY_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [leaving])

  if (!open && !isLeaving) return null

  return (
    <div
      className={`overlay-backdrop${isLeaving ? ' overlay-leaving' : ''}`}
      style={{ '--overlay-exit': `${OVERLAY_EXIT_MS}ms` } as CSSProperties}
      // On its way out it is no longer a dialog anybody can use: it takes no
      // clicks and is not announced. It is a picture of one, being taken away.
      aria-hidden={isLeaving || undefined}
    >
      <div
        className={`overlay-card ${card}`}
        role="dialog"
        aria-modal="true"
        // Named off the heading rather than by a hand-written label, so the
        // word a screen reader announces is the word on screen. The id is built
        // from the panel id, which is already unique across the app.
        aria-labelledby={`${id}-screen-title`}
      >
        <div className="overlay-head">
          <div className="overlay-head-text">
            <h2 className="overlay-title" id={`${id}-screen-title`}>
              {title}
            </h2>
            {lede && <p className="overlay-lede">{lede}</p>}
          </div>
          <button
            type="button"
            className="overlay-close"
            aria-label={closeLabel}
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

        {children}
      </div>
    </div>
  )
}
