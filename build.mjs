import esbuild from 'esbuild';
import fs from 'node:fs';
fs.mkdirSync('dist', { recursive: true });
await esbuild.build({
  entryPoints: ['src/main.ts'], bundle: true, outfile: 'dist/main.js', format: 'cjs', target: 'es2021',
  platform: 'browser', minify: true, sourcemap: false, logLevel: 'info',
  external: ['obsidian', 'electron', 'child_process', 'fs', 'os', 'path', '@codemirror/*', '@lezer/*'],
});
fs.copyFileSync('styles.css', 'dist/styles.css');
fs.copyFileSync('manifest.json', 'dist/manifest.json');
