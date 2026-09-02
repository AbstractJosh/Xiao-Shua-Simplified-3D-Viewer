import { create } from 'zustand'

/**
 * Reference images: what the laser cutter is cutting TO.
 *
 * A drawing you are following is not part of the piece and never becomes part
 * of it. It is stuck to a face, it is looked at while you aim, and the cut goes
 * where it says -- so it belongs beside the block rather than in it, and this
 * store sits next to `laserStore` for the same reason that one sits next to
 * `docStore`: the block is what you are working ON, this is what you are
 * working FROM, and neither is a document.
 *
 * WHY PLACEMENTS LIVE HERE AND NOT ON THE BLOCK. A decal is drawn ON the
 * block's surface, so it is tempting to hang it off the block. But an image
 * dropped on a face outlives every size the block has been -- it is a fact
 * about the reference, kept in the reference's own frame, and re-derived
 * against whatever the block currently is. See `referenceDecals.ts`, which
 * holds all of that arithmetic and none of this state.
 *
 * NOTHING HERE PERSISTS. Reload and the shelf is empty, exactly as the
 * Clipboard is. Uploaded images are held as data URLs in memory; a browser
 * store for them is a later job, and a deliberate one, because it is the first
 * thing in this app that would keep a user's file after they closed the tab.
 */

/** How many images one preset holds. Three, and the panel is built for three. */
export const SLOTS_PER_PRESET = 3

/**
 * How many presets there can be.
 *
 * Five, because the dropdown is a list you pick from at a glance rather than
 * scroll -- and because a preset is a set-up for one job, not a library. The
 * plus is disabled at the cap rather than hidden, so the ceiling is something
 * you can see before you hit it.
 */
export const MAX_PRESETS = 5

/**
 * How many decals one preset may have on the block: every picture on every
 * face.
 *
 * A real ceiling rather than a defensive one -- the shader paints this many and
 * the store refuses the drop that would exceed it, so the two cannot disagree.
 * Past three pictures on six faces the panel is being used as a texture library
 * rather than as a set of drawings.
 */
export const MAX_PLACEMENTS = SLOTS_PER_PRESET * 6

/**
 * What the file input takes.
 *
 * Extensions AND media types: a browser given only the extensions will still
 * grey out a file whose name is right and whose type it doubts, and one given
 * only the types cannot filter a drag from the desktop.
 */
export const REFERENCE_ACCEPT = '.png,.jpg,.jpeg,.svg,image/png,image/jpeg,image/svg+xml'

/** Opacity a freshly opened panel draws its references at. */
export const DEFAULT_REFERENCE_OPACITY = 0.75

/**
 * A crop, as the fraction of the image it KEEPS.
 *
 * Fractions rather than pixels so a crop survives the image being re-rasterised
 * at another size -- an SVG redrawn larger is the same picture, and a crop
 * written in its old pixels would be a crop of somewhere else.
 *
 * Expressed in the frame the image is SHOWN in, after any flip and turn. That
 * is the frame the crop was dragged in, so it is the only one where the numbers
 * mean what the user did; a flip or a turn afterwards moves the crop with the
 * picture, which is `flipCrop` and `turnCrop`'s whole job.
 */
export type Crop = { x: number; y: number; w: number; h: number }

/** What the editor does to an image, kept beside it rather than baked into it. */
export type RefEdit = {
  flipX: boolean
  flipY: boolean
  /** Quarter turns clockwise: 0, 1, 2 or 3. */
  turns: 0 | 1 | 2 | 3
  /** What is kept, or null for the whole picture. */
  crop: Crop | null
}

export const NO_EDIT: RefEdit = { flipX: false, flipY: false, turns: 0, crop: null }

/** One uploaded picture, as it arrived and as it is to be shown. */
export type RefImage = {
  id: string
  /** The file's own name, which is what the user will recognise it by. */
  name: string
  /** A data URL. SVG is rasterised on the way in -- see `rasterise`. */
  src: string
  /** Natural size in pixels, which is where the aspect ratio comes from. */
  width: number
  height: number
  edit: RefEdit
}

