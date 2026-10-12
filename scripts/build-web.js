'use strict';
/* Assembles webos/www from the desktop renderer + webOS bridge shim. */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, '..', 'desktop-client', 'renderer');
const WWW = path.join(ROOT, 'www');

const mkdirp = (d) => { fs.mkdirSync(d, { recursive: true }); return d; };
const copy = (a, b) => { fs.copyFileSync(a, b); console.log('copied', path.relative(ROOT, b)); };

fs.rmSync(WWW, { recursive: true, force: true });
mkdirp(path.join(WWW, 'vendor'));
copy(path.join(SRC, 'app.js'), path.join(mkdirp(path.join(WWW, 'js')), 'app.js'));
copy(path.join(SRC, 'styles.css'), path.join(mkdirp(path.join(WWW, 'css')), 'styles.css'));

let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
// Strip the desktop CSP meta: on the TV, 'self' doesn't match file: URLs,
// so it blocks every script/style the app ships with.
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '');

// Inline the stylesheet: some webOS WebEngine builds refuse file:// CSS
const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
html = html.replace('<link rel="stylesheet" href="styles.css">', '<style>' + css + '</style>');
html = html.replace('<title>MyTV+ Desktop</title>', '<title>MyTV+ Desktop</title><meta name="build" content="BUILD-1.1.5-A47">');
html = html.replace('<script src="vendor/hls.min.js"></script>',
  '<script src="vendor/crypto-js.min.js"></script>\n' +
  '<script src="vendor/hls.min.js"></script>\n' +
  '<script src="js/native-shim.js"></script>');
html = html.replace('<script src="app.js"></script>', '<script src="js/app.js"></script>');
fs.writeFileSync(path.join(WWW, 'index.html'), html);

copy(path.join(ROOT, '..', 'desktop-client', 'node_modules', 'hls.js', 'dist', 'hls.min.js'), path.join(WWW, 'vendor', 'hls.min.js'));
copy(path.join(ROOT, '..', 'mobile', 'node_modules', 'crypto-js', 'crypto-js.js'), path.join(WWW, 'vendor', 'crypto-js.min.js'));
copy(path.join(ROOT, 'www-shim', 'native-shim.js'), path.join(WWW, 'js', 'native-shim.js'));

// stage pkg/ = appinfo.json + icons + www contents (what ares-package/Launch App expect)
const PKG = path.join(ROOT, 'pkg');
fs.rmSync(PKG, { recursive: true, force: true });
fs.mkdirSync(PKG, { recursive: true });
for (const f of fs.readdirSync(WWW)) fs.cpSync(path.join(WWW, f), path.join(PKG, f), { recursive: true });
for (const f of ['appinfo.json', 'icon80.png', 'icon130.png']) copy(path.join(ROOT, f), path.join(PKG, f));
console.log('www/ and pkg/ built');
