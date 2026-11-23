'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { versionHTML } = require('../scripts/version-assets.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quri-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'js'));
  fs.mkdirSync(path.join(root, 'css'));
  fs.writeFileSync(path.join(root, 'js/app.js'), 'window.release = 1;');
  fs.writeFileSync(path.join(root, 'css/app.css'), 'body { color: #123; }');
  return root;
}

test('content versions change only when their asset changes and remain idempotent', t => {
  const root = fixture(t);
  const input = '<link rel="stylesheet" href="css/app.css"><script defer src="js/app.js"></script>';
  const first = versionHTML(input, root);
  assert.equal(first.count, 2);
  assert.match(first.html, /css\/app\.css\?v=[a-f\d]{12}/);
  assert.match(first.html, /js\/app\.js\?v=[a-f\d]{12}/);
  assert.equal(versionHTML(first.html, root).html, first.html);
  fs.writeFileSync(path.join(root, 'js/app.js'), 'window.release = 2;');
  const next = versionHTML(first.html, root);
  assert.notEqual(next.html, first.html);
  assert.equal(/href="([^"]+)"/.exec(next.html)[1], /href="([^"]+)"/.exec(first.html)[1]);
  assert.notEqual(/src="([^"]+)"/.exec(next.html)[1], /src="([^"]+)"/.exec(first.html)[1]);
});

test('versioning preserves other URL parameters and ignores external resources and comments', t => {
  const root = fixture(t);
  const external = '<script src="https://cdn.example/app.js"></script><link rel="icon" href="favicon.svg"><!-- <script src="missing.js"></script> -->';
  const input = '<script data-src="untouched.js" src=\'js/app.js?lang=ko&amp;v=old#main\'></script>' + external;
  const result = versionHTML(input, root);
  assert.equal(result.count, 1);
  assert.match(result.html, /js\/app\.js\?lang=ko&amp;v=[a-f\d]{12}#main/);
  assert.match(result.html, /data-src="untouched.js"/);
  assert.ok(result.html.endsWith(external));
  assert.equal(versionHTML(result.html, root).html, result.html);
  assert.throws(() => versionHTML('<script src="../outside.js"></script>', root), /escapes/);
  assert.throws(() => versionHTML('<script src="/js/app.js"></script>', root), /project-relative/);
  assert.throws(() => versionHTML('<script src="js/missing.js"></script>', root), /ENOENT/);
});

test('check mode detects a stale release without modifying HTML, then accepts a generated release', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts/version-assets.cjs');
  fs.copyFileSync(path.join(__dirname, '../scripts/version-assets.cjs'), script);
  const index = path.join(root, 'index.html');
  const input = '<script src="js/app.js"></script>';
  fs.writeFileSync(index, input);
  const stale = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.equal(stale.status, 1);
  assert.equal(fs.readFileSync(index, 'utf8'), input);
  assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 0);
  assert.notEqual(fs.readFileSync(index, 'utf8'), input);
  assert.equal(spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' }).status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'js/app.js'), 'utf8'), 'window.release = 1;');
});
