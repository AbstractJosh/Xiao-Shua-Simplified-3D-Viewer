import { useRef, useState } from 'react'
import {
  MAX_PRESETS,
  REFERENCE_ACCEPT,
  SLOTS_PER_PRESET,
  activePreset,
  useReference,
} from '../store/referenceStore'
import type { RefImage } from '../store/referenceStore'
import { useTools } from '../store/toolStore'
import { releaseEdited, useEditedUrl } from './editedImage'
import { NumberField, Section } from './Field'
import { isReferenceFile, readReferenceFile, shortName } from './referenceImage'

/** What the slots are for, on the slots themselves. */
const SLOT_HINT = 'Click to add up to three PNGs, JPEGs or SVGs'

/**
 * Which slots a batch of pictures lands in, starting from the one that was
 * asked for.
 *
 * FORWARD FROM THERE, WRAPPING ROUND. Three pictures fill all three slots
 * whichever plus was pressed, which is the only thing "add three at once" can
 * mean on a shelf of three -- the alternative, stopping at the end and refusing
 * the rest, makes the answer depend on which of three identical buttons the
 * pointer happened to be nearest, and a plan, an elevation and a detail chosen
 * together belong on the shelf together.
 *
 * IT NEVER TAKES MORE THAN THE SHELF HOLDS. Past three, the fourth would land
 * back on the first and replace a picture that arrived in the same breath --
 * one gesture undoing itself. The extras are refused instead, and the panel
 * says so.
 *
 * Pure, and exported, because the wrap is the sort of thing that is off by one
 * in exactly one of the three starting positions.
 */
export function slotsFor(from: number, count: number): number[] {
  const out: number[] = []
  const start = ((from % SLOTS_PER_PRESET) + SLOTS_PER_PRESET) % SLOTS_PER_PRESET
  for (let i = 0; i < Math.min(Math.max(count, 0), SLOTS_PER_PRESET); i++) {
    out.push((start + i) % SLOTS_PER_PRESET)
  }
  return out
}

/**
 * The reference shelf: the drawings you are cutting to.
 *
 * WHY IT IS ON THIS CONSOLE AND NO OTHER. A reference is a thing you follow
 * with a tool. The lathe has no face to lay one on and the modelling screen has
 * a document full of surfaces that would each need their own answer to what a
 * cut does to a picture; the laser cutter has one block, six flat faces and a
 * beam that goes where the drawing says. So it lives here, where it is used.
 *
 * PRESETS, AND WHY THEY ARE SETS RATHER THAN A LONGER SHELF. Three slots is
 * what one job needs -- a plan, an elevation, a detail -- and a fourth image is
 * usually a different job rather than more of this one. So the panel holds sets
 * of three and swaps between them, and switching sets takes the block's decals
 * with it: a preset is a whole set-up, not a folder. Coming back brings the
 * whole thing back, which is what makes it worth switching away.
 *
 * ONE OPACITY FOR ALL OF THEM, under the slots rather than on each tile. Two
 * references at two opacities is a comparison nobody asked for, and the number
 * is only ever moved for one reason: the drawing is fighting the surface it is
 * on. That is a fact about the pair of them, so it is one control.
 *
 * A LIT SLOT IS A PICTURE IN HAND. Press a tile and it lights: that drawing --
 * wherever it is on the block -- is the one wearing handles, and the one Delete
 * takes off the block. It is the panel's answer to a question the block could
 * not answer, since a decal you want to take off may be on a face you are not
 * looking at, and it is the only way off short of throwing the file away. The
 * light goes out when a cutter is taken up, so a drawing being cut to is never
 * wearing furniture -- see `LaserViewport`.
 */