/** Three slots under a name. Switching presets swaps what the panel offers. */
export type Preset = {
  id: string
  name: string
  /** Always `SLOTS_PER_PRESET` long. A null is an empty slot, not a gap. */
  slots: (RefImage | null)[]
}

/** Which face of the block a decal is stuck to. */
export type Face = '+x' | '-x' | '+y' | '-y' | '+z' | '-z'

/**
 * One image, stuck to one face.
 *
 * IN THE FACE'S OWN FRAME, offset from the middle of it, in scene units. Not in
 * world coordinates: the block is resized while references are on it, and an
 * offset from the centre is the one description of "here" that still means the
 * same place afterwards. See `placementRect`.
 */
export type Placement = {
  id: string
  /** The preset it came from. Switching presets hides the ones not in hand. */
  presetId: string
  imageId: string
  face: Face
  /** Centre, as an offset from the face's centre, in scene units. */
  u: number
  v: number
  /** How big it is drawn on the face, in scene units. */
  w: number
  h: number
}

/** A drag from the panel that has not landed yet. */
export type RefDrag = {
  imageId: string
  /** Where it would land, or null while the pointer is off the block. */
  at: { face: Face; u: number; v: number } | null
}

/**
 * Which corner of a decal is in hand: which way along the face's own u and v.
 *
 * ALL FOUR ARE GRIPS, and each anchors the one opposite -- pull the top left
 * and the bottom right stays where it is. One corner would have been less to
 * draw, but it makes every picture growable in one direction only: a reference
 * sat against the right-hand edge of a face could not be made bigger at all
 * without first being slid out of the way.
 */
export type Corner = { su: -1 | 1; sv: -1 | 1 }

/**
 * A decal being pushed about on the face it is already on.
 *
 * IN THE STORE rather than in the component that started it, because the hand
 * and the eye are two different components: the press lands on a handle, and
 * every move after it lands on the BLOCK, which is the only surface wide enough
 * to catch a drag that has run past the picture it started on.
 *
 * A union rather than a mode with an optional corner, because a move has no
 * corner and never will: the shape says which of the two gestures is running.
 */
export type RefGrab =
  | { id: string; mode: 'move' }
  | { id: string; mode: 'size'; corner: Corner }

let counter = 0
const nextId = (prefix: string): string => {
  counter += 1
  return `${prefix}${counter}`
}

/**
 * Moves that counter past ids that already exist, for presets and pictures
 * restored from a previous session.
 *
 * ONE COUNTER FOR ALL THREE PREFIXES, which is why this takes ids of any kind
 * and reads the number off whichever it is handed: `p2` and `i2` never both
 * exist, because the counter that minted one had already passed the other. A
 * restored shelf that did not seed it would mint an `i1` for the next upload
 * over a picture already sitting in a slot. See `persist.ts`.
 */
export function seedReferenceIds(ids: string[]): void {
  for (const id of ids) {
    const numbered = /^[pid]([0-9]+)$/.exec(id)
    if (numbered) counter = Math.max(counter, Number(numbered[1]))
  }
}

/** An empty preset's three holes. A fresh array each time: they are mutated. */
const emptySlots = (): (RefImage | null)[] => Array.from({ length: SLOTS_PER_PRESET }, () => null)

/**
 * The lowest `Preset N` nobody is using.
 *
 * Lowest-unused rather than a climbing counter, for the reason the Clipboard's
 * names work the same way: deleting preset 2 of three should free the name, not
 * leave a hole and offer "Preset 4" next.
 */
export function nextPresetName(presets: { name: string }[]): string {
  const taken = new Set(presets.map((p) => p.name))
  for (let n = 1; ; n++) {
    const name = `Preset ${n}`
    if (!taken.has(name)) return name
  }
}

/**
 * A crop moved into the frame the picture is in after `turns` quarter turns
 * clockwise.
 *
 * The crop is stored in the shown frame, so turning the picture has to turn the
 * crop with it or the rectangle the user dragged jumps to somewhere they never
 * pointed at. One quarter turn clockwise takes (x, y) to (1 - y - h, x) and
 * swaps the sides; the rest is that, repeated.
 *
 * Pure and exported, because it is arithmetic with an off-by-one in it that a
 * check can catch and an eye cannot.
 */
