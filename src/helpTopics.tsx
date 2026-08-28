import type { ReactNode } from 'react'

/**
 * What the app does, written out as a book rather than as a list.
 *
 * WHY THIS IS A MODULE AND NOT MARKUP. It used to be sixty-odd `<li>`s inside
 * `HelpTool`, in the order they happened to be written -- which is the order the
 * features were built rather than any order a person reads in. A list that long
 * has no shape: "how do I melt something" and "how do I pan" sit a line apart,
 * and the only way to find either is to read the whole thing. Pulling the copy
 * out into data is what makes a shape possible -- the screen renders a structure
 * instead of holding one implicitly, and a new tool becomes an entry in a
 * section here rather than a line dropped wherever there was room.
 *
 * THREE LEVELS, and each has a job. A SECTION is what you are trying to do --
 * get around, build something, melt something -- and it is the level the rail
 * on the left offers, because that is the question somebody opening Help
 * actually has. An ENTRY is one thing the app has: a tool, a gesture, a panel.
 * Its title is the name the app itself uses for it, so the word read here is the
 * word to go looking for on screen. The BODY is what it does and what it will
 * surprise you with -- the second half being the part the old list was best at
 * and the part most help text leaves out.
 *
 * It sits at `src/` rather than under `console/` for the reason `theme.ts` does:
 * the store holds which section is open, and a store reaching down into a
 * component folder for a type is the wrong direction.
 *
 * Every claim in here is a claim about behaviour, so a line that stops being
 * true is a bug in this file rather than a matter of taste.
 */

/** One thing the app has, named the way the app names it. */
export type HelpEntry = {
  /** The subtitle. The app's own word for the thing, so it can be looked for. */
  title: string
  /**
   * The keyboard shortcut, if it has one, drawn as a chip beside the title.
   *
   * Beside the name rather than buried in the sentence: a shortcut is the one
   * part of an entry that is scanned for rather than read, and somebody after
   * "what is the key for scale" should not have to parse a paragraph for it.
   */
  key?: string
  /** What it does, in paragraphs. More than one where there is more to say. */
  body: ReactNode[]
}

export type HelpSectionId =
  | 'view'
  | 'build'
  | 'select'
  | 'gizmo'
  | 'tools'
  | 'sketch'
  | 'look'
  | 'files'

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
 * Ordered by when a person meets them rather than by importance. You look
 * before you build, you build before you have anything to select, you select
 * before you can reach a gizmo, and the gizmo is what every tool in Tools then
 * borrows. Files and settings come last because they are the only things here
 * that outlive the document.
 */
