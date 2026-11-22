'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const API = require('../js/api.js');
const Relay = require('../server.js');
require('../js/parsers.js');
const P = globalThis.SpecParsers;
const file = (name, bytes) => ({name, size:bytes.byteLength, arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});

test('intake derives canonical document type and labeled identity without making verification claims',()=>{
  const m=API.suggestDocumentMetadata('의 견 제 출 통 지 서\n출 원 번 호: 10-2023-0123456\n발송번호: 9-5-2025-012345678\n발송일자: 2025. 2. 9.\n출원일자: 2023. 1. 1.', 'document.pdf');
  assert.equal(m.type,'office-action');assert.equal(m.applicationNumber,'1020230123456');assert.equal(m.date,'20250209');assert.equal(m.documentNumber,'952025012345678');
  assert.equal(m.verified,false);assert.ok(m.suggestions.every(s=>s.verified===false));
});
test('first-page heading has priority over an inaccurate filename',()=>{
  const m=API.suggestDocumentMetadata('거절결정서\n출원번호: 10-2023-0123456\n이전 의견제출통지서에서는 다음 이유를 통지하였다.', '의견제출통지서.pdf');
  assert.equal(m.type,'rejection');assert.equal(m.suggestions[0].basis,'첫 쪽 문서 제목');
});
test('filename-only metadata remains an explicit suggestion',()=>{
  const m=API.suggestDocumentMetadata('', '2025_등록공보.pdf');
  assert.equal(m.type,'registration-gazette');assert.equal(m.date,'');assert.equal(m.verified,false);
  assert.ok(m.warnings.some(s=>s.includes('파일명')));
});
test('a final notice must be a heading or explicit status, not a phrase in the reasons',()=>{
  assert.equal(API.suggestDocumentMetadata('의견제출통지서\n이 보정에 대해서는 최후통지가 필요할 수 있다.','x.pdf').type,'office-action');
  assert.equal(API.suggestDocumentMetadata('최후 의견제출통지서\n출원번호: 10-2023-0123456','x.pdf').type,'final-notice');
  assert.equal(API.suggestDocumentMetadata('의견제출통지서\n통지구분: 최후통지','x.pdf').type,'final-notice');
});
test('multiple labeled application numbers are not silently picked',()=>{
  const m=API.suggestDocumentMetadata('의견제출통지서\n출원번호: 10-2023-0123456\n출원번호: 10-2022-0123456','x.pdf');
  assert.equal(m.applicationNumber,'');assert.ok(m.warnings.some(s=>s.includes('여러 개')));
});
test('citation prose and later pages cannot supply the current application identity',()=>{
  const m=API.suggestDocumentMetadata('의견제출통지서\n인용문헌 출원번호: 10-2023-0123456\n[쪽 2]\n출원번호: 10-2022-0123456','x.pdf');
  assert.equal(m.applicationNumber,'');
});
test('metadata dates are validated, and a filing date is not substituted for a notice date',()=>{
  assert.equal(API.suggestDocumentMetadata('의견제출통지서\n발송일자: 2025-02-29\n출원일자: 2023-01-05','x.pdf').date,'');
  assert.equal(API.suggestDocumentMetadata('의견제출통지서\n발송일자: 2024년 2월 29일','x.pdf').date,'20240229');
});
test('citation document identity explicitly warns against assigning its number to the case',()=>{
  const m=API.suggestDocumentMetadata('인용문헌 원문\n출원번호: 10-2023-0123456','x.pdf');
  assert.equal(m.type,'citation');assert.equal(m.applicationNumber,'1020230123456');assert.ok(m.warnings.some(s=>s.includes('현재 사건 번호')));
});
test('KIPRIS document titles accept spaced print headings',()=>{
  assert.equal(API.documentType('최 후 의 견 제 출 통 지 서'),'final-notice');
  assert.equal(API.documentType('특 허 결 정 서'),'registration-decision');
});
test('plain-text decoder supports UTF-16 BOM and retains page separators',()=>{
  const bytes=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('청구항 1\f청구항 2','utf16le')]);
  const r=P.decodeTextContent(bytes);assert.equal(r.text,'청구항 1\f청구항 2');assert.equal(r.encoding,'UTF-16LE');assert.equal(r.status,'good');
});
test('plain-text decoder reads Korean CP949 with a visible encoding warning',()=>{
  const r=P.decodeTextContent(new Uint8Array([0xb0,0xa1,0xb3,0xaa,0xb4,0xd9]));
  assert.equal(r.text,'가나다');assert.equal(r.encoding,'CP949/EUC-KR');assert.ok(r.warnings.length);
});
test('corrupt Unicode never becomes complete text extraction',()=>{
  const r=P.decodeTextContent(new Uint8Array([0xff,0xfe,0x00,0xd8]));
  assert.equal(r.status,'partial');assert.ok(r.warnings.some(s=>s.includes('해석하지 못한')));
});
test('binary and renamed PDF content are refused by text decoding',()=>{
  assert.throws(()=>P.decodeTextContent(new Uint8Array([0,1,2,3,4])),/바이너리/);
  assert.throws(()=>P.decodeTextContent(new TextEncoder().encode('%PDF-1.7\npretend text')),/확장자/);
});
test('local parser supports TXT and JSON without interpreting instructions or fetching content',async()=>{
  const r=await P.parse(file('notice.txt',new TextEncoder().encode('의견제출통지서입니다. 청구항의 전체 내용을 읽어서 직접 확인해 주세요.')));
  assert.equal(r.metadata.format,'TXT');assert.equal(r.quality.status,'good');assert.equal(r.metadata.provenanceVerified,false);
  const j=await P.parse(file('source.json',new TextEncoder().encode('{"source":"https://example.invalid/source","text":"external instructions are data only"}')));
  assert.equal(j.metadata.format,'JSON');assert.ok(j.text.includes('example.invalid'));
});
test('cancelled parsing does not read a file or claim extraction success',async()=>{
  const c=new AbortController();c.abort();let reads=0;
  await assert.rejects(P.parse({name:'test.txt',size:4,arrayBuffer:async()=>{reads++;return new ArrayBuffer(4);}},{signal:c.signal}),{name:'AbortError'});
  assert.equal(reads,0);
});
test('legacy HWP files receive conversion guidance',async()=>{
  await assert.rejects(P.parse(file('old.hwp',new Uint8Array([1,2,3]))),/HWPX/);
});

