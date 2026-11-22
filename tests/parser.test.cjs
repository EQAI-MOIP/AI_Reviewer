'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../js/parsers.js');
const parse = async name => {
  const data = fs.readFileSync(path.join(__dirname, 'fixtures', name));
  return globalThis.SpecParsers.parse({name, size:data.length,
    arrayBuffer:async()=>data.buffer.slice(data.byteOffset,data.byteOffset+data.length)});
};
test('original Specimen Korean PDF fixture decodes its real CMap with complete page coverage', async()=>{
  const result = await parse('korean-cmap.pdf');
  assert.equal(result.text, '명세서 검토용 합성 시험입니다. 센서부가 측정값을 제어부로 전달합니다.');
  assert.equal(result.quality.pages,1); assert.equal(result.quality.parsedPages,1);
  assert.equal(result.quality.missingGlyphs,0); assert.equal(result.quality.status,'good');
});
test('original compressed PDF fixture reads through the native decompression API', async()=>{
  const result = await parse('flate.pdf');
  assert.equal(result.text,'This is synthetic patent specification. Sensor reads values.\n\nClaim one: controller receives sensor data.');
  assert.equal(result.quality.coverage,100); assert.equal(result.quality.truncated,false);
  assert.equal(result.metadata.provenanceVerified,false);
});
