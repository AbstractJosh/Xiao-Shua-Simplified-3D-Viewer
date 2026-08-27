import type { ReactNode } from 'react'
import { defaultBaseFor } from '../geometry/types'
import type { PaletteKind, PlatonicKind } from '../geometry/types'
import { SOLID_SIDES, iconFrame } from './solidMorph'
import type { IconFrame, MorphKind } from './solidMorph'

export type SolidTemplate = {
  key: string
  /**
   * What the row calls itself at rest. For most rows that is simply the solid
   * they place; for the two that place a FAMILY it is the family, plural, and
   * the member's own name appears under the pointer instead.
   */
  label: string
  kind: PaletteKind
  /** Base-polygon choices offered inline on the row; absent means the row has none. */
  sides?: number[]
  platonic?: PlatonicKind
  /**
   * Rows whose solid is built on a base polygon, and whose icon is therefore
   * drawn rather than written down: it morphs between the counts in `sides`,
   * and spins through them while the row is left alone.
   */
  morph?: MorphKind
  /** Children of a 32x32 viewBox svg; the palette supplies stroke, fill and weight. */
  icon: ReactNode
}

const HIDDEN_OPACITY = 0.34

/**
 * Back edges at reduced opacity. Ten flat silhouettes in a column all read as the
 * same grey blob at icon size -- the hidden edge is what makes a row identifiable
 * without reading its label, so it is drawn wherever it disambiguates the solid.
 */
function Hidden({ children }: { children: ReactNode }) {
  return <g opacity={HIDDEN_OPACITY}>{children}</g>
}

/**
 * One instant of a projected solid, drawn from the numbers `solidMorph` works
 * out. The still icon in the catalogue below and the animated one in the
 * palette both go through here, so a row mid-morph is the same drawing as the
 * row at rest rather than a second version of it that has to be kept in step.
 *
 * The far rim is a closed faint outline with its near half laid solid on top:
 * one path that morphs cleanly, instead of two arcs that would have to agree
 * about where the horizon is while the shape underneath them is still moving.
 */
export function SolidFrame({ frame }: { frame: IconFrame }) {
  return (
    <>
      {frame.cap && <polygon points={frame.cap} />}
      <Hidden>
        <polygon points={frame.base} />
      </Hidden>
      <polyline points={frame.baseNear} />
      {frame.sets.map((set) => (
        <g key={set.sides} opacity={set.weight}>
          {set.edges.map((e, i) => (
            <line
              key={i}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              opacity={e.hidden ? HIDDEN_OPACITY : 1}
            />
          ))}
        </g>
      ))}
    </>
  )
}

/** The still icon for a family row: the solid it places when nothing is hovered. */
export function solidFrameIcon(kind: MorphKind, sides: number): ReactNode {
  return <SolidFrame frame={iconFrame(kind, sides, sides, 0)} />
}

/**
 * The side count a kind rests on before anyone touches it, read back out of the
 * geometry layer rather than written down here -- so the icon a row shows at
 * rest, and the count its ticks light, are the ones a plain drag would actually
 * produce. Kinds with no base polygon have none.
 */
export function restingSides(kind: PaletteKind): number | undefined {
  const base = defaultBaseFor(kind)
  return 'sides' in base ? base.sides : undefined
}

/**
 * Every icon is a 3/4 view of the SOLID: camera above and to the left, so the top
 * cap is open and one side face is foreshortened. Drawing them flat-on would make
 * cylinder/prism and cone/pyramid indistinguishable.
 *
 * All ten share one construction: bodies are centred on (16,16) and span roughly
 * 20-25px, so no row looks heavier than its neighbours in the list.
 */

/** Front square plus a back square offset up-right; the far corner stays faint. */
const CubeIcon = (
  <>
    <polygon points="6,12 20,12 20,26 6,26" />
    <polyline points="6,12 12,6 26,6 20,12" />
    <polyline points="26,6 26,20 20,26" />
    <Hidden>
      <polyline points="12,6 12,20 26,20" />
      <line x1="12" y1="20" x2="6" y2="26" />
    </Hidden>
  </>
)

/** Outline plus the equator: its near half in front of the sphere, far half behind. */
const SphereIcon = (
  <>
    <circle cx="16" cy="16" r="12" />
    <path d="M4 16 A12 4 0 0 0 28 16" />
    <Hidden>
      <path d="M4 16 A12 4 0 0 1 28 16" />
    </Hidden>
  </>
)

/** The top cap is a closed ellipse because we see into it; the bottom rim is not. */
const CylinderIcon = (
  <>
    <ellipse cx="16" cy="8" rx="9" ry="3.4" />
    <line x1="7" y1="8" x2="7" y2="24" />
    <line x1="25" y1="8" x2="25" y2="24" />
    <path d="M7 24 A9 3.4 0 0 0 25 24" />
    <Hidden>
      <path d="M7 24 A9 3.4 0 0 1 25 24" />
    </Hidden>
  </>
)

const ConeIcon = (
  <>
    <polyline points="6.5,24.8 16,3.8 25.5,24.8" />
    <path d="M6.5 24.8 A9.5 3.5 0 0 0 25.5 24.8" />
    <Hidden>
      <path d="M6.5 24.8 A9.5 3.5 0 0 1 25.5 24.8" />
    </Hidden>
  </>
)

