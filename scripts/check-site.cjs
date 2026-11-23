'use strict';

// No bundler is needed. Check the files that Pages will serve directly,
// including project sites mounted below /AI_Reviewer/.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const failures = [];
const assets = new Set();
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function asset(from, reference) {
  if (!reference || /^(?:data:|blob:|#)/i.test(reference)) return;
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) {
    failures.push(`${from}: runtime asset must be local: ${reference}`);
    return;
  }
  if (reference.startsWith('/')) {
    failures.push(`${from}: use a relative path for project Pages: ${reference}`);
    return;
  }
  let clean;
  try { clean = decodeURIComponent(reference.split(/[?#]/, 1)[0]); }
  catch (_) { failures.push(`${from}: malformed asset path: ${reference}`); return; }
  const filename = path.resolve(root, path.dirname(from), clean);
  if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    failures.push(`${from}: missing asset: ${reference}`);
    return;
  }
  assets.add(path.relative(root, filename));
}

for (const tag of html.matchAll(/<(?:script|link|img)\b[^>]*>/gi)) {
  for (const attribute of tag[0].matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) asset('index.html', attribute[1]);
}
for (const filename of fs.readdirSync(path.join(root, 'css')).filter(f => f.endsWith('.css'))) {
  const relative = 'css/' + filename;
  for (const reference of fs.readFileSync(path.join(root, relative), 'utf8').matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi)) asset(relative, reference[1]);
}
if (/<base\b/i.test(html)) failures.push('index.html: a base URL can break project and custom-domain hosting.');
if (!fs.existsSync(path.join(root, '.nojekyll'))) failures.push('Missing .nojekyll for the static Pages site.');

const scripts = fs.readdirSync(path.join(root, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f).concat('server.js');
for (const relative of scripts) {
  try { new vm.Script(fs.readFileSync(path.join(root, relative), 'utf8'), { filename: relative }); }
  catch (error) { failures.push(`${relative}: ${error.message}`); }
}
for (const directory of ['assets', 'examples', 'rules']) {
  for (const filename of fs.readdirSync(path.join(root, directory)).filter(f => f.endsWith('.json'))) {
    const relative = directory + '/' + filename;
    try { JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')); }
    catch (error) { failures.push(`${relative}: ${error.message}`); }
  }
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(`Static site OK: ${assets.size} local assets, ${scripts.length} JavaScript files; project-relative paths verified.`);
}