export function ReferencePanel() {
  const presets = useReference((s) => s.presets)
  const activeId = useReference((s) => s.activePresetId)
  const preset = useReference(activePreset)
  const opacity = useReference((s) => s.opacity)

  const choosePreset = useReference((s) => s.choosePreset)
  const addPreset = useReference((s) => s.addPreset)
  const removePreset = useReference((s) => s.removePreset)
  const renamePreset = useReference((s) => s.renamePreset)
  const putImage = useReference((s) => s.putImage)
  const setOpacity = useReference((s) => s.setOpacity)

  const fileInput = useRef<HTMLInputElement>(null)
  /** Which slot the file picker was opened for. */
  const forSlot = useRef(0)
  /** Why the last upload did not happen, if it did not. */
  const [note, setNote] = useState<string | null>(null)
  /** The name being typed, bound only while it is being edited. */
  const [draftName, setDraftName] = useState<string | null>(null)

  const filled = preset.slots.filter(Boolean).length

  const pick = (slot: number) => {
    forSlot.current = slot
    setNote(null)
    fileInput.current?.click()
  }

  /**
   * Pictures into slots: one, or a whole shelf-full in one go.
   *
   * A LIST RATHER THAN A FILE, because both ways in hand you several at once --
   * the picker takes a ctrl-click and the desktop drags a selection -- and a
   * panel that silently kept the first of three would be one you had to use
   * three times without being told why.
   *
   * READ TOGETHER, PLACED IN ORDER. The files are decoded in parallel, since
   * they are three independent reads and a queue would make the shelf fill one
   * picture at a time; but they land in the order they were CHOSEN, so the
   * shelf reads like the picker did rather than like whichever file happened to
   * decode first.
   *
   * A BAD FILE COSTS NO SLOT. One unreadable picture among three does not leave
   * a hole in the middle: what lands is what was read, packed from the slot
   * that was asked for. See `slotsFor` for where they go.
   */
  const take = async (chosen: FileList | File[] | null | undefined, from: number) => {
    const files = Array.from(chosen ?? [])
    if (files.length === 0) return

    const usable = files.filter(isReferenceFile)
    const wrongType = files.filter((f) => !isReferenceFile(f))
    const tooMany = Math.max(0, usable.length - SLOTS_PER_PRESET)

    // One shape whether it worked or not, so what comes back is two lists
    // rather than a union to pick apart: the pictures, and what went wrong.
    const read = await Promise.all(
      usable.slice(0, SLOTS_PER_PRESET).map(async (file) => {
        try {
          const image = await readReferenceFile(file)
          return { image, failed: null as string | null }
        } catch (err) {
          const failed = err instanceof Error ? err.message : 'That image could not be read'
          return { image: null as Awaited<ReturnType<typeof readReferenceFile>> | null, failed }
        }
      })
    )

    const landed = read.map((r) => r.image).filter((image) => image !== null)
    const slots = slotsFor(from, landed.length)
    landed.forEach((image, i) => putImage(slots[i], image))

    // ONE LINE, and only about what did not happen: a note that also reported
    // the successes would be a receipt for something the shelf is already
    // showing.
    const failed = read.map((r) => r.failed).filter((why) => why !== null)
    if (failed.length > 0) setNote(failed[0])
    else if (wrongType.length === 1) setNote(`${wrongType[0].name} is not a PNG, JPEG or SVG`)
    else if (wrongType.length > 1) setNote(`${wrongType.length} of those are not PNG, JPEG or SVG`)
    else if (tooMany > 0) setNote(`Three slots to a preset, so the first three went in`)
    else setNote(null)
  }

  return (
    <Section
      title="Reference"
      hint={`${filled}/${SLOTS_PER_PRESET}`}
      tip="Drawings to cut to. Add up to three PNGs, JPEGs or SVGs at once, then drag one onto a face of the block. Presets hold three images each; switching preset takes its references off the block and brings the new one's back."
      collapsible
      defaultOpen
    >
      <div className="ref-presets">
        {/* Switching, renaming, adding and removing -- one row, and the name is
            never written twice. The dropdown IS the name until the pencil is
            pressed, at which point the field takes its place: two controls
            showing the same word, one of them editable, is a panel asking which
            of the two you meant. */}
        {draftName === null ? (
          <select
            className="ref-select"
            aria-label="Preset"
            value={activeId}
            onChange={(e) => choosePreset(e.target.value)}
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="ref-name"
            value={draftName}
            autoFocus
            aria-label={`Name of ${preset.name}`}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={() => {
              renamePreset(preset.id, draftName)
              setDraftName(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                // Abandoned here rather than let through to the viewport, where
                // Escape means something else entirely.
                e.stopPropagation()
                setDraftName(null)
              }
            }}
          />
        )}

        <button
          type="button"
          className="ref-preset-btn"
          title={`Rename ${preset.name}`}
          aria-label="Rename this preset"
          onClick={() => setDraftName(draftName === null ? preset.name : null)}
        >
          {/* The tile's own pencil, at the size the row wears. One glyph for
              one verb, wherever the verb turns up. */}
          <svg viewBox="0 0 12 12" aria-hidden>
            <path
              d="M8.1 1.9 L10.1 3.9 L4.6 9.4 L2 10 L2.6 7.4 Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <button
          type="button"
          className="ref-preset-btn"
          title={
            presets.length >= MAX_PRESETS
              ? `Five presets is the most there can be`
              : 'Add a preset'
          }
          aria-label="Add a preset"
          disabled={presets.length >= MAX_PRESETS}
          onClick={() => {
            setDraftName(null)
            addPreset()
          }}
        >
          <svg viewBox="0 0 10 10" aria-hidden>
            <path
              d="M5 1.6 V8.4 M1.6 5 H8.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <button
          type="button"
          className="ref-preset-btn"
          title={
            presets.length <= 1
              ? 'The last preset stays: empty its slots instead'
              : `Delete ${preset.name} and its references`
          }
          aria-label="Delete this preset"
          disabled={presets.length <= 1}
          onClick={() => {
            setDraftName(null)
            for (const held of preset.slots) if (held) releaseEdited(held.id)
            removePreset(preset.id)
          }}
        >
          <svg viewBox="0 0 10 10" aria-hidden>
            <path
              d="M2.5 2.5 L7.5 7.5 M7.5 2.5 L2.5 7.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="ref-grid">
        {preset.slots.map((held, i) =>
          held ? (
            <ReferenceTile key={held.id} image={held} />
          ) : (
            <button
              key={`empty-${i}`}
              type="button"
              className="ref-slot"
              title={SLOT_HINT}
              aria-label={`Add a reference image to slot ${i + 1}`}
              onClick={() => pick(i)}
              // A file dropped from the desktop straight onto a slot, which is
              // the gesture anybody with a folder of drawings open will try
              // first. `preventDefault` on the dragover is what makes the drop
              // land here rather than navigating the window to the file.
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                // The whole selection, not the first of it: dragging three
                // drawings out of a folder is one gesture and means all three.
                void take(e.dataTransfer.files, i)
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden>
                <path
                  d="M12 7 V17 M7 12 H17"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )
        )}
      </div>

      {note && <p className="ref-note">{note}</p>}

      {/* One number for every reference on the block. Below the slots because
          it is about all of them at once -- see the note at the top. */}
      <NumberField
        label="Opacity"
        value={Math.round(opacity * 100)}
        min={0}
        max={100}
        step={1}
        decimals={0}
        resetTo={75}
        tip="How strongly every reference is drawn on the block. One number for all of them, so two drawings on two faces read the same."
        onChange={(v) => setOpacity(v / 100)}
      />

      <input
        ref={fileInput}
        type="file"
        className="ref-file"
        // THREE AT A TIME. The shelf holds three, so the picker offers three:
        // a plan, an elevation and a detail are chosen in one breath, and
        // opening the same dialog three times to say so is the tax this was
        // charging. What lands where is `slotsFor`.
        multiple
        accept={REFERENCE_ACCEPT}
        onChange={(e) => {
          const files = e.target.files
          // Cleared so the same file can be chosen again after being deleted --
          // an input holding the same value fires no change event.
          const chosen = files ? Array.from(files) : []
          e.target.value = ''
          void take(chosen, forSlot.current)
        }}
      />
    </Section>
  )
}

