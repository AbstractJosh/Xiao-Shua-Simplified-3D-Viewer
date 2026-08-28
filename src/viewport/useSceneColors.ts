import { useTools } from '../store/toolStore'
import { SCENE_THEMES } from './sceneColors'
import type { SceneColors } from './sceneColors'

/**
 * The scene palette for whichever theme is on.
 *
 * Its own file, tiny, because `sceneColors` is deliberately free of React and of
 * anything that needs a store -- the check suite reads its tables headlessly --
 * and this is the one line that joins the two.
 *
 * A hook rather than a module constant, and that is the whole point of the
 * change: a constant is read once when the module loads, so the scene kept the
 * palette the app happened to start in and a theme switch repainted the console
 * around an unchanged viewport.
 */
export function useSceneColors(): SceneColors {
  return SCENE_THEMES[useTools((s) => s.theme)]
}
