import type { ReactNode } from 'react'
import type { PlatonicKind, SolidKind } from '../geometry/types'

export type SolidTemplate = {
  key: string
  label: string
  kind: SolidKind
  /** Base-polygon choices offered inline on the row; absent means the row has none. */
  sides?: number[]
  platonic?: PlatonicKind
  /** Children of a 32x32 viewBox svg; the palette supplies stroke, fill and weight. */
  icon: ReactNode
}

/**
 * Back edges at reduced opacity. Ten flat silhouettes in a column all read as the
 * same grey blob at icon size -- the hidden edge is what makes a row identifiable
 * without reading its label, so it is drawn wherever it disambiguates the solid.
 */
function Hidden({ children }: { children: ReactNode }) {
  return <g opacity="0.34">{children}</g>
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
 * Square base turned 30 degrees off axis. Facing a base vertex straight at the
 * viewer would put the near and far apex edges on the same screen line, which
 * reads as a triangle with a stray tick rather than as a pyramid.
 */
const PyramidIcon = (
  <>
    <polyline points="6.5,21.3 16,4.5 25.5,25.7" />
    <line x1="16" y1="4.5" x2="10.5" y2="27.3" />
    <polyline points="6.5,21.3 10.5,27.3 25.5,25.7" />
    <Hidden>
      <line x1="16" y1="4.5" x2="21.5" y2="19.7" />
      <polyline points="25.5,25.7 21.5,19.7 6.5,21.3" />
    </Hidden>
  </>
)

/**
 * Hexagonal, matching the row's default side count. Only the far half of the
 * bottom rim is drawn faint: the two back verticals would land on top of the
 * front ones at this scale and just thicken them.
 */
const PrismIcon = (
  <>
    <polygon points="25,9.5 20.5,13.1 11.5,13.1 7,9.5 11.5,5.9 20.5,5.9" />
    <line x1="7" y1="9.5" x2="7" y2="22.5" />
    <line x1="11.5" y1="13.1" x2="11.5" y2="26.1" />
    <line x1="20.5" y1="13.1" x2="20.5" y2="26.1" />
    <line x1="25" y1="9.5" x2="25" y2="22.5" />
    <polyline points="7,22.5 11.5,26.1 20.5,26.1 25,22.5" />
    <Hidden>
      <polyline points="25,22.5 20.5,19.4 11.5,19.4 7,22.5" />
    </Hidden>
  </>
)

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
  { key: 'pyramid', label: 'Pyramid', kind: 'pyramid', sides: [3, 4, 5, 6, 8], icon: PyramidIcon },
  { key: 'prism', label: 'Prism', kind: 'prism', sides: [3, 4, 5, 6, 8], icon: PrismIcon },
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