export function turnCrop(crop: Crop, turns: number): Crop {
  let out = crop
  const n = ((turns % 4) + 4) % 4
  for (let i = 0; i < n; i++) {
    out = { x: 1 - out.y - out.h, y: out.x, w: out.h, h: out.w }
  }
  return out
}

/** A crop mirrored with the picture, in the same shown frame. */
export function flipCrop(crop: Crop, axis: 'x' | 'y'): Crop {
  return axis === 'x'
    ? { ...crop, x: 1 - crop.x - crop.w }
    : { ...crop, y: 1 - crop.y - crop.h }
}

type ReferenceState = {
  presets: Preset[]
  activePresetId: string
  /** One number for every reference on the block, so they stay uniform. */
  opacity: number
  placements: Placement[]
  /** The image being edited, or null when the editor is shut. */
  editingId: string | null
  /**
   * The image whose slot is lit in the panel, or null.
   *
   * AN IMAGE AND NOT A PLACEMENT, because the thing that gets lit is a SLOT --
   * the panel has three of them and the block may be wearing the same picture
   * on six faces. Lighting the slot arms every copy of it at once: they all
   * take handles, and one Delete takes them all off the block.
   *
   * IT IS WHAT ARMS THE HANDLES. Move in hand used to put grips on every decal
   * on the block, which made a face wearing three drawings a face of grips; now
   * the tool says WHAT you are doing and the lit slot says WHICH picture you
   * are doing it to. A cutter taken up puts it out -- see `LaserViewport` --
   * so a drawing being cut to is never wearing furniture.
   */
  highlightId: string | null
  drag: RefDrag | null
  grab: RefGrab | null

  choosePreset: (id: string) => void
  addPreset: () => void
  removePreset: (id: string) => void
  renamePreset: (id: string, name: string) => void

  /** Puts an image in a slot of the active preset, replacing what was there. */
  putImage: (slot: number, image: Omit<RefImage, 'id' | 'edit'>) => void
  removeImage: (imageId: string) => void
  setEdit: (imageId: string, edit: RefEdit) => void
  setOpacity: (opacity: number) => void
  openEditor: (imageId: string | null) => void
  /** Lights a slot, or puts the light out. An image that is gone lights nothing. */
  highlight: (imageId: string | null) => void

  startDrag: (imageId: string) => void
  dragOver: (at: RefDrag['at']) => void
  /** Lands the dragged image; the caller supplies the size it should land at. */
  dropDrag: (size: { w: number; h: number }) => void
  cancelDrag: () => void

  startGrab: (grab: RefGrab) => void
  endGrab: () => void

  movePlacement: (id: string, u: number, v: number) => void
  /**
   * The whole rectangle at once, because a corner pull moves the middle.
   *
   * Anchoring the corner opposite the one in hand means the centre travels
   * every time the size changes -- written as two calls they would be two
   * renders, and the picture would jump between them. See `resizeFromCorner`,
   * which is where the four numbers come from.
   */
  sizePlacement: (id: string, rect: { u: number; v: number; w: number; h: number }) => void
  removePlacement: (id: string) => void
  /**
   * Every copy of one picture, off the block -- and the picture itself stays
   * in the panel.
   *
   * THE OTHER HALF OF `removeImage`, and the difference between them is the
   * whole point: that one throws the drawing away, this one puts it back on the
   * shelf. Without it the only way to get a reference off a face was to delete
   * the file and upload it again, which is a screen where a placement is
   * permanent.
   */
  clearPlacementsOf: (imageId: string) => void
  /**
   * Every drawing off the block, in every preset. The shelf is untouched.
   *
   * THE BULK OF `clearPlacementsOf`, and it goes wider than the eye can see on
   * purpose: a preset that is not in hand still has decals waiting to come back
   * with it, so a reset that cleared only the visible ones would leave a block
   * that goes bare, and then wears drawings again the moment the dropdown
   * moves. Reset is the strongest word this app has for "back to nothing", and
   * one that left something behind would not have earned it.
   */
  clearPlacements: () => void
}

const firstPreset = (): Preset => ({ id: nextId('p'), name: 'Preset 1', slots: emptySlots() })