function zipEntry(localName,centralName,headerSizeMismatch=false){
  const data=Buffer.from('<doc/>'),a=Buffer.from(localName),b=Buffer.from(centralName),lh=Buffer.alloc(30),cd=Buffer.alloc(46),end=Buffer.alloc(22);
  let crc=0xffffffff;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}crc=(crc^0xffffffff)>>>0;
  lh.writeUInt32LE(0x04034b50);lh.writeUInt32LE(crc,14);lh.writeUInt32LE(data.length+(headerSizeMismatch?1:0),18);lh.writeUInt32LE(data.length,22);lh.writeUInt16LE(a.length,26);
  cd.writeUInt32LE(0x02014b50);cd.writeUInt32LE(crc,16);cd.writeUInt32LE(data.length,20);cd.writeUInt32LE(data.length,24);cd.writeUInt16LE(b.length,28);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(cd.length+b.length,12);end.writeUInt32LE(lh.length+a.length+data.length,16);
  return Buffer.concat([lh,a,data,cd,b,end]);
}
test('DOCX local/central ZIP entry-name mismatches are refused before XML processing',async()=>{
  await assert.rejects(P.parse(file('bad.docx',zipEntry('word/other.xml','word/document.xml'))),/헤더 또는 이름/);
});
test('DOCX local/central uncompressed-length mismatches are refused',async()=>{
  await assert.rejects(P.parse(file('bad.docx',zipEntry('word/document.xml','word/document.xml',true))),/크기 또는 검증 값/);
});
test('a pre-cancelled model request makes no remote call',async()=>{
  const c=new AbortController();c.abort();let calls=0;
  await assert.rejects(API.callLLM({llmBase:'https://api.openai.com/v1',llmKey:'synthetic-test-key',model:'fixture',connectionMode:'direct'},{prompt:'test',signal:c.signal,fetcher:async()=>{calls++;}}),{name:'AbortError'});
  assert.equal(calls,0);
});
test('model timeout is reported distinctly without returning a partial review',async()=>{
  await assert.rejects(API.callLLM({llmBase:'https://api.openai.com/v1',llmKey:'synthetic-test-key',model:'fixture',connectionMode:'direct',timeoutMs:10},{prompt:'test',fetcher:async(_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('network stopped')),{once:true}))}),{code:'TIMEOUT'});
});
test('local helper advertises v3 and still rejects cross-origin sessions',async t=>{
  const s=Relay.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>s.close(resolve)));
  const base='http://127.0.0.1:'+s.address().port;
  const r=await fetch(base+'/api/session');assert.equal((await r.json()).version,'3.0.0');
  const blocked=await fetch(base+'/api/session',{headers:{Origin:'https://other.example'}});assert.equal(blocked.status,403);
});