/**
 * One filled slot: the picture, what it is called, and the two things you can
 * do to it.
 *
 * THE WHOLE TILE IS THE DRAG SOURCE, the way a Clipboard tile is: press it and
 * the image is in your hand, and the block takes it from there. The two buttons
 * sit over it and appear on hover, which is the same bargain the Clipboard's
 * remove button strikes -- a tile is a picture until you point at it, and a
 * picture with two permanent buttons on it is a toolbar.
 */
function ReferenceTile({ image }: { image: RefImage }) {
  const startDrag = useReference((s) => s.startDrag)
  const openEditor = useReference((s) => s.openEditor)
  const removeImage = useReference((s) => s.removeImage)
  const dragging = useReference((s) => s.drag?.imageId === image.id)
  const highlight = useReference((s) => s.highlight)
  const lit = useReference((s) => s.highlightId === image.id)
  const onBlock = useReference((s) => s.placements.some((p) => p.imageId === image.id))
  const setLaserTool = useTools((s) => s.setLaserTool)
  const url = useEditedUrl(image)
  const name = shortName(image.name)

  return (
    <div
      className={`ref-tile${dragging ? ' ref-tile-dragging' : ''}${lit ? ' ref-tile-lit' : ''}`}
    >
      <div
        className="ref-grab"
        role="button"
        tabIndex={0}
        // ONE PRESS, TWO ANSWERS, and which one it was is decided by what the
        // pointer does next: let go on the tile and you have lit the slot, drag
        // onto a face and you have placed a picture. They are the same gesture
        // because they are the same intent -- "this one" -- and asking for a
        // click to select and a drag to place would be two ways of pointing at
        // one tile.
        aria-pressed={lit}
        title={
          onBlock
            ? `${image.name}: drag onto a face, or click to take hold of the ones already on the block`
            : `Drag ${image.name} onto a face of the block`
        }
        aria-label={`${image.name}, drag onto the block`}
        onPointerDown={(e) => {
          // The press must not select the name behind it or start the browser's
          // own image drag; the block picks the pointer up from here.
          e.preventDefault()
          // AND IT TAKES UP MOVE, which is the tool the picture is about to
          // need. Dragging a reference in and finding it inert until you have
          // also found the button that makes it draggable is the sequence
          // nobody would guess -- and whatever was in hand before was a cutter,
          // which is the one thing you certainly are not doing right now.
          setLaserTool('move')
          // LIT, which is what arms the handles on it and what Delete acts on.
          // It happens on the way past whether the press turns out to be a drag
          // or a click: a picture you are dragging in is a picture you are
          // about to want hold of.
          highlight(image.id)
          startDrag(image.id)
        }}
      >
        {/* Checkered behind, so a drawing on transparency reads as one rather
            than as a picture of the panel. */}
        {url ? (
          <img className="ref-thumb" src={url} alt="" draggable={false} />
        ) : (
          <span className="ref-thumb-wait" aria-hidden />
        )}
      </div>

      <span className="ref-tile-name" title={image.name}>
        {name}
      </span>

      <div className="ref-tile-acts">
        <button
          type="button"
          className="ref-act"
          title={`Edit ${image.name}`}
          aria-label={`Edit ${image.name}`}
          onClick={() => openEditor(image.id)}
        >
          {/* A pencil: the nib, and the line it has drawn. */}
          <svg viewBox="0 0 12 12" aria-hidden>
            <path
              d="M8.1 1.9 L10.1 3.9 L4.6 9.4 L2 10 L2.6 7.4 Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className="ref-act"
          title={`Delete ${image.name}`}
          aria-label={`Delete ${image.name}`}
          onClick={() => {
            releaseEdited(image.id)
            removeImage(image.id)
          }}
        >
          {/* A bin: lid, body, and the two lines down it. */}
          <svg viewBox="0 0 12 12" aria-hidden>
            <path
              d="M2.5 3.3 H9.5 M4.6 3.3 V2.2 H7.4 V3.3 M3.4 3.3 L3.9 10 H8.1 L8.6 3.3 M5.2 5 V8.4 M6.8 5 V8.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  )
}
