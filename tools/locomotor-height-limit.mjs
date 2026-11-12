// Raises the height limit hard-coded in @iwsdk/locomotor 1.1.0-rc.2, AT LOAD TIME (nothing in node_modules is modified).
//
// The SDK's walking engine has a runaway guard: "if the player is above y = 100 m, put them back at (0, 2, 0)". The summit of Everest, where the game
// starts, is at 221 m, so with the stock package the player is thrown into the jungle on the first physics step. The limit is not configurable.
// vite.config.ts feeds the two files that carry the engine through `raiseLocomotorHeightLimit()`:
//   dist/core/engine.js     the plain module (useWorker: false)
//   dist/worker/worker.js   the worker bundle, shipped as `export const url = 'data:application/javascript;base64,...'`
// in the production build (a Rollup `transform`) and in the dev server's pre-bundle (an esbuild `onLoad`).
//
// If a future SDK version changes this code the transform THROWS (no silent no-op): check whether the limit still exists before removing it.

export const LOCOMOTOR_FILES = /[\\/]@iwsdk[\\/]locomotor[\\/]dist[\\/](?:core[\\/]engine|worker[\\/]worker)\.js$/;
export const HEIGHT_LIMIT = '100000';

/** Replace exactly one `this.playerPosition.y > 100` in a source text. */
function raise(src, what) {
  const stock = /this\.playerPosition\.y(\s*)>(\s*)100\b(?!\d)/g;
  const hits = src.match(stock) ?? [];
  if (hits.length !== 1) {
    throw new Error(`[locomotor-height-limit] ${what}: expected one "playerPosition.y > 100" guard, found ${hits.length}. The SDK changed: see tools/locomotor-height-limit.mjs`);
  }
  return src.replace(stock, (_m, a, b) => `this.playerPosition.y${a}>${b}${HEIGHT_LIMIT}`);
}

/**
 * @param {string} code  the file's source
 * @param {string} id    its path (must match LOCOMOTOR_FILES)
 * @returns {string} the source with the limit raised
 */
export function raiseLocomotorHeightLimit(code, id) {
  if (/worker\.js$/.test(id)) {
    const m = /^(\s*export const url = 'data:application\/javascript;base64,)([A-Za-z0-9+/=]+)(';?\s*)$/.exec(code);
    if (!m) throw new Error('[locomotor-height-limit] worker.js is no longer a base64 data URL. The SDK changed: see tools/locomotor-height-limit.mjs');
    return m[1] + Buffer.from(raise(Buffer.from(m[2], 'base64').toString('utf8'), 'worker.js'), 'utf8').toString('base64') + m[3];
  }
  return raise(code, 'engine.js');
}
