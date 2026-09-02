import type { ReactNode } from 'react'

/**
 * What the app does, written to be SCANNED rather than read.
 *
 * WHY THIS IS DATA AND NOT MARKUP. It used to be sixty-odd `<li>`s inside
 * `HelpTool`, in the order the features were built. A list that long has no
 * shape: "how do I melt something" and "how do I pan" sit a line apart, and the
 * only way to find either is to read the whole thing. Pulling the copy out is
 * what makes a shape possible -- the screen renders a structure instead of
 * holding one implicitly.
 *
 * WHY AN ENTRY IS THREE FIELDS AND NOT ONE BLOB. The paragraphs this replaced
 * were true and unreadable: each gesture was buried in a sentence that also
 * explained why the gesture is the way it is, so finding "which button pans"
 * meant reading nine lines about what a pan is for. The three fields are the
 * three questions actually asked, in the order they are asked:
 *
 *     summary   what is this -- one line, never two
 *     steps     how do I use it -- one row per gesture, the verb on the left
 *     notes     what will surprise me -- and nothing else
 *
 * The `steps` grid does most of the work. A gesture in a table is found at a
 * glance; the same gesture in prose has to be parsed. So anything that fits a
 * row goes in a row, and prose is left to say only what a row cannot.
 *
 * THE RULE FOR NOTES, since that field is where the verbosity would come back:
 * a note earns its place only if a user would otherwise learn the fact by being
 * surprised by it -- the torch burning through a wall, the brushes being
 * exclusive, a confirmed sketch not coming back. Design reasoning belongs in a
 * code comment beside the code, not on this screen.
 *
 * It sits at `src/` rather than under `console/` for the reason `theme.ts` does:
 * the store holds which section is open, and a store reaching down into a
 * component folder for a type is the wrong direction.
 *
 * Every claim in here is a claim about behaviour, so a line that stops being
 * true is a bug in this file rather than a matter of taste.
 */

/** One gesture: what you do, and what it does. */
export type HelpStep = {
  /** The gesture or the control, e.g. "Middle-drag" or "Brush size". */
  action: ReactNode
  /** What happens. One line. */
  result: ReactNode
}

/** One thing the app has, named the way the app names it. */
export type HelpEntry = {
  /** The subtitle. The app's own word for the thing, so it can be looked for. */
  title: string
  /**
   * The keyboard shortcut, if it has one, drawn as a chip beside the title.
   *
   * Beside the name rather than inside a sentence: a shortcut is the one part
   * of an entry that is scanned for and never read.
   */
  key?: string
  /** What it is, in one line. */
  summary?: ReactNode
  /** How it is used, a row per gesture. */
  steps?: HelpStep[]
  /** What would otherwise surprise you. Nothing else. */
  notes?: ReactNode[]
}

export type HelpSectionId =
  | 'projects'
  | 'view'
  | 'build'
  | 'select'
  | 'gizmo'
  | 'tools'
  | 'sketch'
  | 'lathe'
  | 'reference'
  | 'files'
  | 'shortcuts'

/** One thing you might be trying to do, and everything that serves it. */
export type HelpSection = {
  id: HelpSectionId
  /** The category, as the rail shows it. */
  title: string
  /** One line under the heading, saying what the category covers. */
  blurb: string
  entries: HelpEntry[]
}

/**
 * The sections, in the order the rail shows them.
 *
 * Ordered by when a person meets them. Projects first, because the app opens on
 * the front door and nothing else can be reached until one is chosen. Then: you
 * look before you build, you build before you have anything to select, you
 * select before you can reach a gizmo, and the gizmo is what every tool in Tools
 * then borrows. Colour and files come last, being the only things here that
 * outlive the document.
 */