export const useReference = create<ReferenceState>((set, get) => {
  const start = firstPreset()
  return {
    presets: [start],
    activePresetId: start.id,
    opacity: DEFAULT_REFERENCE_OPACITY,
    placements: [],
    editingId: null,
    highlightId: null,
    drag: null,
    grab: null,

    // The light goes out with the switch. A slot lit in a preset you are no
    // longer holding would arm Delete against a picture that is not on the
    // block and not in the panel.
    choosePreset: (id) =>
      set((s) =>
        s.activePresetId === id || !s.presets.some((p) => p.id === id)
          ? s
          : { activePresetId: id, highlightId: null }
      ),

    // At the cap this is a no-op rather than a silent replace. The button that
    // calls it is disabled there too; this is the half that cannot be reached
    // by a keyboard on a stale render.
    addPreset: () =>
      set((s) => {
        if (s.presets.length >= MAX_PRESETS) return s
        const preset: Preset = { id: nextId('p'), name: nextPresetName(s.presets), slots: emptySlots() }
        return { presets: [...s.presets, preset], activePresetId: preset.id, highlightId: null }
      }),

    // The last preset is never removed: a panel with no preset has nowhere to
    // put an image, and "delete the last one" is what `Reset` would mean if
    // this panel had one. Emptying its slots is how you clear it.
    removePreset: (id) =>
      set((s) => {
        if (s.presets.length <= 1) return s
        const at = s.presets.findIndex((p) => p.id === id)
        if (at < 0) return s
        const presets = s.presets.filter((p) => p.id !== id)
        return {
          presets,
          // The neighbour, so deleting the one you are on leaves you somewhere
          // rather than on the first every time.
          activePresetId:
            s.activePresetId === id ? presets[Math.min(at, presets.length - 1)].id : s.activePresetId,
          // A preset's decals go with it. They were only ever drawn while it
          // was in hand, and a hidden placement nobody can reach is a leak.
          placements: s.placements.filter((p) => p.presetId !== id),
          // And so does the light, if it was on one of its pictures.
          highlightId: at >= 0 && s.presets[at].slots.some((h) => h?.id === s.highlightId)
            ? null
            : s.highlightId,
        }
      }),

    renamePreset: (id, name) =>
      set((s) => ({
        // Trimmed, and an empty name falls back rather than leaving a blank row
        // in the dropdown that cannot be told from its neighbours.
        presets: s.presets.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)),
      })),

    putImage: (slot, image) =>
      set((s) => {
        if (slot < 0 || slot >= SLOTS_PER_PRESET) return s
        const image_: RefImage = { ...image, id: nextId('i'), edit: { ...NO_EDIT } }
        // What is being displaced, read before the slot is overwritten.
        const outgoing = s.presets.find((p) => p.id === s.activePresetId)?.slots[slot] ?? null
        return {
          presets: s.presets.map((p) =>
            p.id !== s.activePresetId
              ? p
              : { ...p, slots: p.slots.map((held, i) => (i === slot ? image_ : held)) }
          ),
          // Whatever was in the slot is gone, so anything it had put on the
          // block goes with it.
          placements: outgoing
            ? s.placements.filter((pl) => pl.imageId !== outgoing.id)
            : s.placements,
          // The light is on a picture, not on a square of the grid: a slot
          // refilled is a different drawing, and it arrives unlit.
          highlightId: outgoing && s.highlightId === outgoing.id ? null : s.highlightId,
        }
      }),

    removeImage: (imageId) =>
      set((s) => ({
        presets: s.presets.map((p) => ({
          ...p,
          slots: p.slots.map((held) => (held?.id === imageId ? null : held)),
        })),
        placements: s.placements.filter((pl) => pl.imageId !== imageId),
        editingId: s.editingId === imageId ? null : s.editingId,
        highlightId: s.highlightId === imageId ? null : s.highlightId,
        drag: s.drag?.imageId === imageId ? null : s.drag,
      })),

    setEdit: (imageId, edit) =>
      set((s) => ({
        presets: s.presets.map((p) => ({
          ...p,
          slots: p.slots.map((held) => (held?.id === imageId ? { ...held, edit } : held)),
        })),
      })),

    setOpacity: (opacity) =>
      set((s) => {
        const next = Math.min(1, Math.max(0, opacity))
        return next === s.opacity ? s : { opacity: next }
      }),

    openEditor: (imageId) => set({ editingId: imageId }),

    // A light on a picture that is not in the panel arms nothing and points at
    // nothing, so it is refused rather than held.
    highlight: (imageId) =>
      set((s) =>
        imageId === null || imageOf(s.presets, imageId) ? { highlightId: imageId } : s
      ),

    startDrag: (imageId) => set({ drag: { imageId, at: null } }),
    dragOver: (at) => set((s) => (s.drag ? { drag: { ...s.drag, at } } : s)),
    cancelDrag: () => set({ drag: null }),

    dropDrag: (size) => {
      const { drag, activePresetId, placements } = get()
      // A release off the block is a drag abandoned, not a placement at the
      // last place the pointer happened to be over one.
      if (!drag?.at) {
        set({ drag: null })
        return
      }
      // The ceiling the shader can paint. Refused rather than placed and left
      // invisible, which is the failure that would have people cutting to a
      // drawing that is not there.
      if (placements.filter((p) => p.presetId === activePresetId).length >= MAX_PLACEMENTS) {
        set({ drag: null })
        return
      }
      const placement: Placement = {
        id: nextId('d'),
        presetId: activePresetId,
        imageId: drag.imageId,
        face: drag.at.face,
        u: drag.at.u,
        v: drag.at.v,
        w: size.w,
        h: size.h,
      }
      set((s) => ({ placements: [...s.placements, placement], drag: null }))
    },

    // A grab on a decal that is not there is refused rather than remembered:
    // the id comes off a handle, and a handle can outlive its picture by one
    // render.
    startGrab: (grab) =>
      set((s) => (s.placements.some((p) => p.id === grab.id) ? { grab } : s)),
    endGrab: () => set((s) => (s.grab ? { grab: null } : s)),

    movePlacement: (id, u, v) =>
      set((s) => ({
        placements: s.placements.map((p) => (p.id === id ? { ...p, u, v } : p)),
      })),

    sizePlacement: (id, rect) =>
      set((s) => ({
        placements: s.placements.map((p) => (p.id === id ? { ...p, ...rect } : p)),
      })),

    removePlacement: (id) =>
      set((s) => ({ placements: s.placements.filter((p) => p.id !== id) })),

    // The picture stays in its slot, and the grab goes with the decals: a grab
    // is a hand on a rectangle, and the rectangle has just gone.
    clearPlacementsOf: (imageId) =>
      set((s) => {
        const going = new Set(s.placements.filter((p) => p.imageId === imageId).map((p) => p.id))
        if (going.size === 0) return s
        return {
          placements: s.placements.filter((p) => !going.has(p.id)),
          grab: s.grab && going.has(s.grab.id) ? null : s.grab,
        }
      }),

    // The pictures, the presets and the lit slot all stay: what goes is only
    // where they were stuck. So the way back is to drag them out again, which
    // is the same gesture that put them there.
    clearPlacements: () =>
      set((s) => (s.placements.length === 0 ? s : { placements: [], grab: null })),
  }
})

/** The preset in hand, which the panel and the block both read. */
export const activePreset = (s: {
  presets: Preset[]
  activePresetId: string
}): Preset => s.presets.find((p) => p.id === s.activePresetId) ?? s.presets[0]

/**
 * The decals that are drawn: the ones belonging to the preset in hand.
 *
 * Switching preset hides the rest rather than deleting them, which is what the
 * dropdown is for -- a preset is a whole set-up, and going back to it brings
 * back what was stuck to the block under it.
 */
export function visiblePlacements(s: {
  placements: Placement[]
  activePresetId: string
}): Placement[] {
  return s.placements.filter((p) => p.presetId === s.activePresetId)
}

/** The image behind a placement, or null once its slot has been emptied. */
export function imageOf(presets: Preset[], imageId: string): RefImage | null {
  for (const preset of presets) {
    for (const held of preset.slots) if (held?.id === imageId) return held
  }
  return null
}
