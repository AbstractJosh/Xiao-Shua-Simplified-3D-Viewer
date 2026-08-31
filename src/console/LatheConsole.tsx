import { BasePanel } from './BasePanel'
import { ClipboardPanel } from './ClipboardPanel'

/**
 * The console beside the Lathe viewport: what the piece is, and where it goes.
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
 * BASE IS THE LATHE'S OWN, and it is BELOW the shelf. The Clipboard is the
 * panel both screens carry, so it keeps the place it has next door -- first,
 * at the top -- and the console reads the same on arrival whichever tab you
 * came from. What is particular to a screen goes under what is shared: a panel
 * that shoved the Clipboard down a screen's worth would make the two consoles
 * disagree about where the one thing they have in common lives.
 *
 * It is in the console rather than over the viewport for the reason the panel
 * itself sets out: the base shape is the one fact about the piece the side view
 * cannot show, so there is nothing for a control over the drawing to sit
 * beside. See `BasePanel`.
 *
 * WHERE THE LATHE'S OTHER CONTROLS WENT, since they are still not here: the two
 * tools are on the island over the piece, because they are aimed by pointing
 * at it, and the stock is in a corner panel over the clay, because a size is
 * typed while watching the shape it grows. The console is for what a screen
 * CONTAINS, which is why the lump's section ended up in it and its handles did
 * not.
 *
 * Its own component rather than `Console` with a flag, because a flag would
 * make the two consoles one component that is sometimes most of itself. They
 * are different consoles that happen to share a panel today, and -- Base being
 * the first panel that is this screen's alone -- they will share less as Lathe
 * grows.
 */
export function LatheConsole() {
  return (
    <aside className="console">
      <ClipboardPanel />
      <BasePanel />
    </aside>
  )
}