export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'view',
    title: 'Getting around',
    blurb: 'Moving the camera. None of it touches the model.',
    entries: [
      {
        title: 'Orbit and zoom',
        body: [
          <>
            <b>Middle-drag</b> anywhere in the scene to swing the camera around what you are
            looking at, or hold <b>Alt</b> and left-drag if your mouse has no middle button.{' '}
            <b>Scroll</b> to zoom.
          </>,
        ],
      },
      {
        title: 'Pan',
        body: [
          <>
            <b>Right-drag</b> on empty space to slide the view. On an object, right-click opens
            its menu instead, so a pan starts from the background.
          </>,
        ],
      },
      {
        title: 'The axis compass',
        body: [
          <>
            The cube in the corner says which way is which. <b>Drag</b> it to orbit by hand --
            half a turn across the widget, and it turns the camera without moving it.
          </>,
          <>
            <b>Click</b> one of its balls or cube faces instead to fly square-on to that view.
          </>,
        ],
      },
    ],
  },

  {
    id: 'build',
    title: 'Building the scene',
    blurb: 'Everything that puts something new in front of the camera.',
    entries: [
      {
        title: 'Solids',
        body: [
          <>
            <b>Drag</b> a solid out of <b>Solids</b> in the console and drop it in the scene.
          </>,
          <>
            <b>Sweep across a row</b> before you drag to choose how many sides its base has. The
            icon spins through the shapes as you go, so the row is always showing what a drag
            will place.
          </>,
        ],
      },
      {
        title: 'Erasers',
        body: [
          <>
            <b>Drag the small grip</b> at the right of a Solids row to place that same solid as
            an <b>eraser</b> -- a red ghost that takes material away rather than adding it.
          </>,
          <>
            Aim it like anything else, then confirm the subtraction under{' '}
            <b>Position &amp; Rotation</b>. Until you confirm it, it cuts nothing.
          </>,
        ],
      },
      {
        title: '2D shapes',
        body: [
          <>
            <b>Drag</b> a shape out of <b>Shapes</b> onto any object. It lands on the surface
            under the pointer as a sketch, which you then push or pull -- see <b>Sketches</b>.
          </>,
        ],
      },
      {
        title: 'The clipboard',
        body: [
          <>
            Objects kept with <b>Save as custom object</b> live in <b>Clipboard</b>, at the top
            of the console. Drag one back in to place a copy.
          </>,
          <>
            Each tile turns on its own, and <b>sweeping across one</b> spins it so you can look
            it over. Three show at a time -- <b>scroll the row sideways</b> for the rest.
          </>,
        ],
      },
    ],
  },

  {
    id: 'select',
    title: 'Selecting and arranging',
    blurb: 'Choosing what you are working on, and settling what sits where.',
    entries: [
      {
        title: 'Picking things up',
        body: [
          <>
            <b>Click</b> an object to select it, then <b>drag</b> it to move it.{' '}
            <b>Shift-click</b> to gather several.
          </>,
        ],
      },
      {
        title: 'The selection box',
        body: [
          <>
            <b>Drag from empty space</b> for a box. It takes every object whose gizmo falls
            inside it.
          </>,
          <>
            Hold <b>Shift</b> while you drag and its catch is added to what is already selected,
            rather than replacing it.
          </>,
        ],
      },
      {
        title: 'Merge',
        body: [
          <>
            Gather objects and press <b>Merge</b> under <b>Scene</b>. They become one object
            with one gizmo, and undo takes them apart again.
          </>,
        ],
      },
      {
        title: 'Draw order',
        body: [
          <>
            The <b>Scene</b> list is a priority order. Use a row's arrows to move it, and where
            two objects share a surface the higher one is drawn.
          </>,
        ],
      },
      {
        title: 'Copy, paste and save',
        body: [
          <>
            <b>Right-click</b> an object for copy, paste and <b>Save as custom object</b>.
          </>,
          <>
            <b>Ctrl+C</b> and <b>Ctrl+V</b> copy the selected object and paste it beside itself.
          </>,
        ],
      },
      {
        title: 'Delete',
        key: 'Delete',
        body: [<>Removes whatever is selected -- the ruler, or the sketch, or the object.</>],
      },
    ],
  },

  {
    id: 'gizmo',
    title: 'Moving and shaping',
    blurb:
      'The handles on a selected object. Three of them, chosen at the top of the Tools island, and every one is a left-drag.',
    entries: [
      {
        title: 'Move',
        key: 'M',
        body: [
          <>
            <b>Drag</b> an arrow to slide along that axis, snapping as it goes.
          </>,
          <>
            Or <b>drag</b> one of the three plane quads -- XY, XZ, YZ -- to slide within that
            plane. One seen edge-on stands down, so from straight above only the ground is
            offered.
          </>,
          <>
            Hold <b>Shift</b> while moving an object and it lifts instead.
          </>,
        ],
      },
      {
        title: 'Rotate',
        key: 'R',
        body: [
          <>
            Three rings, one per plane. Drag the red, green or blue one to turn about X, Y or Z.
          </>,
          <>The wedge reads the sweep out in degrees as you go, and it lands on every 45.</>,
        ],
      },
      {
        title: 'Scale',
        key: 'S',
        body: [
          <>
            Drag the ring to scale every dimension at once, or an arrow to resize the one
            dimension it points along.
          </>,
          <>
            It works in the object's own axes, so a solid you have turned still grows along its
            own length rather than along the world's.
          </>,
        ],
      },
      {
        title: 'Putting the handles away',
        body: [
          <>
            Pressing <b>Rotate</b> or <b>Scale</b> again puts you back on <b>Move</b>, which is
            where the app opens -- or press <b>M</b> to go straight there from either.
          </>,
          <>
            Press <b>Move</b> once more and the handles come off the object altogether, leaving
            all three buttons dark. The solid stays selected and can still be painted, cut and
            torched; it just stops being something you can move by accident.
          </>,
          <>
            With the buttons dark it cannot be dragged <b>at all</b>, by its arrows or by its
            body -- it is pinned while you work on its surface. Its <b>Position</b> and{' '}
            <b>Rotation</b> can still be typed in the console. Press any of the three to bring
            the handles back.
          </>,
        ],
      },
    ],
  },

  {
    id: 'tools',
    title: 'Tools',
    blurb:
      'The island over the scene. Move, Rotate, Scale, Ruler, Cut and the two brushes live here; Snap is in the top bar, since it is a rule rather than a gizmo.',
    entries: [
      {
        title: 'The Tools island',
        body: [
          <>
            <b>Drag the island by its title</b> to move it. It snaps flush to whichever edge or
            corner you drop it near, and <b>clicking the title</b> collapses it to that strip.
          </>,
        ],
      },
      {
        title: 'Blowtorch',
        body: [
          <>
            Melts rather than bites. <b>Drag</b> across a solid and the surface under the brush sinks and
            flows, so edges round off and the mark blends into the face rather than being a bite
            out of it. A red ghost sphere shows where the brush would land and how big it is; it
            goes as soon as you press, so nothing covers the surface while it melts.
          </>,
          <>
            Its caret holds <b>Brush size</b>, <b>Heat</b> -- how hard one pass bites -- and{' '}
            <b>Smoothing</b>, which is how molten the result looks: low sandblasts, high pours.
            Smoothing never goes all the way to nothing, because a point held in the flame with
            no flow at all sharpens into a spur instead of rounding off.
          </>,
          <>
            Go over the same place again to sink it further. One drag is one undo step, however
            long you hold it.
          </>,
          <>
            <b>Blowtorch melts</b>, bottom-left of the scene, chooses between <b>Everything</b> and{' '}
            <b>Selected only</b>. With the torch armed a plain click no longer picks anything up
            -- <b>right-click</b> or <b>Shift-click</b> to select.
          </>,
          <>
            The torch shapes a surface; it does not open holes. Melt one spot long enough and a
            thin wall sags rather than bursting. Arming it takes the gizmo off the selected
            object on its own, so the arrows are never between the brush and the surface -- and
            pins the solid while it does, so a stroke that misses cannot shove the thing you
            were aiming at.
          </>,
        ],
      },
      {
        title: 'Sculpt',
        body: [
          <>
            The blowtorch backwards. <b>Drag</b> across a solid and the surface under the brush
            rises and flows, so material is drawn <b>onto</b> the object along the line you
            pull -- a bead, a ridge, a swelling -- instead of being melted out of it. A green
            ghost sphere shows where it would land; green is this app's colour for material
            arriving, the way red is for material going away.
          </>,
          <>
            Its caret holds <b>Brush size</b>, <b>Strength</b> -- how far one pass pushes -- and{' '}
            <b>Smoothing</b>, exactly the torch's three and doing exactly the same jobs. It keeps
            its own settings, so a fine carving brush and a fat blocking one both stay dialled in
            and swapping tools does not resize the one in your hand.
          </>,
          <>
            The two are the same brush pointed opposite ways: at the same three settings a bead
            this raises stands as far proud of the surface as the dish the torch sinks lies below
            it. <b>Arming either puts the other down.</b>
          </>,
          <>
            Go over the same place again to build it up further. One drag is one undo step, and
            carving over a bead or drawing over a groove does what you would expect -- the marks
            are kept in the order you made them.
          </>,
          <>
            <b>Neither brush sharpens.</b> Point either one at a sharp tip or a sharp inside
            corner and <b>Smoothing</b> rounds it off faster than the brush can push it, so the
            sculpt tool blunts a cone's point while packing material around it, and the torch
            fills a sharp crease rather than deepening it. Turn Smoothing down to keep more of an
            edge; on any ordinary surface, flat or curved, both work as they say.
          </>,
        ],
      },
      {
        title: 'Cut',
        body: [
          <>
            Arming <b>Cut</b> drops a plane through the middle of the selected object, level and
            wide enough to overhang it. With nothing selected it comes up in the middle of the
            scene.
          </>,
          <>
            The blade carries the same gizmo an object does -- arrows to aim it, rings to tilt
            it -- and in <b>Scale</b> its ring sizes the guide square.
          </>,
          <>
            <b>Apply cut</b> and <b>Reset plane</b> appear on the island once it is armed.{' '}
            <b>Reset plane</b> puts the blade back where arming would drop it now.
          </>,
        ],
      },
      {
        title: 'Ruler',
        body: [
          <>
            Lays a 50 mm measuring line across the view, in front of the selected object, with
            its readout riding the middle of it.
          </>,
          <>
            <b>Click a ruler</b> to select it: it thickens into yellow and black stripes, and
            the end you pressed nearest takes the arrows. <b>Press the knob</b> at the other end
            to move the arrows there. Each end snaps to corners and edges as you drag it.
          </>,
          <>
            A ruler's end is a point, so its gizmo stays on <b>Move</b> whichever tool is up --
            there is nothing about a point to turn or to scale.
          </>,
          <>
            <b>Delete</b> removes the selected ruler, and the <b>caret beside Ruler</b> opens
            the list, to add more or delete one with its red cross.
          </>,
        ],
      },
      {
        title: 'Snap',
        body: [
          <>
            <b>Snap</b> is in the top bar rather than on the island, because it is not aimed at
            one solid: it is a rule every drag in the app obeys, whichever gizmo is up.
          </>,
          <>Its caret sets how close a corner or an edge has to be before a drag takes it.</>,
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
        title: 'Sliding one',
        body: [
          <>
            <b>Drag</b> a sketch to slide it across its own surface. It stays on the face it
            landed on, and seeks that face's corners and edges as it goes.
          </>,
        ],
      },
      {
        title: 'Its arrows',
        body: [
          <>
            A selected sketch gets three: two along the outline's own edges, and one facing away
            from the face.
          </>,
        ],
      },
      {
        title: 'Depth',
        body: [
          <>
            <b>Drag</b> the arrow facing away from the face to set how far the shape stands out.
            Push it back through the face to cut inward instead.
          </>,
        ],
      },
      {
        title: 'Sizing and turning',
        body: [
          <>
            In <b>Scale</b>, drag either edge arrow to stretch the outline along it, or its ring
            to scale the whole outline -- the same way an object's ring scales the solid.
          </>,
          <>
            In <b>Rotate</b> a sketch gets ONE ring, since it spins in its own face and nowhere
            else.
          </>,
        ],
      },
      {
        title: 'Leaning an extrusion',
        body: [
          <>
            <b>Drag</b> the highlighted end face of an extrusion to lean it over.
          </>,
        ],
      },
      {
        title: 'Confirming it',
        body: [
          <>
            A sketch stays a handle for as long as you leave it one: the orange
            outline sits on the surface, still draggable, still resizable. When
            the shape is right, press <b>Confirm extrusion</b> at the top of{' '}
            <b>Position &amp; Rotation</b>.
          </>,
          <>
            The solid keeps everything the sketch built. What goes is the handle
            -- the outline stops being drawn in the scene, and the sketch stops
            being a row under its object in <b>Scene</b>. Like a subtraction it
            only goes one way, and <b>undo</b> is the way back.
          </>,
        ],
      },
    ],
  },

  {
    id: 'look',
    title: 'Colour and the console',
    blurb: 'What the scene is painted in, and where the panels that hold it are.',
    entries: [
      {
        title: 'Colour',
        body: [
          <>
            <b>Colour</b> paints the selected objects: turn the ring for the hue, the slider for
            brightness, then <b>Apply</b>.
          </>,
          <>
            Or type it straight into the <b>hex field</b> under Apply. That is also the way to
            reach a muted colour, since the ring carries hue alone.
          </>,
          <>
            Applied colours land on the <b>shelf</b> below; click one to load it back into the
            picker.
          </>,
        ],
      },
      {
        title: 'The console',
        body: [
          <>
            The column on the right holds the scene: <b>Clipboard</b>, <b>Solids</b>,{' '}
            <b>Shapes</b>, <b>Colour</b> and <b>Scene</b>.
          </>,
        ],
      },
      {
        title: 'The selection panels',
        body: [
          <>
            Selecting something slides its <b>position, rotation and size</b> into the
            bottom-right of the viewport. A selected sketch adds its own controls under them.
          </>,
        ],
      },
    ],
  },

  {
    id: 'files',
    title: 'Files and settings',
    blurb: 'What comes in, what goes out, and the few choices that outlive the document.',
    entries: [
      {
        title: 'Import',
        body: [
          <>
            <b>Import</b>, beside the app's name, reads GLB, OBJ, STL and STEP. The model lands
            as one solid you can size, move, cut and merge like anything built here.
          </>,
        ],
      },
      {
        title: 'Export',
        body: [
          <>
            <b>Export</b> writes the whole scene: <b>.glb</b>, <b>.obj</b> or <b>.stl</b> for a
            mesh, <b>.step</b> for a CAD solid.
          </>,
        ],
      },
      {
        title: 'Undo and redo',
        key: 'Ctrl+Z',
        body: [
          <>
            <b>Undo</b> and <b>Redo</b> in the top bar step through the document's history, and{' '}
            <b>Ctrl+Z</b> and <b>Ctrl+Shift+Z</b> do the same from the keyboard.
          </>,
        ],
      },
      {
        title: 'Units',
        body: [
          <>
            <b>Settings</b>, the cog at the end of the bar, holds <b>Units</b> -- mm, cm, or
            auto per value. It changes what the numbers are READ in; the model itself never
            changes.
          </>,
        ],
      },
      {
        title: 'Theme',
        body: [
          <>
            Which palette the app wears, in the same panel. It repaints the app and never an
            object's own colour, which is something you set and the file records.
          </>,
        ],
      },
      {
        title: 'Outlines',
        body: [
          <>
            The edge lines drawn around every solid, under Theme. Switch them <b>off</b> to see
            the surfaces bare -- a selected object still glows, so nothing is lost by it.
          </>,
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
 * they have anything to move it around. Remembering the last section read would
 * be a preference nobody asked for, and would open the screen mid-thought.
 */
export const DEFAULT_HELP_SECTION: HelpSectionId = HELP_SECTIONS[0].id
