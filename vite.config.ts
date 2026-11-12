/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { LOCOMOTOR_FILES, raiseLocomotorHeightLimit } from './tools/locomotor-height-limit.mjs';

/**
 * The SDK's walking engine puts the player back at (0, 2, 0) above y = 100 m; the game starts on Everest at 221 m. The two files that carry the engine
 * are rewritten as they are loaded (tools/locomotor-height-limit.mjs; node_modules itself is left alone): here for the production build and for any
 * file the dev server serves directly, and in `optimizeDeps.esbuildOptions.plugins` below for the dev server's pre-bundle of the SDK.
 * The build fails if the worker bundle never went through it.
 */
function locomotorHeightLimit(): Plugin {
  let build = false;
  let seen = false;
  return {
    name: 'jumanji-locomotor-height-limit',
    enforce: 'pre',
    configResolved(c) {
      build = c.command === 'build';
    },
    transform(code, id) {
      const file = id.split('?')[0];
      if (!LOCOMOTOR_FILES.test(file)) return null;
      seen ||= /worker\.js$/.test(file);
      return { code: raiseLocomotorHeightLimit(code, file), map: null };
    },
    buildEnd(err) {
      if (build && !err && !seen) this.error('[locomotor-height-limit] the locomotor worker was not part of the build: the 100 m limit is still in place');
    },
  };
}

/** The same rewrite for the dev server's dependency pre-bundle (esbuild). */
const locomotorHeightLimitEsbuild = {
  name: 'jumanji-locomotor-height-limit',
  setup(b: { onLoad: (o: { filter: RegExp }, cb: (a: { path: string }) => { contents: string; loader: 'js' }) => void }) {
    b.onLoad({ filter: LOCOMOTOR_FILES }, (a) => ({ contents: raiseLocomotorHeightLimit(readFileSync(a.path, 'utf8'), a.path), loader: 'js' }));
  },
};

/**
 * Dev-only sink for headset performance results: the Quest POSTs its JSON to the dev server
 * (same origin, over the LAN) and it lands in ./perf-results/ on the PC. Not part of the build.
 */
function perfResultSink(): Plugin {
  return {
    name: 'jumanji-perf-result-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__jumanji/perf', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const r = JSON.parse(body) as { id?: string; timestamp?: string; session?: string };
            const dir = resolve(process.cwd(), 'perf-results');
            mkdirSync(dir, { recursive: true });
            const name = `${(r.timestamp ?? new Date().toISOString()).replace(/[:.]/g, '-')}_${r.session ?? 'x'}_${r.id ?? 'test'}.json`;
            writeFileSync(resolve(dir, name), JSON.stringify(r, null, 2));
            res.statusCode = 200;
            res.end('ok');
          } catch {
            res.statusCode = 400;
            res.end('bad json');
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [locomotorHeightLimit(), iwsdkDev(), perfResultSink()],
  server: { host: '0.0.0.0', port: 8081, open: false },
  build: {
    outDir: 'dist',
    sourcemap: process.env.NODE_ENV !== 'production',
    target: 'esnext',
    rollupOptions: { input: './index.html' },
  },
  esbuild: { target: 'esnext' },
  // @drawcall/uikitml otherwise pulls a second three/@pmndrs/uikit graph
  // (its own three vs the app's super-three alias). Duplicate Component classes break
  // instanceof checks → "Only pmndrs/uikit components can be added as children".
  resolve: {
    dedupe: [
      'three',
      '@pmndrs/uikit',
      '@pmndrs/uikit-horizon',
      '@pmndrs/uikit-lucide',
    ],
  },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
    include: [
      'three',
      '@pmndrs/uikit',
      '@pmndrs/uikit-horizon',
      '@pmndrs/uikit-lucide',
      '@drawcall/uikitml',
    ],
    esbuildOptions: { target: 'esnext', plugins: [locomotorHeightLimitEsbuild] },
  },
  publicDir: 'public',
  base: './',
});
