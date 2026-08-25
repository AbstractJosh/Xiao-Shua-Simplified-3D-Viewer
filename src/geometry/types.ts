/** Core document model. Everything the editor draws is DERIVED from a `Doc`. */

export type Vec3 = [number, number, number]

/** A closed, convex 2D outline drawn in a surface's tangent frame. */
export type Shape2D =
  | { type: 'circle'; r: number }
  | { type: 'rect'; w: number; h: number }
  | { type: 'ngon'; r: number; sides: number }

export type ShapeKind = Shape2D['type']

/**
 * Box faces, ordered to match THREE.BoxGeometry's group order.
 * 0:+X  1:-X  2:+Y  3:-Y  4:+Z  5:-Z
 */
export type BoxFace = 0 | 1 | 2 | 3 | 4 | 5

/**
 * WHERE a sketch sits, stored in the surface's own parameter space rather than
 * world coordinates. Resizing the base then carries its sketches along instead
 * of leaving them floating in space.
 *
 * `derived` is the fallback for a hit on geometry produced by an earlier
 * feature, where no analytic parameterisation exists. It is treated as flat.
 */
export type SurfaceAnchor =
  | { on: 'box-face'; face: BoxFace; u: number; v: number } // u,v normalised to -1..1
  | { on: 'sphere'; theta: number; phi: number } // azimuth, polar
  | { on: 'derived'; point: Vec3; normal: Vec3 }

export type FeatureOp = 'extrude' | 'intrude'

export type Feature = {
  id: string
  anchor: SurfaceAnchor
  shape: Shape2D
  /** Spin of the outline within the tangent frame, in radians. */
  rotation: number
  op: FeatureOp
  /** 0 means inert: drawn as a surface projection, contributes no solid. */
  depth: number
  enabled: boolean
}

export type BaseSolid =
  | { kind: 'box'; size: Vec3 }
  | { kind: 'sphere'; radius: number }

export type Doc = {
  base: BaseSolid
  features: Feature[]
}

/** A sketch is flat unless it sits on a genuinely curved patch. */
export function isCurvedAnchor(anchor: SurfaceAnchor): boolean {
  return anchor.on === 'sphere'
}

export function shapeRadius(shape: Shape2D): number {
  switch (shape.type) {
    case 'circle':
      return shape.r
    case 'ngon':
      return shape.r
    case 'rect':
      return Math.hypot(shape.w, shape.h) / 2
  }
}

let idCounter = 0
export function nextFeatureId(): string {
  idCounter += 1
  return `f${idCounter}`
}

export function defaultShape(kind: ShapeKind): Shape2D {
  switch (kind) {
    case 'circle':
      return { type: 'circle', r: 0.3 }
    case 'rect':
      return { type: 'rect', w: 0.6, h: 0.6 }
    case 'ngon':
      return { type: 'ngon', r: 0.35, sides: 6 }
  }
}
