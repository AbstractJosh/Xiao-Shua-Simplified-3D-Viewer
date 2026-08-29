import { ClipboardPanel } from './ClipboardPanel'

/**
 * The console beside the Lathe viewport: the Clipboard, and nothing else.
 *
 * EACH SCREEN HAS ITS OWN CONSOLE, and this is the first proof that they are
 * not obliged to hold the same panels. The modelling console's other four --
 * Solids, Shapes, Colour, Scene -- are all about a document this screen does
 * not draw: a palette that drops a cube into a scene you cannot see would be a
 * control that appears to do nothing.
 *
 * The Clipboard crosses over because what you have saved is YOURS rather than
 * the scene's. It is already the one panel in the modelling console that is not a
 * readout of the document -- it survives the document being replaced, and it
 * lives outside `Doc` for exactly that reason -- so it is the panel that makes
 * sense wherever you happen to be working, and it is the shelf anything this
 * screen eventually turns out would be kept on.
 *
 * WHERE THE LATHE'S OWN CONTROLS WENT, since none of them are here: the two
 * tools are on the island over the piece, because they are aimed by pointing
 * at it, and the stock is in the bar beside Snap, because it is a fact about
 * the screen rather than a thing you hold. The console is for what a screen
 * CONTAINS, and what this one contains is one lump that needs no listing.
 *
 * Its own component rather than `Console` with a flag, because a flag would
 * make the two consoles one component that is sometimes most of itself. They
 * are different consoles that happen to share a panel today, and they will
 * share less as Lathe grows.
 */
export function LatheConsole() {
  return (
    <aside className="console">
      <ClipboardPanel />
    </aside>
  )
}
