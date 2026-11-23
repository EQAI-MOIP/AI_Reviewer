'use strict';

// Keep HTML, scripts and styles from the same release when Pages/browser caches
// still contain older files. Asset names and project-relative paths stay stable.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function versionHTML(html, root) {
  const directory = fs.realpathSync(root);
  let count = 0;
  const output = html.replace(/<!--[\s\S]*?-->|<(script|link)\b[^>]*>/gi, (tag, kind) => {
    if (!kind) return tag;
    if (kind.toLowerCase() === 'link') {
      const rel = /\srel\s*=\s*(["'])(.*?)\1/i.exec(tag);
      if (!rel || !rel[2].toLowerCase().split(/\s+/).includes('stylesheet')) return tag;
    }
    const attribute = kind.toLowerCase() === 'script' ? 'src' : 'href';
    const matcher = new RegExp('(\\s' + attribute + '\\s*=\\s*)(["\'])(.*?)\\2', 'i');
    return tag.replace(matcher, (original, prefix, quote, reference) => {
      const url = reference.replace(/&amp;/gi, '&');
      if (!url || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url)) return original;
      const hashAt = url.indexOf('#');
      const fragment = hashAt < 0 ? '' : url.slice(hashAt);
      const beforeFragment = hashAt < 0 ? url : url.slice(0, hashAt);
      const queryAt = beforeFragment.indexOf('?');
      const relative = queryAt < 0 ? beforeFragment : beforeFragment.slice(0, queryAt);
      if (relative.startsWith('/') || relative.includes('\\')) throw new Error('Asset must use a project-relative path: ' + relative);
      const filename = path.resolve(directory, decodeURIComponent(relative));
      if (!filename.startsWith(directory + path.sep)) throw new Error('Asset escapes the site directory: ' + relative);
      const actual = fs.realpathSync(filename);
      if (!actual.startsWith(directory + path.sep) || !fs.statSync(actual).isFile()) throw new Error('Asset must be a local file: ' + relative);
      const hash = crypto.createHash('sha256').update(fs.readFileSync(actual)).digest('hex').slice(0, 12);
      const params = new URLSearchParams(queryAt < 0 ? '' : beforeFragment.slice(queryAt + 1));
      params.set('v', hash);
      count++;
      return prefix + quote + relative + '?' + params.toString().replace(/&/g, '&amp;') + fragment + quote;
    });
  });
  return { html: output, count };
}

function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--check')) throw new Error('Usage: node scripts/version-assets.cjs [--check]');
  const root = path.resolve(__dirname, '..');
  const target = path.join(root, 'index.html');
  const current = fs.readFileSync(target, 'utf8');
  const versioned = versionHTML(current, root);
  if (args.includes('--check')) {
    if (current !== versioned.html) {
      console.error('Asset versions are out of date. Run node scripts/version-assets.cjs before updating release checksums.');
      process.exitCode = 1;
    } else console.log(`Asset versions OK: ${versioned.count} content hashes.`);
  } else {
    if (current !== versioned.html) fs.writeFileSync(target, versioned.html);
    console.log(`Updated asset versions: ${versioned.count} content hashes.`);
  }
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { versionHTML };