/**
 * The two family rows are the only ones NOT written down as coordinates: a
 * pyramid and a prism are whatever polygon they are built on, and the row lets
 * you choose. Both are projected from that polygon on demand -- see
 * `solidMorph` -- and these are just the counts the rows rest on.
 *
 * They are drawn taller and narrower than the cube and the tetrahedron below,
 * which is what keeps a 4-sided prism from being a second cube icon and a
 * 3-sided pyramid from being a second tetrahedron.
 */
// Both kinds carry a base polygon, so the fallbacks below only exist to satisfy
// the union `restingSides` reads from.
const PyramidIcon = solidFrameIcon('pyramid', restingSides('pyramid') ?? 4)
const PrismIcon = solidFrameIcon('prism', restingSides('prism') ?? 6)

/**
 * Both ends domed -- that is the only thing separating the bean from the
 * cylinder in silhouette, so the faint line is the top hemisphere's widest
 * circle rather than a decorative highlight.
 */
const BeanIcon = (
  <>
    <path d="M8 11 A8 8 0 0 1 24 11 L24 21 A8 8 0 0 1 8 21 Z" />
    <Hidden>
      <path d="M8 11 A8 2.8 0 0 0 24 11" />
    </Hidden>
  </>
)

/** Triangular base with one vertex toward the viewer; the far base edge hides. */
const TetrahedronIcon = (
  <>
    <polyline points="6.5,20.8 16,4.2 25.5,20.8" />
    <line x1="16" y1="4.2" x2="16" y2="27.4" />
    <polyline points="6.5,20.8 16,27.4 25.5,20.8" />
    <Hidden>
      <line x1="6.5" y1="20.8" x2="25.5" y2="20.8" />
    </Hidden>
  </>
)

/** Two apexes over a square equator, turned 30 degrees for the same reason as the pyramid. */
const OctahedronIcon = (
  <>
    <line x1="16" y1="3.5" x2="6.5" y2="13.8" />
    <line x1="16" y1="3.5" x2="10.5" y2="19.8" />
    <line x1="16" y1="3.5" x2="25.5" y2="18.2" />
    <line x1="16" y1="28.5" x2="6.5" y2="13.8" />
    <line x1="16" y1="28.5" x2="10.5" y2="19.8" />
    <line x1="16" y1="28.5" x2="25.5" y2="18.2" />
    <polyline points="6.5,13.8 10.5,19.8 25.5,18.2" />
    <Hidden>
      <line x1="16" y1="3.5" x2="21.5" y2="12.2" />
      <line x1="16" y1="28.5" x2="21.5" y2="12.2" />
      <polyline points="25.5,18.2 21.5,12.2 6.5,13.8" />
    </Hidden>
  </>
)

/**
 * The true face-on projection, not a decorated polygon: looking down a face
 * normal, a dodecahedron's outline is a regular decagon, the near face is a
 * regular pentagon, and the five faces between them are the foreshortened
 * quadrilateral-looking pentagons the spokes cut out. Coordinates come from
 * projecting the real hull, so the ring reads as five equal faces.
 *
 * Back edges are omitted here alone: eleven more interior lines inside a 28px
 * decagon is a smudge, and the ring already carries the depth.
 */
const DodecahedronIcon = (
  <>
    <polygon points="16,3.4 23.4,5.8 28,12.1 28,19.9 23.4,26.2 16,28.6 8.6,26.2 4,19.9 4,12.1 8.6,5.8" />
    <polygon points="16,8.2 23.4,13.6 20.6,22.3 11.4,22.3 8.6,13.6" />
    <line x1="16" y1="8.2" x2="16" y2="3.4" />
    <line x1="23.4" y1="13.6" x2="28" y2="12.1" />
    <line x1="20.6" y1="22.3" x2="23.4" y2="26.2" />
    <line x1="11.4" y1="22.3" x2="8.6" y2="26.2" />
    <line x1="8.6" y1="13.6" x2="4" y2="12.1" />
  </>
)

/** Ordered top to bottom by real-world commonness, not by vertex count. */
export const SOLID_TEMPLATES: SolidTemplate[] = [
  { key: 'cube', label: 'Cube', kind: 'box', icon: CubeIcon },
  { key: 'sphere', label: 'Sphere', kind: 'sphere', icon: SphereIcon },
  { key: 'cylinder', label: 'Cylinder', kind: 'cylinder', icon: CylinderIcon },
  { key: 'cone', label: 'Cone', kind: 'cone', icon: ConeIcon },
  // Plural, and the two rows in the list that are named that way: these place a
  // family of solids rather than one, and a row resting under "Square pyramid"
  // read as the row that places square pyramids. The member's own name is one
  // hover away, which is also where the choice is.
  {
    key: 'pyramid',
    label: 'Pyramids',
    kind: 'pyramid',
    sides: SOLID_SIDES,
    morph: 'pyramid',
    icon: PyramidIcon,
  },
  {
    key: 'prism',
    label: 'Prisms',
    kind: 'prism',
    sides: SOLID_SIDES,
    morph: 'prism',
    icon: PrismIcon,
  },
  { key: 'bean', label: 'Bean', kind: 'capsule', icon: BeanIcon },
  {
    key: 'tetrahedron',
    label: 'Tetrahedron',
    kind: 'platonic',
    platonic: 'tetrahedron',
    icon: TetrahedronIcon,
  },
  {
    key: 'octahedron',
    label: 'Octahedron',
    kind: 'platonic',
    platonic: 'octahedron',
    icon: OctahedronIcon,
  },
  {
    key: 'dodecahedron',
    label: 'Dodecahedron',
    kind: 'platonic',
    platonic: 'dodecahedron',
    icon: DodecahedronIcon,
  },
]
