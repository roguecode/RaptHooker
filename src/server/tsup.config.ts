import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

/** The commit being built and whether there are uncommitted changes: shown when the hub runs a development build. */
function gitState(): { commit: string | null; changes: boolean } {
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    return { commit: git('rev-parse', '--short', 'HEAD'), changes: git('status', '--porcelain', '--untracked-files=no') !== '' };
  } catch {
    // No git, or not a checkout (a Docker build, say).
    return { commit: null, changes: false };
  }
}

export default defineConfig({
  entry: {
    rapthooker: 'main.ts',
    'rapthooker-probe': 'tools/probe.ts',
  },
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Everything is bundled so the Pi only needs Node and these files, except dbus-next's optional native socket
  // module and X11 session-bus helper, which a headless Pi doesn't use.
  noExternal: [/^(?!usocket$|x11$)/],
  external: ['usocket', 'x11'],
  // Screen images: the renderer (WebAssembly) and fonts go inside the server file as bytes, in place of the module that
  // reads them from disk when running from source.
  loader: { '.wasm': 'binary', '.ttf': 'binary' },
  esbuildPlugins: [
    {
      name: 'embed-screen-assets',
      setup(build) {
        build.onResolve({ filter: /\/assets-files\.js$/ }, () => ({
          path: fileURLToPath(new URL('./screen/assets-embedded.ts', import.meta.url)),
        }));
      },
    },
  ],
  outExtension: () => ({ js: '.cjs' }),
  // node:sqlite only exists with the node: prefix.
  removeNodeProtocol: false,
  define: {
    __RAPTHOOKER_VERSION__: JSON.stringify(version),
    __RAPTHOOKER_BUILD__: JSON.stringify({ ...gitState(), builtAt: Date.now() }),
  },
});
