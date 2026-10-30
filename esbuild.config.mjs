import esbuild from 'esbuild';
import { builtinModules, createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import './licenses.mjs';
const builtins = [...builtinModules, ...builtinModules.map((x) => `node:${x}`)];
const smithyRoot = path.dirname(
  createRequire(import.meta.url).resolve('@smithy/core/package.json'),
);
const licenseText = (
  await Promise.all(['LICENSE', 'THIRD_PARTY_NOTICES.md'].map((file) => readFile(file, 'utf8')))
).join('\n');
const licenseBanner = `/*! Pictether redistribution notices\n${licenseText.replaceAll('*/', '* /')}\n*/`;
const contexts = await Promise.all([
  esbuild.context({
    entryPoints: ['src/main.ts'],
    bundle: true,
    outfile: 'main.js',
    format: 'cjs',
    banner: { js: licenseBanner },
    // Browser credential/config policy, with Node stream and checksum support
    // for the desktop renderer. Never pull in the ambient AWS credential chain.
    platform: 'browser',
    mainFields: ['browser', 'module', 'main'],
    target: 'es2022',
    supported: { 'dynamic-import': false },
    metafile: true,
    plugins: [
      {
        name: 'verify-desktop-bundle',
        setup(build) {
          build.onResolve({ filter: /^@smithy\/core\/(?:serde|checksum)$/ }, (args) => {
            const submodule = args.path.split('/').at(-1);
            return { path: path.join(smithyRoot, 'dist-es/submodules', submodule, 'index.js') };
          });
          build.onEnd(async (result) => {
            if (result.errors.length) return;
            const forbidden = Object.keys(result.metafile.inputs).filter((name) =>
              /credential-provider-(?:node|process|ini|sso|login)|shared-ini-file-loader/.test(
                name,
              ),
            );
            const output = await readFile('main.js', 'utf8');
            if (forbidden.length || /\bchild_process\b|credential_process/.test(output)) {
              return {
                errors: [
                  {
                    text: 'The plugin bundle contains shell execution or ambient credential providers.',
                  },
                ],
              };
            }
          });
        },
      },
    ],
    sourcemap: process.argv.includes('--watch') ? 'inline' : false,
    external: [
      'obsidian',
      'electron',
      '@codemirror/*',
      '@lezer/common',
      '@lezer/highlight',
      '@lezer/lr',
      ...builtins,
    ],
    logLevel: 'info',
  }),
]);
if (process.argv.includes('--watch')) await Promise.all(contexts.map((context) => context.watch()));
else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