export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'projects',
    title: 'Projects',
    blurb: 'What the app keeps for you between visits, and how to have more than one of it.',
    entries: [
      {
        title: 'What a project is',
        summary:
          'All three benches under one name: the scene you are modelling, the piece on the lathe, and the block on the laser cutter. Opening one puts the whole workshop back as you left it, at the bench you left it at.',
        notes: [
          <>
            <b>What does not go in one.</b> Solids saved to the shelf, the clipboard and uploaded
            reference pictures follow YOU rather than a project -- they are yours in every project,
            which is the whole reason for saving one. Neither do the undo stacks: a project opened
            cold is a fresh start on old work, not a session you can rewind into.
          </>,
        ],
      },
      {
        title: 'The Welcome screen',
        summary: (
          <>
            Press the app&rsquo;s name at the top left. It lists every project you have; press one
            to open it.
          </>
        ),
        steps: [
          { action: 'New Project', result: 'An empty workshop, opened at the modelling bench.' },
          { action: 'Rename', result: 'Types over the name in place. Enter keeps it, Escape does not.' },
          { action: 'Copy', result: 'A fork under a new name, taken as the workshop stands right now.' },
          { action: 'Delete', result: 'Asks once -- the button becomes Delete? -- then goes. It cannot be undone.' },
        ],
        notes: [
          <>
            <b>Most of the bar goes quiet here.</b> The screen tabs, Export, Snap, Undo, Redo and
            the counts all act on a bench, and with no project open there is no bench to act on.
            Import stays live: a model file opened here becomes a new project named after the file.
          </>,
        ],
      },
      {
        title: 'Saving',
        summary:
          'There is no Save button. Whichever project is open is written as you work, so a refresh, a closed tab or a flat battery costs nothing.',
        notes: [
          <>
            <b>Copy is the one you press on purpose.</b> Saving keeps the project up to date;
            copying keeps a MOMENT -- the workshop as it stands, forked under a new name, before you
            do something you might not want. It is on the Welcome screen, on the project&rsquo;s own
            row.
          </>,
        ],
      },
      {
        title: 'Open to',
        summary: (
          <>
            <b>Settings</b>, the cog at the end of the bar. <b>Welcome screen</b> opens the app on
            the front door; <b>Recent project</b> goes straight back into the one you had open.
          </>
        ),
      },
    ],
  },
  {
    id: 'view',
    title: 'Viewports',
    blurb: 'The three screens, and how to look around each one. None of it touches the model.',
    entries: [
      {
        title: 'Screens',
        summary: 'The tabs at the left of the top bar swap the viewport and its console together.',
        steps: [
          { action: 'Modelling', result: 'The scene: solids, sketches, gizmos and the brushes.' },
          { action: 'Lathe', result: 'One lump of clay, shaped by pushing and pulling its wall.' },
          {
            action: 'Laser Cutter',
            result: 'One block of stock, seen square on to whichever face you pick.',
          },
        ],
        notes: [
          <>
            Import, Export, Snap and the counts dim on any screen with no scene for them to act on,
            which is both of the ones after Modelling. Undo and redo walk whichever screen you are
            on. The Clipboard is on all three.
          </>,
        ],
      },
      {
        title: 'The Modelling layout',
        summary: 'Four places things live.',
        steps: [
          { action: 'Top bar', result: 'Import, Export, Snap, undo, redo and Settings.' },
          { action: 'Console, on the right', result: 'Clipboard, Solids, Shapes, Colour, Scene.' },
          { action: 'Tools island', result: 'The gizmos, Mirror, Ruler, Cut and the three brushes.' },
          { action: 'Bottom right', result: 'Position, rotation and size of what is selected.' },
        ],
      },
      {
        title: 'Orbit, pan and zoom',
        steps: [
          {
            action: 'Middle-drag',
            result: 'Orbit. Alt+left-drag does the same with no middle button.',
          },
          {
            action: 'Right-drag empty space',
            result: 'Pan. On an object, right-click opens its menu instead.',
          },
          { action: 'Scroll', result: 'Zoom.' },
        ],
      },
      {
        title: 'The axis compass',
        summary: 'The cube in the corner, saying which way is which.',
        steps: [
          { action: 'Drag it', result: 'Orbits by hand: half a turn across the widget.' },
          { action: 'Click a ball or a face', result: 'Flies square-on to that view.' },
        ],
      },
      {
        title: 'The laser cutter view',
        summary:
          'Square on, always. The camera turns freely while you hold it and comes to rest on the nearest face the moment you let go -- by the compass or by middle-drag, it settles either way, so what you draw on is never foreshortened.',
        steps: [
          { action: 'Click a ball or a face', result: 'Flies square-on to that view.' },
          { action: 'Drag the compass', result: 'Turns by hand, then settles on the nearest face.' },
          {
            action: 'Middle-drag',
            result: 'Orbits, then settles on the nearest face. No Alt+left here -- left draws the cut.',
          },
          { action: 'Scroll', result: 'Zoom. It cannot tip the view off a face.' },
          {
            action: 'Right-drag',
            result:
              'Slides the view across the face, so a zoomed-in corner can be reached. It stops at the edges of the face, and turning to another face puts it back on the middle.',
          },
        ],
        notes: [
          <>
            The block is set by <b>The block</b>, bottom left: <b>Width</b>, <b>Height</b> and{' '}
            <b>Depth</b>, each on its own, so the stock can be a sheet or a bar rather than only a
            cube. It grows from its own footprint against a camera that stays put, so a bigger
            block really does look bigger, and cuts already made are carried with it.
          </>,
          <>
            The same panel holds the two ways back, and each takes only its own.{' '}
            <b>Reset block</b> puts one uncut ten-centimetre block on the bed and leaves the
            drawings where they are -- <b>Ctrl+Z</b> gives back the cuts and the size together.{' '}
            <b>Reset references</b> takes every drawing off the block, in every preset, and leaves
            the pictures in the Reference panel to be dropped on again. Both are dead while there
            is nothing for them to do.
          </>,
        ],
      },
      {
        title: 'Cutting the block',
        summary:
          'Two tools, both drawing one line on the face you are square on to. An open line is carried on to the border at both ends, so any stroke goes all the way across; a closed one cuts out what it encircles. Either way the cut burns through the whole block.',
        steps: [
          { action: 'Freehand', result: 'Drag to draw the line by hand.' },
          {
            action: 'Point Cut',
            result: 'Click to place points, drag one to move it. The line runs through them.',
          },
          {
            action: 'Close the loop',
            result:
              'Point Cut: click the first point -- from three points on it wears a ring -- and the line bridges back round to it. Clicking it again opens the line. Dragging it still moves it.',
          },
          {
            action: 'Encircle by hand',
            result:
              'Freehand: draw a ring and finish near where you started. The line bridges shut on screen, and the cut drops what it surrounds out as its own piece. Stop well short and it stays an open line, carried on to the border at both ends.',
          },
          {
            action: 'With Snap on',
            result:
              "A point placed or dragged lines up with another point's row or column, and a hairline says which it caught. Set the reach under Snap in the bar -- it is in pixels here, and separate from the modelling screen's.",
          },
          { action: 'Apply cut', result: 'Burns the line and separates what it crossed.' },
          { action: 'Reset line', result: 'Throws the drawing away. Escape does the same.' },
          {
            action: 'Keep the rest',
            result:
              'Swaps the choice over: what was lit is kept, what was kept is lit. With no tool in hand, clicking a piece lights it or puts it out one at a time.',
          },
          { action: 'Discard pieces', result: 'Throws the lit ones away. Del does the same.' },
        ],
        notes: [
          <>
            The pieces stay exactly where the block was, a kerf apart, and the ones that are{' '}
            <b>lit</b> are the ones <b>Del</b> throws away. What decides it is the MIDDLE: the
            piece under the middle of your reference picture is the part you are making, and
            everything else on the bed is offcut. With no picture on the face, the middle of the
            face itself is used.
          </>,
          <>
            That is why a stroke that runs off the face and back on is no different from any other.
            It cuts three pieces rather than two, the one under the drawing is kept, and the other
            two light up together and go with one <b>Del</b>. The same holds for four, or five.
          </>,
          <>
            The rule is a rule, not a verdict. <b>Keep the rest</b> turns it inside out in one
            press, which is what you want when the line was drawn round a HOLE rather than round a
            part. And with no tool in hand, clicking a piece lights it or puts it out on its own --
            so a piece the rule kept can be sent to the waste, and one it lit can be rescued. The
            last unlit piece cannot be lit: something always survives the cut.
          </>,
          <>
            A closed line does not reach for the border, because it does not need to: it already
            has an inside and an outside. What it cuts out is the piece it drew round, which comes
            away as its own piece -- and if you drew round your reference, that island is the one
            the cut KEEPS, with the stock around it lit. So encircling a shape and pressing{' '}
            <b>Del</b> frees the part from the stock; to punch a hole instead, press{' '}
            <b>Keep the rest</b> first. A loop drawn half off the edge takes the bite that was on
            the block. Both tools close a loop, and each in the way its own gesture allows:{' '}
            <b>Point Cut</b> when you click its first point, <b>Freehand</b> when the stroke comes
            back to where it began -- the line bridges shut on screen as soon as it is near
            enough, so you can see it happen before you press Apply.
          </>,
          <>
            A cut is BAKED. There is no list to reopen -- <b>Ctrl+Z</b> is the way back, and one cut
            is one step. Turning the compass to another face clears whatever you were drawing,
            because a line belongs to the face it was drawn on.
          </>,
        ],
      },
      {
        title: 'Steadying the line',
        summary:
          'Freehand pulls the tool along behind the pointer on a rope. Small wobbles inside the slack move nothing at all; a long pull is followed exactly.',
        steps: [
          { action: 'Smoothing at 0', result: 'The line is exactly where you point.' },
          { action: 'At a third', result: 'Where it rests. Takes a hand tremor out.' },
          { action: 'At 1', result: 'An eighth of the block of rope. Slow, and very steady.' },
        ],
        notes: [
          <>
            What is recorded is where the TOOL went, not where the hand went -- so the line you can
            see is the line that gets cut.
          </>,
        ],
      },
      {
        title: 'Joining up the points',
        summary:
          'Fit to line is a switch: off, the points are joined with straight segments; on, a smooth curve runs through them. The points survive it either way.',
        steps: [
          { action: 'Fit to line: Off', result: 'Segments from point to point. What you placed is cut.' },
          { action: 'Fit to line: On', result: 'A smooth curve through every point, with a handle on each.' },
          { action: 'Drag a point', result: 'Moves it, curve or no curve.' },
          { action: 'Drag a handle', result: "Aims that point's tangent. It stays where you put it." },
        ],
        notes: [
          <>
            Turning it on does not make the line jump: an untouched curve is exactly the fit through
            the points that were already there. A point's two handles stay opposite each other, so
            the line never kinks where it passes through one.
          </>,
          <>
            A handle you aim is <b>yours</b>, and the points you have not touched go on taking their
            tangents from the curve -- so shaping one corner by hand does not cost you the fit
            everywhere else. Moving a point never undoes an aim, and the aim survives the switch
            being thrown off and back on.
          </>,
          <>
            <b>With it off, a corner is burnt where you put it.</b> The line is walked from station
            to station on its way to becoming a slot, and the walk restarts at every point you
            placed rather than striding through it -- so a sharp V comes out a sharp V rather than
            a small chamfer across the tip. What the tool cannot do is anything finer than the slot
            itself: two points closer together than the kerf are one point as far as the cut is
            concerned.
          </>,
        ],
      },
      {
        title: 'Symmetry',
        summary:
          'A mirror stood on the face: draw in one part of it and the cut appears in the others, all burned at once. Two parts under a line, four under a cross.',
        steps: [
          { action: 'Symmetry', result: 'Stands a green line through the middle of the face, and takes it in hand.' },
          { action: 'Drag the line', result: 'Swings it. It holds at every 45 degrees while Snap is on.' },
          { action: 'Click a part of the face', result: 'That part is the one you draw in. The rest are dimmed.' },
          { action: 'Line / Cross', result: 'One mirror, or two at a right angle. In the panel by the block.' },
          { action: 'Freehand or Point Cut', result: 'Draw as usual. The axis stays standing and reflects what you draw.' },
          { action: 'Apply cut', result: 'Every copy is burned in the same act, and one Ctrl+Z takes them all back.' },
          { action: 'Symmetry, cutter in hand', result: 'Takes the mirror back so you can re-aim it. The button was lit all along.' },
          { action: 'Symmetry, mirror in hand', result: 'Puts it away. Cuts go back to being one line, and the aim is kept for next time.' },
        ],
        notes: [
          <>
            <b>The axis is not a tool you hold.</b> Taking Symmetry up puts the cutter down --
            swinging the line and picking a part are the same press a cutter draws with -- but the
            line itself stays on the face when you pick a cutter back up. That is the whole point
            of it: a mirror you could not cut with would be no use. The button stays <b>lit</b> for
            as long as the axis is standing, cutter in hand or not, because what it is telling you
            is that cuts are being mirrored. Press it with a cutter in hand to take the mirror back
            and re-aim it; press it while you are holding it to put it away.
          </>,
          <>
            <b>Only the lit part is cut.</b> A line that strays over the axis is clipped where it
            crosses, and what is left is what gets reflected -- so the two halves always meet
            exactly on the mirror rather than nearly. A line drawn entirely in a dimmed part has
            nothing to burn, and Apply says so.
          </>,
          <>
            <b>Both halves come off together.</b> The pieces a mirrored cut makes are lit as a set:
            a piece and its images are one decision, so <b>Del</b> and <b>Discard pieces</b> take
            all of them at once, and one undo puts them all back.
          </>,
          <>
            Each face keeps its own mirror, so a 45-degree axis set up on the front is still there
            when you turn back to the front, and the top is upright until you say otherwise. How
            near the line has to be swung before it holds at a stop is the <b>Angle</b> under
            <b> Snap</b> in the bar -- and turning Snap off lets it sit at any angle at all.
          </>,
          <>
            <b>Draw half a shape and the mirror closes it.</b> A line that starts on the axis and
            comes back to it is sewn to its own reflection, so what burns is one ring and the shape
            drops out of the block as an island -- which is what the completed silhouette on screen
            was promising. A line that ends anywhere else runs out to the border along its own
            tangent, as every open line here does.
          </>,
        ],
      },
      {
        title: 'The lathe view',
        summary:
          'Side-on and fixed. What you shape is a profile, so both halves of the drawing are the one wall mirrored about the axis, and there is no camera to fly.',
        steps: [
          { action: 'Scroll', result: 'Zoom.' },
          { action: 'Minus and plus, bottom right', result: 'Step the zoom.' },
          { action: 'The percentage between them', result: 'Fits the piece to the frame.' },
        ],
        notes: [
          <>
            The frame never re-fits itself, so a piece made bigger LOOKS bigger. A lump that
            outgrows the frame hangs off the edge of it until you press the percentage.
          </>,
        ],
      },
    ],
  },

  {
    id: 'build',
    title: 'Building',
    blurb: 'Everything that puts something new in front of the camera.',
    entries: [
      {
        title: 'Solids',
        steps: [
          { action: 'Drag a row out of Solids', result: 'Drops that solid where you release it.' },
          {
            action: 'Sweep across a row first',
            result: 'Sets how many sides its base has. The icon shows what a drag will place.',
          },
        ],
      },
      {
        title: 'Erasers',
        summary: 'A red ghost solid that takes material away rather than adding it.',
        steps: [
          { action: 'Drag the grip on a Solids row', result: 'Places the eraser. Aim it as usual.' },
          {
            action: 'Drag the red corner of a clipboard tile',
            result: 'Erases with a whole saved object -- pockets, cuts, merged parts and all.',
          },
          {
            action: 'Confirm under Position & Rotation',
            result: 'Performs the subtraction. Until then it cuts nothing.',
          },
        ],
      },
      {
        title: '2D shapes',
        summary: (
          <>
            Drag a shape out of <b>Shapes</b> onto any object. It lands on the surface under the
            pointer as a sketch, which you then push or pull -- see <b>Sketches</b>.
          </>
        ),
      },
      {
        title: 'The clipboard',
        summary: (
          <>
            Objects kept with <b>Save as custom object</b>, at the top of the console. Drag one
            back in to place a copy.
          </>
        ),
        steps: [
          { action: 'Sweep across a tile', result: 'Spins it, so you can look it over.' },
          {
            action: "Drag a tile's top right corner",
            result: 'Places the same object as an eraser instead -- see Erasers.',
          },
          { action: 'Scroll the row sideways', result: 'Three tiles show at a time.' },
        ],
      },
    ],
  },

  {
    id: 'select',
    title: 'Selecting',
    blurb: 'Choosing what you are working on, and settling what sits where.',
    entries: [
      {
        title: 'Picking things up',
        steps: [
          { action: 'Click an object', result: 'Selects it.' },
          { action: 'Shift-click', result: 'Adds it to the selection.' },
          {
            action: 'Drag from empty space',
            result:
              'A box, taking every object whose gizmo falls inside. Shift adds rather than replaces.',
          },
        ],
        notes: [
          <>
            Only <b>Move</b> lets you drag an object by its body. Under <b>Rotate</b> and{' '}
            <b>Scale</b> a press on the body selects and nothing more.
          </>,
        ],
      },
      {
        title: 'Merge',
        summary: (
          <>
            Gather objects and press <b>Merge</b> under <b>Scene</b>: they become one object with
            one gizmo. Undo takes them apart again.
          </>
        ),
      },
      {
        title: 'Draw order',
        summary: (
          <>
            The <b>Scene</b> list is a priority order. Use a row's arrows to move it; where two
            objects share a surface, the higher one is drawn.
          </>
        ),
      },
      {
        title: 'Copy, paste and save',
        steps: [
          { action: 'Ctrl+C, Ctrl+V', result: 'Copies the selection and pastes it beside itself.' },
          {
            action: 'Right-click an object',
            result: 'Copy, paste, and Save as custom object, which sends it to the Clipboard.',
          },
        ],
      },
      {
        title: 'Delete',
        key: 'Delete',
        summary: 'Removes whatever is selected: the object, the sketch, or the ruler.',
      },
    ],
  },

  {
    id: 'gizmo',
    title: 'Move, rotate, scale',
    blurb:
      'What you do to a selected object: three gizmos at the top of the Tools island, each worked with a left-drag, and one button that flips the solid outright.',
    entries: [
      {
        title: 'Move',
        key: 'M',
        steps: [
          { action: 'Drag an arrow', result: 'Slides along that axis, snapping as it goes.' },
          {
            action: 'Drag a plane quad',
            result: 'Slides within XY, XZ or YZ. One seen edge-on stands down.',
          },
          { action: 'Drag the object itself', result: 'Slides it along the ground.' },
          { action: 'Shift while dragging', result: 'Lifts it instead of sliding it.' },
        ],
      },
      {
        title: 'Rotate',
        key: 'R',
        summary: 'Three rings, one per plane: red turns about X, green about Y, blue about Z.',
        steps: [
          {
            action: 'Drag a ring',
            result:
              'Turns about that axis. The wedge reads the sweep in degrees and lands on every 45.',
          },
        ],
      },
      {
        title: 'Scale',
        key: 'S',
        steps: [
          { action: 'Drag the ring', result: 'Scales every dimension at once.' },
          { action: 'Drag an arrow', result: 'Resizes the one dimension it points along.' },
        ],
        notes: [
          <>
            It works in the object's own axes: a solid you have turned grows along its own length,
            not the world's.
          </>,
        ],
      },
      {
        title: 'Mirror',
        summary: (
          <>
            Flips the selected solid about its <b>own</b> axes, like holding it up to a mirror.
            Press <b>X</b>, <b>Y</b> or <b>Z</b> inside the tool and it flips straight away.
          </>
        ),
        notes: [
          <>
            It stays exactly where it stood; only which way round it is changes, and sketches,
            cuts, torch marks and welded parts all flip with it. The same axis twice puts it back.
          </>,
        ],
      },
      {
        title: 'Putting the handles away',
        steps: [
          {
            action: 'Press Rotate or Scale again',
            result: 'Back to Move, where the app opens. M does the same from either.',
          },
          {
            action: 'Press Move again',
            result: 'The handles come off the object and all three buttons go dark.',
          },
        ],
        notes: [
          <>
            With them dark the solid cannot be dragged <b>at all</b>, by arrow or by body -- it is
            pinned while you work on its surface. It can still be painted, cut and torched, and its{' '}
            <b>Position</b> and <b>Rotation</b> still typed.
          </>,
        ],
      },
    ],
  },

  {
    id: 'tools',
    title: 'Tools',
    blurb:
      'The island floating over the scene. Snap is in the top bar instead, because it is a rule every drag obeys rather than a gizmo aimed at one solid.',
    entries: [
      {
        title: 'The Tools island',
        steps: [
          {
            action: 'Drag it by its title',
            result: 'Moves it. It snaps flush to whichever edge or corner you drop it near.',
          },
          { action: 'Click the title', result: 'Collapses it to that strip.' },
        ],
      },
      {
        title: 'Blowtorch',
        summary:
          'Melts material away: the surface under the brush sinks and flows, so edges round off rather than being bitten out. A red ghost sphere shows where it would land.',
        steps: [
          {
            action: 'Drag across a solid',
            result: 'Melts. Go over the same place again to sink it further.',
          },
          { action: 'Brush size', result: 'How wide the flame is.' },
          { action: 'Heat', result: 'How hard one pass bites.' },
          { action: 'Smoothing', result: 'How molten the result looks: low sandblasts, high pours.' },
          { action: 'Blowtorch melts, bottom left', result: 'Everything, or Selected only.' },
        ],
        notes: [
          <>
            <b>It burns through.</b> Held against a wall thinner than the brush, the surface sags
            until a hole opens, widening with each pass to about the brush's width and cutting a
            slot if you drag. The solid stays closed, so it still exports. A wall much thicker than
            the brush cannot be burnt through -- it only dishes.
          </>,
          <>
            With the torch armed a plain click no longer picks anything up: <b>right-click</b> or{' '}
            <b>Shift-click</b> to select. Arming it also takes the gizmo off the object and pins it.
          </>,
          <>One drag is one undo step, however long you hold it.</>,
        ],
      },
      {
        title: 'Sculpt',
        summary:
          'The blowtorch backwards: the surface rises and flows, drawing material onto the object along the line you pull. A green ghost sphere shows where it would land.',
        steps: [
          {
            action: 'Drag across a solid',
            result: 'Builds up. Go over the same place again to raise it further.',
          },
          {
            action: 'Brush size, Strength, Smoothing',
            result: "The torch's three dials doing the same jobs. Each brush keeps its own.",
          },
        ],
        notes: [
          <>
            <b>Arming any brush puts the others down.</b> At the same settings these two are one
            brush pointed opposite ways: the bead this raises stands as far proud as the torch's
            dish lies deep.
          </>,
          <>
            <b>Neither brush sharpens.</b> <b>Smoothing</b> rounds a sharp tip or inside corner off
            faster than either brush can push it, so Sculpt blunts a cone's point and the torch
            fills a crease rather than deepening it. Turn Smoothing down to keep more of an edge.
            If rounding an edge is what you actually wanted, the <b>Smoother</b> does it on purpose
            and stops at a radius you set.
          </>,
        ],
      },
      {
        title: 'Smoother',
        summary:
          'Rounds corners off. Drag it along an edge and the edge eases into a fillet of the radius Strength asks for, then stops there. A blue ghost sphere shows where it would land.',
        steps: [
          {
            action: 'Drag along an edge',
            result: 'Rounds it. Going over it again leaves the same round.',
          },
          {
            action: 'Brush size',
            result: 'How much of the corner one pass works, and the widest round available.',
          },
          {
            action: 'Strength',
            result: 'How round, as a share of the brush: at half, the round is about half the brush across.',
          },
          { action: 'Smoother rounds, bottom left', result: 'Everything, or Selected only.' },
        ],
        notes: [
          <>
            <b>It arrives and stops.</b> The other two brushes are rates -- hold either against a
            spot and it keeps going -- so the instinct they teach is to go over a mark again. This
            one converges: a stroke drives every corner it passes to the radius Strength asks for
            and leaves it there. To take more off, turn Strength up or use a wider brush.
          </>,
          <>
            <b>It leaves flat faces alone.</b> Only what is sharper than the target moves, so you
            can drag sloppily across a panel and change nothing but the edge you were aiming at.
            Anything already rounder than the target is left as it is, which is also why a second
            pass does nothing.
          </>,
          <>
            <b>Inside corners too.</b> A crease fills out to the same radius a corner eases in to --
            it is one measurement with two signs.
          </>,
          <>
            The most useful thing to point it at is <b>a cut</b>, which is why it sits next to that
            tool: a blade leaves a sharp arris, and this takes it off.
          </>,
        ],
      },
      {
        title: 'Cut',
        summary:
          'Arming Cut drops a plane through the middle of the selected object, level and wide enough to overhang it. With nothing selected it comes up in the middle of the scene.',
        steps: [
          {
            action: 'Move and Rotate',
            result: 'Aim and tilt the blade with the gizmo it carries.',
          },
          { action: 'Scale', result: 'Its ring sizes the guide square.' },
          { action: 'Apply cut', result: 'Makes the cut.' },
          { action: 'Reset plane', result: 'Puts the blade back where arming would drop it now.' },
          { action: 'The caret on Cut', result: "Reopens the tool's panel if you close it." },
        ],
        notes: [
          <>
            The tool's panel opens beside the island when you arm it, and says what the cut is
            about to take: the selected object, or every solid if nothing is selected.
          </>,
        ],
      },
      {
        title: 'Ruler',
        summary:
          'Lays a 50 mm measuring line across the view, in front of the selected object, with its readout riding the middle of it.',
        steps: [
          {
            action: 'Click a ruler',
            result: 'Selects it. The end you pressed nearest takes the arrows.',
          },
          { action: 'Press the knob at the far end', result: 'Moves the arrows there.' },
          {
            action: 'Drag an end',
            result: 'Snaps to corners, edges and middles -- of a solid, of any flat face, and of any sketch.',
          },
          {
            action: 'The caret beside Ruler',
            result: 'Lists the rulers: add more, or delete one with its red cross.',
          },
        ],
        notes: [
          <>
            A ruler's end is a point, so its gizmo stays on <b>Move</b> whichever tool is up.{' '}
            <b>Delete</b> removes the selected ruler.
          </>,
        ],
      },
      {
        title: 'Snap',
        summary:
          'In the top bar. Its caret sets how close a corner, an edge, a face or a middle has to be before a drag takes it. A solid seeks the scene by its corners, so it lands flush against a neighbour, and by its own middle, so it can be lined up with one.',
        notes: [
          <>
            <b>Middles line up one axis at a time.</b> Drag a solid so its middle is level with
            another solid’s in x, y or z and that one coordinate is taken, while the rest stay
            exactly where you dragged them -- so a knob can sit centred over a box while standing
            clear above it. A thin line runs between the two middles for every axis that has
            caught; two lines means two axes, and three means the solids are concentric.
          </>,
          <>
            Landing flush comes first. Where a corner is near enough to catch a neighbour’s face,
            that is what the drag does, and the middles are left for the space between things --
            which is where you are aiming when nothing is close enough to sit against.
          </>,
          <>
            An arrow lines up its own axis and no other. Dragging the X arrow can centre two solids
            in x, and it will never quietly move them in y or z to do it.
          </>,
        ],
      },
    ],
  },

  {
    id: 'sketch',
    title: 'Sketches',
    blurb: 'A 2D shape dropped on a surface, and the solid you push or pull out of it.',
    entries: [
      {
        title: 'Placing one',
        summary: (
          <>
            Drag a shape out of <b>Shapes</b> onto an object. It lands on the face under the
            pointer and stays on that face.
          </>
        ),
      },
      {
        title: 'Its arrows',
        summary:
          'A selected sketch gets three, standing on the end of the extrusion rather than on the sketch: two along the outline’s own edges, and one facing away from the face.',
        steps: [
          {
            action: 'Drag the sketch',
            result: "Slides across its face, seeking that face's corners, edges and middle -- and the middle of any other sketch on the solid.",
          },
          {
            action: 'Drag the arrow off the face',
            result: 'Sets how far the shape stands out. Push it back through to cut inward.',
          },
          { action: 'Drag the end face', result: 'Leans the extrusion over.' },
        ],
      },
      {
        title: 'Sizing and turning',
        steps: [
          { action: 'Scale, an edge arrow', result: 'Stretches the outline along that edge.' },
          { action: 'Scale, the ring', result: 'Scales the whole outline.' },
          {
            action: 'Rotate',
            result: 'One ring only: a sketch spins in its own face and nowhere else.',
          },
        ],
      },
      {
        title: 'Confirming it',
        summary: (
          <>
            A sketch stays a draggable handle until you press <b>Confirm extrusion</b> at the top
            of <b>Position &amp; Rotation</b>.
          </>
        ),
        notes: [
          <>
            The solid keeps everything the sketch built; what goes is the handle -- the outline,
            and its row under <b>Scene</b>. Like a subtraction it only goes one way, and{' '}
            <b>undo</b> is the way back.
          </>,
        ],
      },
    ],
  },

  {
    id: 'lathe',
    title: 'The lathe',
    blurb: 'The second screen: one lump of clay, shaped by pushing and pulling its wall.',
    entries: [
      {
        title: 'What you are looking at',
        summary:
          'A lump turning on a faceplate, drawn from the side. What you shape is a profile: how far the wall stands from the axis at each height.',
        steps: [
          { action: 'The dashed rectangle', result: 'The stock: where the lump began.' },
          {
            action: 'The faint rings',
            result: 'A fixed measure. They follow the wall, so they show the curve you are making.',
          },
        ],
      },
      {
        title: 'Push and Pull',
        summary: (
          <>
            <b>Push</b> takes material away and <b>Pull</b> adds it. Push is already in your hand
            when the screen opens; pressing the lit tool puts it down, and with empty hands the
            clay ignores you.
          </>
        ),
        steps: [
          {
            action: 'Press and hold on the clay',
            result: 'The wall travels to the pointer and stops there. Holding longer only finishes the curve.',
          },
          {
            action: 'Move while holding',
            result: 'Shapes a whole side in one stroke. Either side of the axis is the same wall.',
          },
          { action: 'Tool size', result: 'How much of the wall the tool covers.' },
          { action: 'Strength', result: 'How fast the wall comes to you, not how deep it goes.' },
        ],
        notes: [
          <>
            Each tool remembers its own pair of dials, so a wide tool for the belly and a fine one
            for the neck both stay set. Neither works the other's way -- a push can never fill a
            neck back in, which is what makes a missed aim harmless.
          </>,
        ],
      },
      {
        title: 'Smooth',
        summary:
          'The third tool, under the rule on the island. It neither adds nor takes away: hold it against a stretch of wall and the ripples a hard push left come out, while the curve they sit on stays.',
        notes: [
          <>
            Only how far UP you hold it matters, not how far from the axis. Its <b>Tool size</b>{' '}
            starts wider than the other two, because fairing a side is a longer gesture than aiming
            at a spot.
          </>,
        ],
      },
      {
        title: 'Point Sculpt',
        summary:
          'The one tool here you do not hold against the wall. Click beside the piece to drop points down its side, and the line through them becomes the profile over the span they cover -- exactly, corners and all.',
        steps: [
          { action: 'Click', result: 'Puts a point down at the end of the line, and takes hold of it.' },
          { action: 'Drag a point', result: 'Moves it. The curve through its neighbours follows.' },
          {
            action: 'Click a point',
            result: 'Makes it the one you are shaping: its handles come out, and the last one’s go in.',
          },
          {
            action: 'Delete, Backspace',
            result:
              'Takes the point you are shaping off the line. One at an end shortens it; one in the middle is bridged by its neighbours.',
          },
          {
            action: 'Fit to line',
            result: 'On, a smooth curve through every point; off, straight segments between them.',
          },
          {
            action: 'Drag a handle',
            result:
              'Aims the shaped point’s tangent. It keeps what you aimed; the rest stay fitted.',
          },
          { action: 'Apply profile', result: 'Cuts the wall to the line. One press is one undo step.' },
          { action: 'Reset line', result: 'Throws the points away and starts again.' },
        ],
        notes: [
          <>
            <b>It is the only tool here that can leave a corner.</b> Push, Pull and Smooth all fair
            the wall as they work it, so a shoulder pushed by hand rounds itself off under the
            tool. Turn <b>Fit to line</b> off, put two points at the same height, and the step
            between them comes out exactly as drawn -- which is how you get a square shoulder, a
            chamfer or a flat-topped bead.
          </>,
          <>
            <b>And the corner survives the copy.</b> A step drawn this way arrives in the scene as
            a hard edge, lit as two faces meeting rather than as one smoothly rounded one -- and it
            costs two rings rather than the thirty a rounded corner takes to fake. A curve is left
            smooth; only a turn sharper than about thirty degrees reads as a corner.
          </>,
          <>
            A corner lands at the nearest of the piece's own rings, which is a millimetre and a
            half apart on a lump this tall. So a point may settle up to three quarters of a
            millimetre above or below where you clicked -- but it settles at exactly the radius you
            put it at, and the runs either side of it stay dead straight. The alternative was a
            corner in the right place with the wrong width and a small flat across its tip.
          </>,
          <>
            <b>One point wears its handles at a time</b> -- the one you just placed, or the one you
            last clicked -- so the bars that bend the curve never pile up over the curve they are
            bending. Nothing is lost by looking away: every point keeps the tangent you aimed for
            it, and clicking its knot brings the handles back out where you left them. The filled
            knot is the one in hand.
          </>,
          <>
            Only the span the points cover is touched: the wall above the topmost point and below
            the bottom one is left alone, so a foot can be re-cut on a piece whose belly is already
            right. That is also why it has no Tool size -- where the points went says it.
          </>,
          <>
            <b>A point you did not mean goes with Delete.</b> Click it, so the filled knot is the
            one you want gone, and press the key. Take one off an END and the line simply stops at
            the knot before it -- along with the span it covered, so that stretch of wall is left as
            it stands. Take one out of the MIDDLE and its two neighbours join up: straight with{' '}
            <b>Fit to line</b> off, and a fresh curve between them with it on. Every other point
            keeps the tangent you aimed for it, and the one before the gap comes up wearing its
            handles.
          </>,
          <>
            <b>Apply</b> and <b>Reset</b> stand in the bottom-left corner rather than under the
            tool’s own caret, because a press on the drawing would shut a panel hanging off a
            button -- and placing a point is a press on the drawing.
          </>,
        ],
      },
      {
        title: 'Hollow',
        summary:
          'At the foot of the island: takes the middle out and leaves a wall. Switch it on and the drawing becomes a section, so you see the bore and the clay either side of it.',
        steps: [
          { action: 'Wall', result: 'How much clay is left, in millimetres.' },
          {
            action: 'Bottom, Top',
            result: 'Open or closed, set apart: a cup, a pipe, a sealed void, or a bell.',
          },
        ],
        notes: [
          <>
            The inside FOLLOWS the outside, so a stroke made after hollowing thins the piece rather
            than leaving the bore behind. If the clay is too narrow to bore through to an end you
            asked to be open, the cavity stops there and the panel says so.
          </>,
        ],
      },
      {
        title: 'The lump',
        summary:
          'The bottom-left panel sets the stock you are turning: Height and Width, the two sides of the rectangle you start from.',
        steps: [
          {
            action: 'Height, Width',
            result: 'Carry the shape with them, so they are safe to touch after you have started.',
          },
          { action: 'Reset', result: 'Throws the shaping away and leaves the stock as it is.' },
          { action: 'Press the title', result: 'Shuts the panel down to its strip.' },
        ],
      },
      {
        title: 'The base',
        summary: (
          <>
            <b>Base</b>, under the Clipboard in the console, is what the piece is turned ON: a{' '}
            <b>Circle</b>, or a <b>Polygon</b> from a triangle to a decagon.
          </>
        ),
        notes: [
          <>
            Every base has the same profile, so from the side it changes only a fainter dashed line
            inside the piece: the wall you push is the line the CORNERS follow, and the flats sit
            closer in. It moves no part of the wall, so a piece can be turned hexagonal and back
            without losing a stroke.
          </>,
        ],
      },
      {
        title: 'Undo on the lathe',
        key: 'Ctrl+Z',
        summary:
          'Ctrl+Z steps back one stroke and Ctrl+Shift+Z forward again; the bar’s Undo and Redo do the same. A whole stroke is one step however long you held the tool, and so is Reset.',
        notes: [
          <>
            What it remembers is the WALL. A height, width, base or hollow set afterwards stays
            set: those you can put back by setting them back, where a stroke is a gesture you
            cannot.
          </>,
        ],
      },
      {
        title: 'Ruler',
        summary: (
          <>
            The last button on the island. Pressing it lays a ruler straight across the piece,
            already reading the width there; drag either end by its knob to measure anything else,
            or push a level one by its middle to walk that measurement up the curve. The caret
            beside it opens the list, which is where the second one comes from and where any of
            them is deleted.
          </>
        ),
        steps: [
          {
            action: 'An end near an edge',
            result: 'Lands exactly on it: the outer wall, the cavity wall inside a hollow piece.',
          },
          {
            action: 'An end near the middle',
            result: 'Takes the axis, which is what makes the reading a radius rather than a width.',
          },
          {
            action: 'An end near the rim or the plate',
            result: 'Takes that height, so the number agrees with the readout in the corner.',
          },
          {
            action: 'An end nearly level or upright with the other',
            result: 'Goes exactly level or exactly upright, so a width is a width.',
          },
          {
            action: 'A level ruler by the line between its ends',
            result:
              'Slides up and down the piece, each end keeping the surface it was on: the outer wall, or the cavity wall inside a hollow one. It stops where that surface does.',
          },
        ],
        notes: [
          <>
            A dashed line shows what an end has caught while you hold it. All of it obeys{' '}
            <b>Snap</b> in the top bar, and its <b>Sensitivity</b> there is how near is near --
            in pixels, so the reach is the same under your hand at every zoom.
          </>,
          <>
            Rulers change nothing about the clay, so they are not in the undo history and they
            are not swept onto the clipboard. They stay where you left them when the tool is put
            down.
          </>,
        ],
      },
      {
        title: 'Copy to clipboard',
        summary: (
          <>
            The button in the top-right corner sweeps the piece a full turn into a real solid and
            puts it on the <b>Clipboard</b>. <b>Ctrl+V</b> on the Modelling screen pastes it into
            the scene.
          </>
        ),
        notes: [
          <>
            It is swept on the base you chose and named for it. What lands is a mesh, so everything
            the Modelling screen does works on it. It is a SNAPSHOT: shape the clay further and
            press again for a second copy.
          </>,
          <>
            <b>The triangle count is fitted to the shape</b>, which is what the receipt reports
            beside the piece's height. A straight wall costs its two ends whether it is a
            centimetre of the piece or the whole of it; a curve keeps as many rings as it takes to
            stay a tenth of a millimetre from the profile you turned; a corner is a corner rather
            than thirty rings pretending to be one. So a plain lump arrives at a couple of hundred
            triangles and a fluted bowl at a few thousand, where both used to arrive at 12,288.
          </>,
          <>
            How many facets go round is fitted the same way -- to how WIDE the piece is, against
            the same tenth of a millimetre -- so a stem is not swept as finely as a bowl, and
            neither is coarser up its side than it is round its middle.
          </>,
        ],
      },
    ],
  },

  {
    id: 'reference',
    title: 'Reference images',
    blurb:
      'Drawings stuck to the block on the laser cutter, to cut along. The panel is on that screen and nowhere else.',
    entries: [
      {
        title: 'The Reference panel',
        summary: (
          <>
            Under the Clipboard on the Laser Cutter's console: three slots, and one{' '}
            <b>Opacity</b> for everything in them.
          </>
        ),
        steps: [
          { action: 'The dropdown', result: 'Which preset is in hand. Up to five of them.' },
          { action: 'The pencil', result: 'Renames the preset you are on.' },
          { action: 'Plus, cross', result: 'Adds a preset, or deletes this one and its pictures.' },
          {
            action: 'Opacity',
            result: 'How strongly every reference is drawn. One number, so two drawings read alike.',
          },
        ],
        notes: [
          <>
            A preset is a whole set-up rather than a folder: switching takes its references OFF the
            block and puts the new preset's on. Switching back brings them out again, where they
            were.
          </>,
          <>Nothing here survives a reload. The pictures are held for this sitting only.</>,
        ],
      },
      {
        title: 'Adding a picture',
        steps: [
          { action: 'Click an empty slot', result: 'Opens the file picker.' },
          { action: 'Pick up to three', result: 'They fill the shelf in the order you chose them.' },
          { action: 'Drop files on a slot', result: 'Takes a whole selection straight off the desktop.' },
          { action: 'What it takes', result: 'PNG, JPEG and SVG. An SVG is drawn to pixels on the way in.' },
        ],
        notes: [
          <>
            A batch starts at the slot you pressed and carries on round the shelf, so three pictures
            fill all three slots whichever one you started from. Past three the extras are refused
            rather than landing on a picture that arrived with them.
          </>,
          <>
            A picture dropped on a slot that already holds one replaces it, and takes whatever that
            one had put on the block with it.
          </>,
        ],
      },
      {
        title: 'Editing one',
        summary: 'Point at a tile and two buttons appear: a pencil and a bin.',
        steps: [
          { action: 'Flip H, Flip V', result: 'Mirrors what you see, left to right or top to bottom.' },
          { action: 'Rotate', result: 'A quarter turn, either way.' },
          { action: 'Drag the rectangle', result: 'Crops. Drag a corner to resize it, the middle to move it.' },
          {
            action: 'Crop: 1:1, 4:3, 3:2, 16:9',
            result: 'Holds the crop to that shape, and takes it at once. Free lets go again.',
          },
          { action: 'Whole picture, Reset', result: 'Undoes the crop, or everything.' },
        ],
        notes: [
          <>
            Nothing is written over the original: the flip, the turn and the crop are kept beside
            it, so a crop can be widened again later. <b>Cancel</b> puts back what the picture wore
            on the way in.
          </>,
          <>
            The size at the top right is what the block will get, in pixels, and it moves as you
            drag -- so a crop held to <b>1:1</b> is one you can watch reading the same twice.
          </>,
        ],
      },
      {
        title: 'Putting one on the block',
        steps: [
          { action: 'Drag a tile onto a face', result: 'Lands there, sized to fit the face. Takes up Move as it goes.' },
          { action: 'Click a tile', result: 'Lights that slot: its copies on the block take handles.' },
          { action: 'Move', result: 'The tool that takes hold of a reference. Nothing can be cut while it is in hand.' },
          { action: 'Drag the picture', result: 'Slides it about, never off the edge of its face.' },
          {
            action: 'Pull any corner',
            result: 'Sizes it, with the opposite corner held still. Its own shape is kept, so it cannot be stretched.',
          },
          { action: 'Del', result: 'Takes the lit picture off the block, on every face it is on. It stays in the panel.' },
          { action: 'Esc', result: 'Puts the light out and leaves the picture where it is.' },
        ],
        notes: [
          <>
            A reference belongs to the face it landed on. To put it on another one, drag the tile
            out again -- one picture can be on as many faces as you like.
          </>,
          <>
            <b>The handles belong to Move AND to the lit slot.</b> The tool says what you are doing
            and the panel says which picture you are doing it to, so a face wearing three drawings
            wears one set of grips rather than three. With any other tool in hand only the outline
            is left, so that every part of the picture can be drawn across -- and taking up a cutter
            puts the light out for you.
          </>,
          <>
            <b>Del is the way off the block.</b> The bin on the tile throws the picture away
            altogether; Del takes it off the faces and leaves it on the shelf to be dropped
            somewhere else.
          </>,
        ],
      },
      {
        title: 'Cutting to one',
        summary:
          'The picture is on the surface rather than floating over it, which is what makes it a thing to cut along.',
        notes: [
          <>
            <b>A cut cuts the block, not the drawing.</b> Each piece keeps the part of the picture
            that is on its own surface, and the rest stays exactly where you put it, hanging where
            the material used to be -- so a face cut away from another axis does not take your
            drawing with it, and nothing has to be re-aimed or dropped on again.
          </>,
          <>
            It stays on the plane it was stuck to, and only there. The new faces a cut opens up
            inside the block come out bare, however square-on to the picture they are -- what you
            see across a gap is the drawing itself, still where it was.
          </>,
          <>
            <b>Opacity</b> governs the whole of it, on the surface and in the air alike.
          </>,
        ],
      },
    ],
  },

  {
    id: 'files',
    title: 'Colour and files',
    blurb: 'Painting the model, what comes in and goes out, and the settings that outlive it.',
    entries: [
      {
        title: 'Colour',
        summary: 'Paints the selected objects, from the console.',
        steps: [
          { action: 'Ring, then slider', result: 'Hue, then brightness. Press Apply.' },
          {
            action: 'The hex field',
            result: 'Types a colour straight in -- the only way to a muted one, as the ring carries hue alone.',
          },
          { action: 'The shelf below', result: 'Applied colours. Click one to load it back.' },
        ],
      },
      {
        title: 'Import',
        summary:
          'Beside Export, which is the same act in the opposite direction. Reads GLB, OBJ, STL and STEP; the model lands as one solid you can size, move, cut and merge like anything built here.',
        notes: [
          <>
            <b>It is the one control that works with no project open.</b> Pressed on the Welcome
            screen it makes a project named after the file and drops the model into it, which is the
            shortest way from a file on your disk to something you can work on.
          </>,
        ],
      },
      {
        title: 'Export',
        summary: (
          <>
            Writes the whole scene: <b>.glb</b>, <b>.obj</b> or <b>.stl</b> for a mesh, <b>.step</b>{' '}
            for a CAD solid.
          </>
        ),
        notes: [
          <>
            The box at the top of the menu names the file. Leave it empty and the name shown in it
            is the one used -- the app, then what is in the scene -- so three exports taken while a
            shape is being worked on land as three files rather than three copies of one. The
            extension is never yours to type: it comes from the format you press.
          </>,
        ],
      },
      {
        title: 'Undo and redo',
        key: 'Ctrl+Z',
        summary:
          'Undo and Redo in the top bar step through the document’s history, and Ctrl+Z and Ctrl+Shift+Z do the same from the keyboard.',
      },
      {
        title: 'Units',
        summary: (
          <>
            <b>Settings</b>, the cog at the end of the bar, which opens over the app:{' '}
            <b>mm</b>, <b>cm</b> or <b>in</b>. It changes what the numbers are READ in, never the
            model. The app opens in millimetres.
          </>
        ),
        notes: [
          <>
            <b>It reaches the tools as well as the readouts.</b> Brush and tool sizes, the wall on
            the lathe and the flying speed are all read in the unit you pick here. The switch beside
            one of those fields overrides it for that field alone, for a tool you want read in
            something other than the rest of the app.
          </>,
          <>
            <b>Inches are shown to thousandths</b>, which is the unit's own convention: 25.4 mm to
            the inch, so a millimetre is 0.039 of one and two places would round a nudge away.
          </>,
        ],
      },
      {
        title: 'Theme',
        summary:
          "Which palette the app wears, one row below the units. It repaints the app and never an object's own colour.",
      },
      {
        title: 'Outlines',
        summary:
          'The edge lines drawn around every solid, under Theme. Switch them off to see the surfaces bare -- a selected object still glows, so nothing is lost by it.',
      },
      {
        title: 'Game Controls',
        summary: (
          <>
            The last row on that screen, and the only one that changes what your HANDS do rather
            than what the app looks like. Switched on, the modelling camera is driven the way a
            game's is: <b>W A S D</b> to walk, <b>Space</b> and <b>C</b> to rise and sink, and the
            right mouse button held down to look about. The cursor disappears while you look,
            so a turn can carry on as far as your hand does.
          </>
        ),
        notes: [
          <>
            WASD stays on the ground and the height is Space and C alone, so looking down at a part
            and holding <b>W</b> walks ACROSS the scene rather than diving into it.
          </>,
          <>
            The wheel no longer closes in on anything -- <b>W</b> does that now -- so it sets how
            fast you fly instead. The speed appears at the top of the viewport as you turn it, and
            the <b>Speed</b> field under the switch says the same number.
          </>,
          <>
            Middle-drag still orbits, and with something selected it swings around THAT rather than
            around the middle of the scene. The compass in the corner still flies to a view.
          </>,
          <>
            <b>M</b>, <b>R</b> and <b>S</b> stop switching the gizmo while this is on -- S is the
            key that walks backwards. The three buttons on the island do the same job. Everything
            else answers as usual: Ctrl+Z, Delete and Esc are untouched.
          </>,
          <>
            Only the modelling screen has a room to walk about in, so the switch is dimmed on the
            lathe and the laser cutter. It keeps its setting while you are over there.
          </>,
        ],
      },
    ],
  },

  {
    id: 'shortcuts',
    title: 'Shortcuts',
    blurb: 'Every key the app answers, and where each one means something.',
    entries: [
      {
        title: 'Anywhere',
        steps: [
          {
            action: 'Esc',
            result: 'Closes the open panel, menu or this screen. In a viewport it puts down whatever is in hand.',
          },
          { action: 'Ctrl+Z', result: 'Undo, on the screen you are on: the document, the clay or the cuts.' },
          {
            action: 'Ctrl+Shift+Z',
            result: "Redo, the same way. The bar's two buttons do exactly this.",
          },
        ],
        notes: [
          <>
            <b>Ctrl</b> is <b>Cmd</b> on a Mac: every chord here answers either.
          </>,
          <>
            None of them fire while the caret is in a field. A typo corrected in a number box must
            not undo the last cut.
          </>,
          <>
            Undo never crosses screens -- each walks its own history, and the two in the bar dim on
            a screen with nothing to walk.
          </>,
        ],
      },
      {
        title: 'Modelling',
        steps: [
          { action: 'M', result: 'Move gizmo. Pressed again it takes the handles off the object.' },
          { action: 'R', result: 'Rotate gizmo. Pressed again it falls back to Move.' },
          { action: 'S', result: 'Scale gizmo. Pressed again it falls back to Move.' },
          {
            action: 'Delete, Backspace',
            result: 'Removes what wears the handles: a selected ruler first, then a sketch, then the whole selection.',
          },
          {
            action: 'Esc',
            result:
              "Cancels a marquee in flight, drops the selection, and puts the ruler's handles down.",
          },
          { action: 'Ctrl+C', result: 'Copies the selected object.' },
          { action: 'Ctrl+V', result: 'Pastes it beside itself.' },
          { action: 'Shift+click', result: 'Adds a solid to the selection or takes it out -- in the scene, and in the Scene list.' },
          { action: 'Shift+drag a solid', result: 'Lifts it instead of sliding it along the ground.' },
          { action: 'Shift+drag the background', result: 'Marquees, and adds the catch to the selection rather than replacing it.' },
          { action: 'Alt+left-drag', result: 'Orbits, for a mouse with no middle button.' },
          { action: 'Enter, Space', result: 'On a palette row: drops that solid on the grid without a drag.' },
        ],
        notes: [
          <>
            <b>M</b>, <b>R</b> and <b>S</b> are bare rather than chorded, which is where every 3D
            application puts them -- and they are ignored mid-drag, so a gesture in flight cannot
            have its gizmo swapped out from under it. With <b>Game Controls</b> on they stand down
            entirely: <b>S</b> is the key that walks backwards.
          </>,
        ],
      },
      {
        title: 'Game Controls',
        steps: [
          { action: 'W, S', result: 'Walk forward and back, along the ground, whichever way you are looking.' },
          { action: 'A, D', result: 'Strafe left and right. This is what panning used to do.' },
          { action: 'Space', result: 'Rise, straight up.' },
          { action: 'C', result: 'Sink, straight down.' },
          { action: 'Right-drag', result: 'Look about. Turns the view in place rather than swinging it round anything, and the cursor goes for the length of the drag so the turn is never stopped by the edge of the screen.' },
          { action: 'Right-click', result: 'Still opens the object menu, as long as you have not moved the mouse.' },
          { action: 'Wheel', result: 'Sets how fast you fly, shown for a moment at the top of the viewport.' },
          { action: 'Middle-drag', result: 'Orbits the selected object. Alt+left-drag does the same.' },
        ],
        notes: [
          <>
            Switched on under <b>Settings</b>, and only on the modelling screen -- the lathe and the
            laser cutter each draw one flat picture with nowhere to walk to.
          </>,
          <>
            <b>C</b> sinks rather than Ctrl, which is what this scheme normally uses. Ctrl+W closes
            a browser tab and no page is allowed to stop it, so walking forward while sinking would
            have thrown the scene away. It leaves Ctrl whole: <b>Ctrl+Z</b>, <b>Ctrl+C</b> and{' '}
            <b>Ctrl+V</b> all answer while you fly.
          </>,
          <>
            <b>Space</b> belongs to the camera while this is on, so it no longer presses the button
            under the finger -- <b>Enter</b> still does, on every control that answered either.
          </>,
          <>
            A press in the scene is refused while you are moving: let go of the keys before grabbing
            a solid or starting a stroke, or the grab would be measured against a view sliding out
            from under it. A gesture already under way carries on regardless.
          </>,
        ],
      },
      {
        title: 'The lathe',
        steps: [
          {
            action: 'Delete, Backspace',
            result:
              'With Point Sculpt in hand, takes the point you are shaping off the profile. Otherwise takes the lit ruler off the piece, and with neither, nothing.',
          },
          { action: 'Esc', result: 'Puts a lit ruler out. The ruler stays; only its highlight goes.' },
          { action: 'Ctrl+Z', result: 'Walks the strokes back, one push or pull at a time.' },
          { action: 'Ctrl+Shift+Z', result: 'And forward again.' },
        ],
        notes: [
          <>
            The clay itself is not deletable and never has been: the way out of a piece gone wrong
            is <b>Reset</b>, in the corner panel, which says what it will do before it does it.
          </>,
        ],
      },
      {
        title: 'The laser cutter',
        steps: [
          {
            action: 'Delete, Backspace',
            result: 'Takes the lit reference off the block. With no slot lit, throws the offcut away.',
          },
          { action: 'Esc', result: 'Puts down the line being drawn, and puts a lit reference slot out.' },
          { action: 'Ctrl+Z', result: 'Walks the cuts back. One cut is one step.' },
          { action: 'Ctrl+Shift+Z', result: 'And forward again.' },
        ],
        notes: [
          <>
            <b>Reset block</b> is one step like any other, and undoing it gives back the cuts and
            the stock's size together.
          </>,
        ],
      },
      {
        title: 'Typing in a panel',
        steps: [
          { action: 'Enter', result: 'Commits what you typed and leaves the field.' },
          { action: 'Esc', result: 'Puts back what the field held before you started typing.' },
          {
            action: 'Arrow keys',
            result: 'On the colour ring, steps the hue; on the bar beside it, the brightness.',
          },
        ],
      },
    ],
  },
]

/**
 * The section the screen opens on.
 *
 * The first one, and it stays the first one. Help is read by somebody who has
 * just arrived, and "how do I move the camera" is the question they have before
 * they have anything to move it around.
 */
export const DEFAULT_HELP_SECTION: HelpSectionId = HELP_SECTIONS[0].id
