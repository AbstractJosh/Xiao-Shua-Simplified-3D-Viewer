import { useEffect, useRef, useState } from 'react'
import { activePreset, useReference } from '../store/referenceStore'
import type { RefEdit, RefImage } from '../store/referenceStore'
import { flipCrop, turnCrop } from '../store/referenceStore'
import { useEditedUrl } from './editedImage'
import type { CropHandle } from './referenceImage'
import {
  CROP_RATIOS,
  FULL_CROP,
  editedSize,
  fitCrop,
  fractionRatio,
  isEdited,
  moveCrop,
  resizeCrop,
  turnedSize,
} from './referenceImage'

/**
 * The editor: flip it, turn it, crop it, and nothing else.
 *
 * WHAT IT IS NOT is the point of it. This is not an image editor -- there is no
 * brightness, no contrast, no colour, no filters -- because a reference is a
 * drawing somebody else made and the only things wrong with it are the things
 * that happen between a scanner and a screen: it came in sideways, it came in
 * mirrored, or there is half a desk around it. Three operations fix all three,
 * and every one of them is reversible.
 *
 * REVERSIBLE, which is the whole design. Nothing here rewrites the picture: the
 * flip, the turn and the crop are kept beside it and applied on the way out, so
 * a crop can be widened again tomorrow and the original is always underneath.
 * See `referenceImage.ts`, which composes them.
 *
 * THE CROP IS DRAWN ON THE TURNED PICTURE, not the original, because that is
 * the picture the user is looking at. Turning after cropping therefore has to
 * carry the crop round with it -- `turnCrop` -- or the rectangle jumps to a
 * part of the picture nobody pointed at.
 */
export function ReferenceEditor() {
  const editingId = useReference((s) => s.editingId)
  const preset = useReference(activePreset)
  const image = preset.slots.find((held) => held?.id === editingId) ?? null

  // Keyed by the image so a second image opened after a first starts fresh --
  // the snapshot below is taken on mount, and a component that outlived the
  // change would be holding the wrong picture's undo.
  return image ? <Editor key={image.id} image={image} /> : null
}

