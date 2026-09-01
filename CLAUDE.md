# Xiao Shua's 3D Editor

## New UI carries no explanations

A control is a name and the control itself. Nothing else ships beside it.

- **No tooltips.** No `title` attributes, no hover bubbles (`tip` on a field,
  `Tip`, `.tip-bubble`) on anything new. They are invisible to a touch screen,
  invisible to the keyboard, and gone the moment the pointer moves.
- **No explanatory prose in the UI.** No sentence under a control saying what it
  does, no lede under a panel or screen title, no helper line under a field. A
  row is its label and its switch.
- **If an explanation is genuinely needed, or is explicitly asked for**, put it
  behind a small "?" icon that reveals it on demand -- never in standing text
  and never on hover.
- **Where the explaining goes instead:** Help (`src/helpTopics.tsx`), which is a
  document and is built to be read. A new tool or setting that needs describing
  gets an entry there, not a paragraph next to itself.
- **This is about UI copy, not code.** Comments in the source stay as thorough
  as the rest of this codebase -- the rule is about what the user is made to
  read on screen.

`SettingsScreen.tsx` is the worked example: four rows, each a name and a switch,
no lede, no `title` anywhere. `ui-check.ts` guards it -- it asserts the screen
renders no `settings-blurb`, no `overlay-lede` and no ` title="`.
