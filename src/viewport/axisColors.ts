/**
 * The one place X, Y and Z are given a colour.
 *
 * Its own module, with no three.js or React in it, for two reasons: the gizmo
 * that draws the arrows and the check suite that guards these values can both
 * import it without dragging a renderer along, and there is exactly one
 * definition to change.
 *
 * The same three values also live in styles.css as --axis-x/y/z, which tint the
 * X/Y/Z letters of the console's Vec3 rows -- a material cannot read a CSS
 * custom property, so that duplication is unavoidable. It is not unguarded:
 * `ui-check` reads the stylesheet and fails if the two drift apart.
 *
 * Fully saturated on purpose. The gizmo is small and drawn over solids in the
 * same warm grey as everything else in the scene, so the arrows have to win on
 * colour rather than on size.
 */
export const AXIS_COLORS = ['#ff1744', '#00e676', '#2979ff'] as const

/** The CSS custom property carrying each of the above. */
export const AXIS_CSS_VARS = ['--axis-x', '--axis-y', '--axis-z'] as const

/**
 * The sketch gizmo's two tangent directions, U and V.
 *
 * Deliberately nowhere near the X/Y/Z triad. A sketch gizmo does something
 * genuinely different from the object one -- it slides a projection across a
 * surface, and its two axes are that surface's own tangents, not world
 * directions -- so reusing red and green would say the two gizmos were the same
 * tool at different scales. Amber and magenta share no hue with any of the
 * three, which is what keeps them apart on a solid that has both on it at once.
 */
export const SKETCH_AXIS_COLORS = ['#ffb300', '#e040fb'] as const