function Editor({ image }: { image: RefImage }) {
  const setEdit = useReference((s) => s.setEdit)
  const openEditor = useReference((s) => s.openEditor)

  /** What the picture wore on the way in, for Cancel to put back. */
  const original = useRef<RefEdit>(image.edit)
  const [handle, setHandle] = useState<CropHandle | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  /** Where the pointer was, in fractions, for a move rather than a resize. */
  const from = useRef<{ x: number; y: number } | null>(null)

  /**
   * The shape the crop is being held to, as a pixel ratio, or null for free.
   *
   * LOCAL, and deliberately not part of the edit. It is a constraint on the
   * DRAG rather than a property of the picture -- the same kind of thing as
   * Snap on the modelling screen -- so it has nothing to say once the editor is
   * shut, and storing it would mean a picture that remembered a lock nobody can
   * see and cannot switch off from outside.
   */
  const [lock, setLock] = useState<number | null>(null)

  const { edit } = image
  // The picture as it is SHOWN behind the crop: flipped and turned, but whole.
  // Its own bake, so the crop rectangle is drawn over the part of the picture
  // it is actually cutting away rather than over an already-cropped one.
  const shownUrl = useEditedUrl({ ...image, edit: { ...edit, crop: null } })
  const crop = edit.crop ?? FULL_CROP
  const shown = turnedSize(image.width, image.height, edit.turns)
  // What the ratio buttons mean in the frame the crop is stored in: a square of
  // PIXELS is only a square of fractions on a picture that is already square.
  const locked = lock === null ? null : fractionRatio(lock, shown.width / shown.height)
  // What the block will get, which is the number the ratio buttons are pressed
  // to control -- so it is the one worth showing, and it moves as you drag.
  const output = editedSize(image)

  const close = (keep: boolean) => {
    if (!keep) setEdit(image.id, original.current)
    openEditor(null)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Stopped here, or the viewport takes it as "clear the selection" on the
      // way past and the editor closes AND something else changes.
      e.stopPropagation()
      close(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  /** Where a pointer is over the picture, in fractions of it. */
  const at = (e: { clientX: number; clientY: number }) => {
    const box = frame.current?.getBoundingClientRect()
    if (!box || !box.width || !box.height) return { x: 0, y: 0 }
    return {
      x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)),
    }
  }

  const write = (next: Partial<RefEdit>) => setEdit(image.id, { ...edit, ...next })

  const turn = (quarter: 1 | -1) => {
    const turns = ((((edit.turns + quarter) % 4) + 4) % 4) as RefEdit['turns']
    const turned = edit.crop ? turnCrop(edit.crop, quarter) : null
    // A turn takes the crop round with the picture, which leaves a 4:3 crop
    // lying 3:4 -- correct as a rectangle and wrong as a LOCK, which is a
    // promise about the shape. So a locked crop is refitted afterwards, against
    // the picture's new way round. For 1:1 that is a no-op, since a square
    // turned is a square.
    const after = turnedSize(image.width, image.height, turns)
    const next =
      turned && lock !== null
        ? fitCrop(turned, fractionRatio(lock, after.width / after.height))
        : turned
    write({ turns, crop: next })
  }

  /** Take up a ratio, or put one down, and reshape what is there to suit. */
  const takeRatio = (ratio: number | null) => {
    setLock(ratio)
    // Pressed with nothing cropped yet, it crops: that is the whole gesture the
    // button exists for -- open a picture, press 1:1, and there is a square in
    // the middle of it to nudge about.
    if (ratio !== null) {
      write({ crop: fitCrop(crop, fractionRatio(ratio, shown.width / shown.height)) })
    }
  }

  const flip = (axis: 'x' | 'y') =>
    write({
      [axis === 'x' ? 'flipX' : 'flipY']: axis === 'x' ? !edit.flipX : !edit.flipY,
      crop: edit.crop ? flipCrop(edit.crop, axis) : null,
    })

  const dragTo = (e: { clientX: number; clientY: number }) => {
    if (!handle) return
    const p = at(e)
    if (handle === 'move') {
      const was = from.current ?? p
      from.current = p
      write({ crop: moveCrop(crop, p.x - was.x, p.y - was.y) })
    } else {
      write({ crop: resizeCrop(crop, handle, p.x, p.y, locked) })
    }
  }

  // The rectangle, in per-cent, which is what the overlay is positioned in.
  const box: Record<string, string> = {
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.w * 100}%`,
    height: `${crop.h * 100}%`,
  }

  return (
    <div
      className="ref-editor-backdrop"
      onPointerDown={(e) => {
        // Only a press that STARTS on the surround dismisses: a crop drag that
        // wanders off the picture must not close the editor when it ends.
        if (e.target === e.currentTarget) close(false)
      }}
    >
      <div className="ref-editor" role="dialog" aria-modal="true" aria-labelledby="ref-editor-title">
        <div className="ref-editor-head">
          <h2 className="ref-editor-title" id="ref-editor-title">
            {image.name}
          </h2>
          {/* WHAT COMES OUT, not what went in: it is the number the ratio
              buttons are pressed to control, and watching it while a corner is
              dragged is how you can see a square being a square. */}
          <span className="ref-editor-size">
            {output.width} x {output.height}
          </span>
        </div>

        <div
          className="ref-editor-stage"
          onPointerMove={dragTo}
          onPointerUp={() => {
            setHandle(null)
            from.current = null
          }}
          onPointerLeave={() => {
            setHandle(null)
            from.current = null
          }}
        >
          <div
            className="ref-editor-frame"
            ref={frame}
            style={{ aspectRatio: `${shown.width} / ${shown.height}` }}
          >
            {shownUrl && <img className="ref-editor-img" src={shownUrl} alt="" draggable={false} />}

            {/* The part being thrown away, dimmed rather than hidden: a crop is
                a decision about what to lose, and it cannot be judged against a
                picture that has already lost it. */}
            <div className="ref-editor-shade" style={box} />

            <div
              className="ref-editor-crop"
              style={box}
              onPointerDown={(e) => {
                e.preventDefault()
                from.current = at(e)
                setHandle('move')
              }}
            >
              {(['nw', 'ne', 'se', 'sw'] as const).map((corner) => (
                <button
                  key={corner}
                  type="button"
                  className={`ref-editor-handle ref-handle-${corner}`}
                  aria-label={`Crop from the ${
                    { nw: 'top left', ne: 'top right', se: 'bottom right', sw: 'bottom left' }[corner]
                  }`}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setHandle(corner)
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        {/* THE SHAPE THE CROP IS HELD TO, on its own row above the tools and
            below the picture -- between the thing it acts on and the things
            that act on the picture as a whole.

            It is the app's own segmented switch rather than a new control:
            "one of these, and it stays chosen" is exactly what the unit picker
            says with the same three classes, and a second thing that looks like
            it but is not it is how two controls quietly stop matching. */}
        <div className="ref-editor-ratios">
          <span className="ref-ratio-label">Crop</span>
          <div className="seg" role="group" aria-label="Crop ratio">
            {CROP_RATIOS.map(({ label, ratio }) => (
              <button
                key={label}
                type="button"
                className={`seg-btn${lock === ratio ? ' seg-active' : ''}`}
                aria-pressed={lock === ratio}
                title={
                  ratio === null
                    ? 'Crop to any shape'
                    : `Hold the crop to ${label}${label === '1:1' ? ' -- square' : ''}`
                }
                onClick={() => takeRatio(ratio)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="ref-editor-tools">
          <button type="button" className="ref-tool" title="Flip left to right" onClick={() => flip('x')}>
            <FlipIcon />
            Flip H
          </button>
          <button type="button" className="ref-tool" title="Flip top to bottom" onClick={() => flip('y')}>
            <FlipIcon vertical />
            Flip V
          </button>
          <button type="button" className="ref-tool" title="Turn a quarter anticlockwise" onClick={() => turn(-1)}>
            <TurnIcon back />
            Rotate left
          </button>
          <button type="button" className="ref-tool" title="Turn a quarter clockwise" onClick={() => turn(1)}>
            <TurnIcon />
            Rotate right
          </button>
          <button
            type="button"
            className="ref-tool"
            title="Use the whole picture again"
            disabled={!edit.crop}
            onClick={() => write({ crop: null })}
          >
            Whole picture
          </button>
          <button
            type="button"
            className="ref-tool"
            title="Put the picture back as it came in"
            disabled={!isEdited(edit)}
            onClick={() => {
              // The lock goes with it. "Back as it came in" that left a ratio
              // armed would be a reset with a setting still on.
              setLock(null)
              setEdit(image.id, { flipX: false, flipY: false, turns: 0, crop: null })
            }}
          >
            Reset
          </button>
        </div>

        <div className="ref-editor-foot">
          {/* Cancel puts back what was worn on the way in; Done keeps what is on
              screen. Both are needed because every change here is live -- the
              tile and the block are already showing it, which is the only way to
              judge a crop. */}
          <button type="button" className="ref-btn" onClick={() => close(false)}>
            Cancel
          </button>
          <button type="button" className="ref-btn ref-btn-go" onClick={() => close(true)}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function FlipIcon({ vertical = false }: { vertical?: boolean }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden className={vertical ? 'ref-icon-v' : undefined}>
      <path d="M6 1.4 V10.6" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="1.6 1.4" />
      <path d="M4.6 3 H1.6 V9 H4.6 Z M7.4 3 H10.4 V9 H7.4 Z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  )
}

function TurnIcon({ back = false }: { back?: boolean }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden className={back ? 'ref-icon-back' : undefined}>
      <path
        d="M2.6 6.4 A3.6 3.6 0 1 1 6.2 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path d="M1 4.6 L2.7 6.6 L4.6 5.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
