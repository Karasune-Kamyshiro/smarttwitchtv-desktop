#!/usr/bin/env node
// Assembles a runnable app directory: Electron's prebuilt binary + our app in resources/app.
// usage: node scripts/assemble.mjs <outdir>        (default: dist/smarttwitchtv)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'dist', 'smarttwitchtv'));
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');

if (!fs.existsSync(path.join(electronDist, 'electron'))) {
    console.error('Electron binary missing: run `npm ci && node node_modules/electron/install.js` first.');
    process.exit(1);
}
if (!fs.existsSync(path.join(root, 'web', 'index.html'))) {
    console.error('web/ missing: run `node scripts/prepare-web.mjs <upstream>` first.');
    process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.cpSync(electronDist, out, { recursive: true, verbatimSymlinks: true });
fs.renameSync(path.join(out, 'electron'), path.join(out, 'smarttwitchtv'));
fs.rmSync(path.join(out, 'resources', 'default_app.asar'), { force: true });

const app = path.join(out, 'resources', 'app');
fs.mkdirSync(app, { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const runtimePkg = {
    name: pkg.name,
    productName: pkg.productName,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    main: pkg.main
};
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(runtimePkg, null, 2) + '\n');

// App code without dev-only helpers (smoke test driver, offline mock).
fs.cpSync(path.join(root, 'src'), path.join(app, 'src'), {
    recursive: true,
    filter: (p) => !p.includes(`${path.sep}dev`) && !p.endsWith('smoke.js')
});
fs.cpSync(path.join(root, 'web'), path.join(app, 'web'), { recursive: true });
fs.mkdirSync(path.join(app, 'build'), { recursive: true });
fs.copyFileSync(path.join(root, 'build', 'icon.png'), path.join(app, 'build', 'icon.png'));
fs.cpSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE.SmartTwitchTV-Desktop'));

console.log(`assembled ${out}`);
