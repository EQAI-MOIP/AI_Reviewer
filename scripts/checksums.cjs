'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'SHA256SUMS.txt');
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'))]
  .filter(file => file && file !== 'SHA256SUMS.txt' && fs.existsSync(path.join(root, file)))
  .sort();
const contents = files.map(file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') + '  ' + file + '\n').join('');

if (process.argv.includes('--check')) {
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== contents) {
    console.error('SHA256SUMS.txt is out of date. Run node scripts/checksums.cjs after the final source change.');
    process.exitCode = 1;
  } else console.log(`Checksums OK: ${files.length} files.`);
} else {
  fs.writeFileSync(target, contents);
  console.log(`Updated SHA256SUMS.txt for ${files.length} files.`);
}
