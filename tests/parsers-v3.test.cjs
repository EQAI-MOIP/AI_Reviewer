/* v3 document ingestion regression tests. Synthetic documents only.
 * PDF/ZIP tests use Node built-ins. Native DOMParser tests use an optional
 * development-only Playwright + Chromium installation and are clearly skipped
 * unless QURI_NATIVE_PARSER_TESTS=1 and that test runtime is available.
 * The Python fixture adapter is also optional and skips when Python is absent.
 * The application itself has no dependencies.
 */
'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const zlib=require('node:zlib');
require('../js/parsers.js');
const P=globalThis.SpecParsers;
const file=(name,bytes)=>({name,size:bytes.length,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length)});
function crc32(data){let c=0xffffffff;for(const b of data){c^=b;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return(c^0xffffffff)>>>0;}
function zip(entries,compress=false){
  const local=[],central=[];let offset=0;
  for(const [name,source] of entries){const data=Buffer.isBuffer(source)?source:Buffer.from(source),packed=compress?zlib.deflateRawSync(data):data,n=Buffer.from(name),l=Buffer.alloc(30),c=Buffer.alloc(46),crc=crc32(data);
    l.writeUInt32LE(0x04034b50);l.writeUInt16LE(compress?8:0,8);l.writeUInt32LE(crc,14);l.writeUInt32LE(packed.length,18);l.writeUInt32LE(data.length,22);l.writeUInt16LE(n.length,26);
    c.writeUInt32LE(0x02014b50);c.writeUInt16LE(compress?8:0,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(packed.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);
    local.push(l,n,packed);central.push(c,n);offset+=l.length+n.length+packed.length;
  }
  const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,cd,end]);
}
function pdf(contents,{imagePages=[],annotatedPages=[],unsupportedPages=[],kidsOverride,claimedCount}={}){
  const objects=[];let next=3;const pages=contents.map(()=>next++),streams=contents.map(()=>next++),font=next++,image=next++,annotation=next++;
  objects[1]='<< /Type /Catalog /Pages 2 0 R >>';objects[2]=`<< /Type /Pages /Count ${claimedCount??contents.length} /Kids [${kidsOverride||pages.map(x=>x+' 0 R').join(' ')}] >>`;
  for(let i=0;i<contents.length;i++){
    objects[pages[i]]=`<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${font} 0 R >> /XObject << /I1 ${image} 0 R >> >> /Contents ${streams[i]} 0 R${annotatedPages.includes(i+1)?` /Annots [${annotation} 0 R]`:''} >>`;
    const text=contents[i]?`BT /F1 12 Tf 10 20 Td (${contents[i]}) Tj ET`:'';
    const data=Buffer.from(text+(imagePages.includes(i+1)?' /I1 Do':''));
    objects[streams[i]]=`<< /Length ${data.length}${unsupportedPages.includes(i+1)?' /Filter /LZWDecode':''} >>\nstream\n${data.toString()}\nendstream`;
  }
  objects[font]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[image]='<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 3 /Filter /ASCIIHexDecode >>\nstream\n00>\nendstream';
  objects[annotation]='<< /Type /Annot /Subtype /Text /Contents (an omitted comment) /Rect [0 0 10 10] >>';
  let out='%PDF-1.4\n',offsets=[0];for(let i=1;i<next;i++){offsets[i]=Buffer.byteLength(out);out+=`${i} 0 obj\n${objects[i]}\nendobj\n`;}
  const start=Buffer.byteLength(out);out+=`xref\n0 ${next}\n0000000000 65535 f \n`+offsets.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${next} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(out);
}
test('PDF marks scan-only pages separately from pages with text',async()=>{
  const r=await P.parse(file('mixed.pdf',pdf(['A complete synthetic patent notice with readable text.',''],{imagePages:[2]})));
  assert.equal(r.quality.pages,2);assert.equal(r.quality.parsedPages,1);assert.equal(r.quality.coverage,50);
  assert.deepEqual(r.quality.unreadablePages,[2]);assert.deepEqual(r.quality.pagesWithImages,[2]);assert.equal(r.quality.pageDetails[1].status,'unreadable');
  assert.equal(r.quality.pageProvenance,'physical');assert.equal(r.quality.visualReviewRequired,true);assert.equal(r.quality.status,'partial');
});
test('100 percent text-page coverage does not certify mixed visual content',async()=>{
  const r=await P.parse(file('mixed-text.pdf',pdf(['This page has text plus a claim diagram.'],{imagePages:[1]})));
  assert.equal(r.quality.coverage,100);assert.equal(r.quality.coverageMeaning,'pages-with-text-not-reading-accuracy');assert.equal(r.quality.status,'partial');
  assert.equal(r.quality.pageDetails[0].status,'partial');assert.ok(r.quality.omittedContent.some(x=>x.kind==='images'));
});
test('PDF annotations are counted as omitted content rather than silently certified',async()=>{
  const r=await P.parse(file('annotation.pdf',pdf(['An ordinary notice with a separate annotation.'],{annotatedPages:[1]})));
  assert.equal(r.quality.visualReviewRequired,true);assert.equal(r.quality.status,'partial');assert.ok(r.quality.omittedContent.some(x=>x.kind==='annotations'&&x.count===1));
});
test('unsupported PDF stream compression retains other pages and flags the missing page',async()=>{
  const r=await P.parse(file('unsupported.pdf',pdf(['First page remains readable and can be reviewed.','Second page cannot be decoded.'],{unsupportedPages:[2]})));
  assert.match(r.text,/First page/);assert.doesNotMatch(r.text,/Second page/);assert.deepEqual(r.quality.unreadablePages,[2]);assert.equal(r.quality.status,'partial');
});
test('cyclic and inconsistent PDF page trees cannot certify physical order',async()=>{
  const r=await P.parse(file('cycle.pdf',pdf(['A sufficiently long valid content string.'],{kidsOverride:'2 0 R 3 0 R',claimedCount:2})));
  assert.equal(r.quality.pageProvenance,'recovered');assert.equal(r.quality.pageOrderVerified,false);assert.equal(r.quality.status,'partial');
});
test('mid-read cancellation stops later PDF pages and never reports partial success',async()=>{
  const controller=new AbortController();let reached=0;
  await assert.rejects(P.parse(file('cancel.pdf',pdf(['First synthetic readable notice page.','Second synthetic readable notice page.','Third synthetic readable notice page.'])),{signal:controller.signal,onProgress:value=>{if(value>0){reached++;controller.abort();}}}),{name:'AbortError'});
  assert.equal(reached,1);
});
test('ZIP path traversal and duplicate aliases are refused before decompression',async()=>{
  await assert.rejects(P.parse(file('bad.hwpx',zip([['../Contents/section0.xml','x']]))),/경로/);
  await assert.rejects(P.parse(file('bad.hwpx',zip([['Contents/./section0.xml','x']]))),/경로/);
  await assert.rejects(P.parse(file('bad.hwpx',zip([['Contents/section0.xml','x'],['Contents/section0.xml','x']]))),/중복/);
});
test('ZIP CRC corruption is refused before XML decoding',async()=>{
  const data=zip([['Contents/section0.xml','<s>valid structure</s>']]);data[30+Buffer.byteLength('Contents/section0.xml')+3]^=1;
  await assert.rejects(P.parse(file('bad.hwpx',data)),/무결성/);
});
test('ZIP declared expansion cannot exceed bounded memory budgets',async()=>{
  const data=zip([['Contents/section0.xml','<s/>']]),cd=data.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  data.writeUInt32LE(33*1024*1024,22);data.writeUInt32LE(33*1024*1024,cd+24);
  await assert.rejects(P.parse(file('bomb.hwpx',data)),/안전 한도/);
});
test('corrupted XML Unicode is not silently reinterpreted as another Korean encoding',async()=>{
  const bytes=Buffer.concat([Buffer.from('<s>'),Buffer.from([0xff]),Buffer.from('</s>')]);
  await assert.rejects(P.parse(file('bad.hwpx',zip([['Contents/section0.xml',bytes]]))),/인코딩이 손상/);
});
test('XML DTD and entity declarations are refused before DOM construction',async()=>{
  await assert.rejects(P.parse(file('bad.docx',zip([['word/document.xml','<!DOCTYPE d [<!ENTITY e "x">]><d>&e;</d>']]))),/외부 선언/);
});
// Independent XML fixture adapter: Python's standard-library ElementTree parses
// syntax, then this small DOM shape exposes the browser methods used by readers.
// It does NOT validate browser DOMParser compatibility or real Word/Hangul output.
const {spawnSync}=require('node:child_process');
const python=process.env.QURI_TEST_PYTHON||'python3';
const pythonReady=spawnSync(python,['-c','import xml.etree.ElementTree'],{stdio:'ignore'}).status===0;
const pythonXML="import sys,json,xml.etree.ElementTree as E\ntry:\n root=E.fromstring(sys.stdin.read())\n def row(n): return {'tag':n.tag,'text':n.text or '', 'tail':n.tail or '', 'attrs':dict(n.attrib), 'children':[row(c) for c in n]}\n print(json.dumps(row(root),ensure_ascii=False))\nexcept Exception:\n print(json.dumps({'tag':'parsererror','text':'malformed XML','tail':'','attrs':{},'children':[]}))";
class XMLFixtureNode{
  constructor(raw,parent=null){this.nodeType=1;this.localName=raw.tag.split('}').pop();this.parentElement=parent;this.attrs=raw.attrs;this.attributes=Object.entries(raw.attrs).map(([name,value])=>({name,localName:name.split('}').pop(),value}));this.children=[];this.childNodes=[];if(raw.text)this.childNodes.push({nodeType:3,nodeValue:raw.text});for(const c of raw.children){const child=new XMLFixtureNode(c,this);this.children.push(child);this.childNodes.push(child);if(c.tail)this.childNodes.push({nodeType:3,nodeValue:c.tail});}}
  get textContent(){return this.childNodes.map(x=>x.nodeType===1?x.textContent:x.nodeValue).join('');}
  getAttribute(name){return this.attrs[name]??this.attributes.find(x=>x.localName===name)?.value??null;}
  getElementsByTagNameNS(_ns,name){return this.children.flatMap(c=>[...(name==='*'||c.localName===name?[c]:[]),...c.getElementsByTagNameNS(_ns,name)]);}
  getElementsByTagName(name){return this.getElementsByTagNameNS('*',name);}
}
class XMLFixtureParser{
  parseFromString(source){const r=spawnSync(python,['-c',pythonXML],{input:source,encoding:'utf8',maxBuffer:4*1024*1024});if(r.status!==0)throw new Error('Fixture XML adapter failed.');const root=new XMLFixtureNode(JSON.parse(r.stdout));return{documentElement:root,getElementsByTagNameNS(ns,name){return[...(name==='*'||root.localName===name?[root]:[]),...root.getElementsByTagNameNS(ns,name)];},getElementsByTagName(name){return this.getElementsByTagNameNS('*',name);}};}
}
test('XML extraction with an independent standard-library fixture adapter (not a native browser)',{skip:pythonReady?false:'Optional Python XML fixture adapter is unavailable; application runtime does not require Python.'},async t=>{
  const old=globalThis.DOMParser;globalThis.DOMParser=XMLFixtureParser;t.after(()=>{if(old===undefined)delete globalThis.DOMParser;else globalThis.DOMParser=old;});
  await xmlScenarios(t,async(name,bytes)=>{try{return{result:await P.parse(file(name,bytes))};}catch(e){return{error:e.message};}});
});
let chromium=null;
try{({chromium}=require('playwright'));}catch(_){try{if(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES)({chromium}=require(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES,'playwright')));}catch(_){}}
const nativeSkip=process.env.QURI_NATIVE_PARSER_TESTS!=='1'?'Optional native browser tests are opt-in (QURI_NATIVE_PARSER_TESTS=1).':!chromium?'Optional Playwright test runtime is not installed. Browser XML tests not run.':false;
test('native Chromium XML/ZIP document reading', {skip:nativeSkip}, async t=>{
  const executablePath=process.env.QURI_TEST_CHROMIUM||(process.platform==='linux'&&fs.existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined);
  let browser;try{browser=await chromium.launch({headless:true,executablePath,args:['--no-sandbox']});}catch(e){t.skip('Optional Chromium executable unavailable: '+e.message.split('\n')[0]);return;}
  t.after(()=>browser.close());const context=await browser.newContext();await context.setOffline(true);const page=await context.newPage();
  await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../js/parsers.js'),'utf8')});
  const native=async(name,bytes)=>page.evaluate(async({name,bytes})=>{try{return{result:await SpecParsers.parse(new File([new Uint8Array(bytes)],name))};}catch(e){return{error:e.message};}},{name,bytes:Array.from(bytes)});
  await xmlScenarios(t,native);
});
async function xmlScenarios(t,native){
  const section=text=>`<hs:sec xmlns:hs="urn:hwp:section" xmlns:hp="urn:hwp:paragraph"><hp:p><hp:run><hp:t>${text}</hp:t></hp:run></hp:p></hs:sec>`;
  const hpf=(items,order)=>`<opf:package xmlns:opf="urn:opf"><opf:manifest>${items.map(([id,href])=>`<opf:item id="${id}" href="${href}"/>`).join('')}</opf:manifest><opf:spine>${order.map(id=>`<opf:itemref idref="${id}"/>`).join('')}</opf:spine></opf:package>`;
  const hwpx=(xml,extras=[])=>zip([['Contents/content.hpf',hpf([['s0','Contents/section0.xml']],['s0'])],['Contents/section0.xml',xml],...extras],true);
  await t.test('HWPX package spine determines section order, not filenames',async()=>{
    const r=await native('ordered.hwpx',zip([['Contents/content.hpf',hpf([['first','Contents/section0.xml'],['second','Contents/section1.xml']],['second','first'])],['Contents/section0.xml',section('Second by package order. First by filename.')],['Contents/section1.xml',section('First by package order. Second by filename.')]],true));
    assert.equal(r.error,undefined);assert.match(r.result.text,/^First by package/);assert.equal(r.result.quality.sectionOrderVerified,true);assert.equal(r.result.quality.pageProvenance,'nonphysical');assert.deepEqual(r.result.metadata.sectionOrder,['Contents/section1.xml','Contents/section0.xml']);
  });
  await t.test('HWPX missing spine remains a visible recovery state',async()=>{
    const r=await native('fallback.hwpx',zip([['Contents/section0.xml',section('Long enough synthetic Korean patent document text.')]]));assert.equal(r.error,undefined);assert.equal(r.result.quality.status,'partial');assert.equal(r.result.quality.sectionOrderVerified,false);assert.equal(r.result.quality.visualReviewRequired,true);
  });
  await t.test('missing package-spine section fails instead of pretending full coverage',async()=>{
    const r=await native('missing.hwpx',zip([['Contents/content.hpf',hpf([['s0','Contents/section0.xml'],['s1','Contents/section1.xml']],['s0','s1'])],['Contents/section0.xml',section('Synthetic first section text for testing.')]]));assert.match(r.error,/본문 구역이 없습니다/);
  });
  await t.test('HWPX nested table order and row/cell provenance are preserved',async()=>{
    const xml='<hs:sec xmlns:hs="urn:hwp:section" xmlns:hp="urn:hwp:paragraph"><hp:p><hp:run><hp:t>Paragraph before table.</hp:t><hp:tbl><hp:tr><hp:tc><hp:p><hp:run><hp:t>Cell A text with claim words.</hp:t></hp:run></hp:p></hp:tc><hp:tc><hp:p><hp:run><hp:t>Cell B text with claim words.</hp:t></hp:run></hp:p></hp:tc></hp:tr></hp:tbl><hp:t>Paragraph after table.</hp:t></hp:run></hp:p></hs:sec>';
    const r=await native('table.hwpx',hwpx(xml));assert.equal(r.error,undefined);assert.deepEqual(r.result.blocks.map(x=>x.text),['Paragraph before table.','Cell A text with claim words.','Cell B text with claim words.','Paragraph after table.']);assert.equal(r.result.blocks[1].location.row,1);assert.equal(r.result.blocks[2].location.cell,2);assert.equal(r.result.quality.visualReviewRequired,true);assert.ok(r.result.blocks.every(x=>x.page===undefined));
  });
  await t.test('HWPX omitted equations and images prevent complete-text claim',async()=>{
    const xml=section('The textual claim is present and contains enough words.').replace('</hp:run>','<hp:equation><hp:script>x+y</hp:script></hp:equation><hp:pic/></hp:run>');const r=await native('visual.hwpx',hwpx(xml));assert.equal(r.error,undefined);assert.equal(r.result.quality.status,'partial');assert.equal(r.result.quality.equations,1);assert.equal(r.result.quality.images,1);assert.equal(r.result.quality.visualReviewRequired,true);assert.doesNotMatch(r.result.text,/x\+y/);
  });
  await t.test('HWPX declared section count must match the package',async()=>{
    const r=await native('header.hwpx',hwpx(section('Synthetic complete text from the first section.'),[['Contents/header.xml','<head secCnt="2"/>']]));assert.match(r.error,/구역 수/);
  });
  await t.test('HWPX preview alone cannot substitute for document body',async()=>{
    const r=await native('preview.hwpx',zip([['Preview/PrvText.txt','Partial visible preview is not the body.']]));assert.match(r.error,/미리보기 텍스트/);
  });
  await t.test('DOCX tables, inserted text, deletions, and note parts retain intended scope',async()=>{
    const xml='<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Original synthetic text in document.</w:t></w:r><w:del><w:r><w:delText>Removed content must be absent.</w:delText></w:r></w:del><w:ins><w:r><w:t>Inserted text is current.</w:t></w:r></w:ins></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table cell retained.</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
    const r=await native('claims.docx',zip([['word/document.xml',xml],['word/footnotes.xml','<w:footnotes xmlns:w="urn:word"><w:footnote><w:p><w:r><w:t>Important footnote is retained.</w:t></w:r></w:p></w:footnote></w:footnotes>']],true));assert.equal(r.error,undefined);assert.match(r.result.text,/Inserted/);assert.doesNotMatch(r.result.text,/Removed/);assert.match(r.result.text,/footnote/);assert.equal(r.result.quality.pageProvenance,'nonphysical');assert.equal(r.result.blocks.find(x=>x.kind==='table').location.cell,1);
  });
  await t.test('DOCX automatic numbering and equations are explicitly omitted',async()=>{
    const xml='<w:document xmlns:w="urn:word" xmlns:m="urn:math"><w:body><w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>A sufficiently long claim with numbered paragraph.</w:t></w:r><m:oMath><m:r><m:t>x+y</m:t></m:r></m:oMath></w:p></w:body></w:document>';
    const r=await native('numbered.docx',zip([['word/document.xml',xml]]));assert.equal(r.error,undefined);assert.equal(r.result.quality.status,'partial');assert.ok(r.result.quality.omittedContent.some(x=>x.kind==='automatic-numbering'));assert.ok(r.result.quality.omittedContent.some(x=>x.kind==='equations'));
  });
  await t.test('malformed XML is rejected by the active XML parser',async()=>{
    const r=await native('broken.docx',zip([['word/document.xml','<w:document xmlns:w="urn:word"><w:p></w:document>']]));assert.match(r.error,/XML이 손상/);
  });
  await t.test('deep XML is refused before recursive paragraph walking',async()=>{
    const r=await native('deep.docx',zip([['word/document.xml','<x>'.repeat(122)+'text'+'</x>'.repeat(122)]]));assert.match(r.error,/중첩 깊이/);
  });
  await t.test('UTF-16 XML is decoded without replacing Korean characters',async()=>{
    const xml='<?xml version="1.0" encoding="UTF-16"?>'+section('정확한 한글 문언을 원문 순서에 맞추어 모두 보존하는 합성 문서입니다.');const bytes=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(xml,'utf16le')]);const r=await native('unicode.hwpx',hwpx(bytes));assert.equal(r.error,undefined);assert.match(r.result.text,/정확한 한글 문언/);assert.equal(r.result.quality.status,'good');
  });
}
