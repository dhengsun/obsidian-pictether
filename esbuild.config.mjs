import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
const builtins = [...builtinModules, ...builtinModules.map(x => `node:${x}`)];
const contexts = await Promise.all([
  esbuild.context({
    entryPoints: ['src/main.ts'], bundle: true, outfile: 'main.js', format: 'cjs',
    platform: 'node', target: 'es2022', sourcemap: process.argv.includes('--watch') ? 'inline' : false,
    external: ['obsidian', 'electron', '@codemirror/*', '@lezer/common', '@lezer/highlight', '@lezer/lr', ...builtins], logLevel: 'info'
  })
]);
if (process.argv.includes('--watch')) await Promise.all(contexts.map(context => context.watch()));
else { await Promise.all(contexts.map(context => context.rebuild())); await Promise.all(contexts.map(context => context.dispose())); }
