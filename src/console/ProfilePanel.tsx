import { CLAY_PROFILES, freshClay, profileWall } from '../geometry/clay'
import type { ClayProfile } from '../geometry/clay'
import { useLathe } from '../store/latheStore'
import { Section } from './Field'

/**
 * The shapes a piece can START from: a bowl, a vase, a goblet, and five more.
 *
 * WHAT IT IS FOR, since a lathe that gives you the answer is not much of a
 * lathe. Every sitting begins with the same cylinder, and the first thing
 * anybody does to it is turn it into roughly the KIND of thing they came to
 * make -- which is the least interesting minute of the work and the one that
 * needs the most care with two tools and nothing to aim at. A stem thin enough
 * to be a stem is a slow, nervous push; a rim that flares evenly is a stroke
 * you get right on the third try. These are those minutes, done. What you do
 * after loading one is the whole of the screen.
 *
 * A PALETTE, in the console, because that is what this app already calls a grid
 * of shapes you pick one from -- see `SolidPalette` and `ShapePalette` next
 * door. It is the same act: point at a thing you want and get it. The
 * difference is that those two ADD to a scene and this one REPLACES a wall, so
 * it is the one palette in the app that throws work away.
 *
 * IT ASKS NOTHING FIRST. A confirm on every tile would make the palette
 * unbrowsable, and browsing -- press one, look at it, press the next -- is
 * exactly how somebody finds the shape they meant. What makes that safe is the
 * undo the lathe now has: a tile costs one entry, and Ctrl+Z is one press.
 * Before there was a history here this panel could not have existed in this
 * form.
 *
 * THE TILES DRAW THE REAL THING. Each one is `profileWall`'s own output for
 * that profile, mirrored about a centre line -- the same numbers the lathe gets
 * -- so a tile cannot promise a curve the piece does not arrive with. The only
 * thing the tile does not share is the frame it is drawn in.
 */

/** The tile canvas. Taller than it is wide, because every one of these is. */
const TILE_W = 34
const TILE_H = 42

/**
 * One profile's silhouette, on the tile canvas.
 *
 * Drawn from a UNIT LUMP -- one tall, half a unit of stock -- so the widest a
 * profile may go, `CLAY_FLARE` times the stock, is what the canvas is scaled to
 * fit. Every tile therefore shares one scale, and a cone reads as narrower than
 * a bowl because it IS, rather than because each was fitted to its own box.
 */
function tilePath(profile: ClayProfile): string {
  const lump = freshClay(1, 0.5)
  const wall = profileWall(lump, profile)
  const widest = 0.5 * 1.9
  const half = (TILE_W / 2 - 1.5) / widest
  const right: string[] = []
  const left: string[] = []
  for (let i = 0; i < wall.length; i += 1) {
    const y = (TILE_H - 2 - (i / (wall.length - 1)) * (TILE_H - 4)).toFixed(2)
    const x = wall[i] * half
    right.push(`${(TILE_W / 2 + x).toFixed(2)} ${y}`)
    left.unshift(`${(TILE_W / 2 - x).toFixed(2)} ${y}`)
  }
  return `M ${right.join(' L ')} L ${left.join(' L ')} Z`
}

function ProfileTile({ profile }: { profile: ClayProfile }) {
  const shapeAs = useLathe((s) => s.shapeAs)
  return (
    <button
      type="button"
      className="profile-tile"
      title={`Start from a ${profile.label.toLowerCase()}. Undo puts back what is on the lathe now.`}
      onClick={() => shapeAs(profile)}
    >
      {/* Filled rather than outlined, unlike the polygon tiles under Base: those
          are a section seen end-on, where the outline IS the shape, and this is
          a piece seen from the side, where the outline is the edge of something
          solid. It is also how the viewport draws the piece a few inches away. */}
      <svg viewBox={`0 0 ${TILE_W} ${TILE_H}`} className="profile-icon" aria-hidden>
        <path d={tilePath(profile)} />
      </svg>
      <span className="profile-name">{profile.label}</span>
    </button>
  )
}

export function ProfilePanel() {
  return (
    <Section
      title="Profiles"
      tip={
        <>
          A shape to start from, in place of the plain cylinder. It keeps the
          stock and the base and replaces the <b>wall</b> -- so it throws away
          whatever you have shaped, and <b>Ctrl+Z</b> puts that back. Every one
          of them is somewhere the two tools could have got to on their own.
        </>
      }
    >
      <div className="profile-grid">
        {CLAY_PROFILES.map((profile) => (
          <ProfileTile key={profile.id} profile={profile} />
        ))}
      </div>
    </Section>
  )
}
