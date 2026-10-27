#!/usr/bin/env node
// Copies the prebuilt SmartTwitchTV web app (upstream `release/` folder) into ./web,
// strips the analytics scripts and injects the desktop bridge + theme.
//
// usage: node scripts/prepare-web.mjs [path-to-SmartTwitchTV-checkout]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.resolve(process.argv[2] || path.join(root, 'upstream'));
const src = path.join(upstream, 'release');
const out = path.join(root, 'web');

if (!fs.existsSync(path.join(src, 'index.html'))) {
    console.error(`No upstream release found at ${src}`);
    process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'githubio'), { recursive: true });

// Only what the app actually loads; githubio/temp is upstream test data (30 MB).
for (const dir of ['css', 'images', 'js', 'json', 'version']) {
    fs.cpSync(path.join(src, 'githubio', dir), path.join(out, 'githubio', dir), { recursive: true });
}
fs.rmSync(path.join(out, 'githubio/js/main_uncompressed.js'), { force: true });

let html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');

// Drop Firebase / Google analytics (upstream wraps their use in try/catch).
html = html.replace(/<script[^>]*src="https:\/\/www\.(gstatic|googletagmanager)\.com[^"]*"[^>]*><\/script>/g, '');

// The desktop bridge must run before main.js (which checks for window.Android).
const inject =
    '<link rel="stylesheet" href="desktop/theme.css">' +
    '<script src="desktop/hls.min.js"></script>' +
    '<script src="desktop/android-shim.js"></script>';
if (!html.includes('<script src="githubio/js/main.js"')) {
    console.error('Could not find main.js script tag in upstream index.html');
    process.exit(1);
}
html = html.replace('<script src="githubio/js/main.js"', inject + '<script src="githubio/js/main.js"');
fs.writeFileSync(path.join(out, 'index.html'), html);

fs.mkdirSync(path.join(out, 'desktop'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules/hls.js/dist/hls.min.js'), path.join(out, 'desktop/hls.min.js'));
for (const f of ['android-shim.js', 'theme.css']) {
    fs.copyFileSync(path.join(root, 'src/renderer', f), path.join(out, 'desktop', f));
}

const version = JSON.parse(fs.readFileSync(path.join(src, 'githubio/version/version.json'), 'utf8'));
fs.writeFileSync(
    path.join(out, 'desktop/upstream.json'),
    JSON.stringify({ VersionBase: version.VersionBase, publishVersionCode: version.publishVersionCode, WebTag: version.WebTag }, null, 2)
);

console.log(`web app prepared from ${src} (upstream ${version.VersionBase}.${version.publishVersionCode}, web ${version.WebTag})`);
