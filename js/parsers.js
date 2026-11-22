/*
 * SPECIMEN document readers, QURI v3 document reader 5.0.0
 * Original, dependency-free implementation. Browser APIs only; no network I/O.
 * Reading scope is text, not image authenticity, OCR, legal validity, or layout.
 * Format references are recorded in docs/DOCUMENTS-V3.md.
 */
(function (root) {
  'use strict';

  const VERSION = '5.0.0';
  const LIMIT = Object.freeze({file:30*1024*1024, entry:32*1024*1024,
    expanded:100*1024*1024, entries:5000, text:2000000, blocks:25000,
    pages:1000, objects:120000, cmap:120000, tokens:2500000, xmlNodes:250000, xmlDepth:120});
  const utf8 = new TextDecoder('utf-8');
  const fail = (message) => { throw new Error(message); };
  const nameOf = x => x && typeof x === 'object' && x.name || '';
  const isRef = x => x && typeof x === 'object' && Number.isInteger(x.ref);
  const isString = x => x && typeof x === 'object' && x.bytes instanceof Uint8Array;
  const unique = values => Array.from(new Set(values));
  const clean = s => String(s || '').replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'');
  function binary(bytes) {
    let s='';
    for(let i=0;i<bytes.length;i+=16384) s+=String.fromCharCode.apply(null,bytes.subarray(i,i+16384));
    return s;
  }
  function bytesOf(s) { const b=new Uint8Array(s.length); for(let i=0;i<s.length;i++) b[i]=s.charCodeAt(i)&255; return b; }
  function resultOf(format, records, metadata, warnings, info) {
    const blocks=[]; let text='', truncated=false;
    for(const row of records) {
      const value=clean(row.text).trim(); if(!value) continue;
      if(blocks.length>=LIMIT.blocks || text.length+value.length+2>LIMIT.text) {truncated=true;break;}
      if(text) text+='\n\n';
      const start=text.length; text+=value;
      blocks.push({...row,id:'b'+(blocks.length+1),text:value,start,end:text.length});
    }
    if(truncated) warnings.push('추출 한도(본문 200만 자 또는 25,000문단)를 넘어 이후 내용은 분석하지 않았습니다.');
    const usable=(text.match(/[\p{L}\p{N}]/gu)||[]).length;
    let status=info && info.status || 'good';
    if(truncated && status==='good') status='partial';
    if(usable<20) status='insufficient';
    const reason=status==='insufficient'?'분석 가능한 텍스트가 충분하지 않습니다. 스캔·이미지 문서라면 텍스트 원본을 사용하세요.':
      status==='partial'?'본문의 일부가 누락되거나 문자·읽기 순서를 완전히 확인하지 못했습니다. 원문과 대조하세요.':
      '지원하는 텍스트 구조를 읽었습니다. 그림·수식의 의미와 원본 화면 배치는 검사하지 않습니다.';
    return {text,blocks,metadata:{format,parserVersion:VERSION,...metadata,provenanceVerified:false},warnings:unique(warnings),
      quality:{...(info||{}),status,reason,chars:text.length,usableChars:usable,truncated,visualReviewRequired:Boolean(info&&info.visualReviewRequired||truncated||status!=='good')}};
  }

  async function decompress(data, format, max, budget) {
    if(typeof DecompressionStream==='undefined') fail('이 브라우저에는 문서 압축 해제 기능이 없습니다. 최신 Microsoft Edge 또는 Chrome에서 열어 주세요.');
    let transform;
    try { transform=new DecompressionStream(format); }
    catch(e) { fail('이 브라우저는 '+format+' 압축을 지원하지 않습니다. 최신 Microsoft Edge 또는 Chrome이 필요합니다.'); }
    const reader=new Blob([data]).stream().pipeThrough(transform).getReader();
    const chunks=[];let total=0;
    try {
      for(;;) {
        const {done,value}=await reader.read();if(budget&&budget.checkAbort)budget.checkAbort(); if(done)break;
        total+=value.length;
        if(total>max || budget && budget.used+total>LIMIT.expanded) {
          await reader.cancel();fail('압축 해제 크기가 안전 한도를 초과했습니다. 문서를 나누어 사용하세요.');
        }
        chunks.push(value);
      }
    } catch(e){try{await reader.cancel();}catch(_){}throw e;} finally {reader.releaseLock();}
    if(budget)budget.used+=total;
    const out=new Uint8Array(total);let p=0;
    for(const chunk of chunks){out.set(chunk,p);p+=chunk.length;}
    return out;
  }

  let crcTable;
  function crc32(data) {
    if(!crcTable){crcTable=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;crcTable[n]=c>>>0;}}
    let c=0xffffffff;for(let n=0;n<data.length;n++)c=crcTable[(c^data[n])&255]^(c>>>8);return (c^0xffffffff)>>>0;
  }
  class ZipReader {
    constructor(bytes,checkAbort) {
      this.checkAbort=checkAbort||(()=>{});this.checkAbort();
      this.bytes=bytes;this.view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      this.entries=new Map();this.cache=new Map();this.budget={used:0,checkAbort:this.checkAbort};
      let end=-1;
      for(let p=bytes.length-22;p>=Math.max(0,bytes.length-65557);p--)
        if(this.u32(p)===0x06054b50 && p+22+this.u16(p+20)===bytes.length){end=p;break;}
      if(end<0)fail('올바른 ZIP 기반 문서가 아니거나 파일이 손상되었습니다. DOCX/HWPX 원본을 다시 저장해 주세요.');
      if(this.u16(end+4)||this.u16(end+6)||this.u16(end+8)!==this.u16(end+10))fail('분할 압축 문서는 지원하지 않습니다.');
      const count=this.u16(end+10), size=this.u32(end+12), start=this.u32(end+16);
      if(count===65535||size===0xffffffff||start===0xffffffff)fail('ZIP64 문서는 지원하지 않습니다. 파일을 나누어 저장해 주세요.');
      if(count>LIMIT.entries||start+size>end)fail('문서 패키지의 항목 수 또는 구조가 안전 한도를 벗어났습니다.');
      let p=start,declared=0;const ranges=[];
      for(let i=0;i<count;i++) {
        if(i%128===0)this.checkAbort();
        if(p+46>start+size||this.u32(p)!==0x02014b50)fail('문서 압축 목록이 손상되었습니다.');
        const flags=this.u16(p+8), method=this.u16(p+10), crc=this.u32(p+16),compressed=this.u32(p+20),expanded=this.u32(p+24);
        const nl=this.u16(p+28),xl=this.u16(p+30),cl=this.u16(p+32),offset=this.u32(p+42);
        if(p+46+nl+xl+cl>start+size)fail('문서 압축 목록의 길이가 올바르지 않습니다.');
        if(flags&1||flags&64)fail('암호화된 문서는 분석할 수 없습니다. 암호를 해제한 사본을 사용하세요.');
        if(compressed===0xffffffff||expanded===0xffffffff||offset===0xffffffff)fail('ZIP64 항목은 지원하지 않습니다.');
        let entryName;try{entryName=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(p+46,p+46+nl)).replace(/\\/g,'/');}catch(_){fail('문서 내부 경로의 문자 인코딩이 올바르지 않습니다.');}
        if(!entryName||/[\u0000-\u001f\u007f]/.test(entryName)||/^(?:[a-z]:|\/)/i.test(entryName)||entryName.split('/').some(x=>x==='..'||x==='.')||this.entries.has(entryName))fail('문서 내부 경로가 잘못되었거나 중복되어 있습니다.');
        declared+=expanded;
        if(expanded>LIMIT.entry||declared>LIMIT.expanded)fail('압축 해제 예상 크기가 안전 한도(항목 32MiB, 전체 100MiB)를 초과합니다.');
        if(offset+30>start||this.u32(offset)!==0x04034b50)fail('문서 내부 항목 위치가 올바르지 않습니다.');
        const localFlags=this.u16(offset+6),localMethod=this.u16(offset+8),localNameLength=this.u16(offset+26);
        const dataStart=offset+30+localNameLength+this.u16(offset+28);
        const localName=utf8.decode(bytes.subarray(offset+30,offset+30+localNameLength)).replace(/\\/g,'/');
        if(localFlags!==flags||localMethod!==method||dataStart+compressed>start||localName!==entryName)fail('문서 압축 항목의 헤더 또는 이름이 일치하지 않습니다.');
        if(!(flags&8)&&(this.u32(offset+14)!==crc||this.u32(offset+18)!==compressed||this.u32(offset+22)!==expanded))fail('문서 압축 항목의 크기 또는 검증 값이 일치하지 않습니다.');
        ranges.push([offset,dataStart+compressed]);
        this.entries.set(entryName,{name:entryName,flags,method,crc,compressed,expanded,dataStart});
        p+=46+nl+xl+cl;
      }
      if(p!==start+size)fail('문서 압축 목록의 선언 크기와 실제 항목 길이가 일치하지 않습니다.');
      ranges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<ranges.length;i++)if(ranges[i][0]<ranges[i-1][1])fail('문서 압축 항목의 데이터 범위가 겹칩니다.');
    }
    u16(p){return p>=0&&p+2<=this.bytes.length?this.view.getUint16(p,true):-1;}
    u32(p){return p>=0&&p+4<=this.bytes.length?this.view.getUint32(p,true):-1;}
    has(name){return this.entries.has(name);}
    names(){return Array.from(this.entries.keys());}
    async read(name) {
      this.checkAbort();
      if(this.cache.has(name))return this.cache.get(name);
      const e=this.entries.get(name);if(!e)fail('필수 문서 구성 요소가 없습니다: '+name);
      const compressed=this.bytes.subarray(e.dataStart,e.dataStart+e.compressed);
      let data;
      if(e.method===0){data=compressed;this.budget.used+=data.length;}
      else if(e.method===8)data=await decompress(compressed,'deflate-raw',Math.min(LIMIT.entry,e.expanded+1),this.budget);
      else fail('지원하지 않는 문서 압축 방식입니다: '+e.method);
      if(data.length!==e.expanded||crc32(data)!==e.crc)fail('문서 압축 항목의 길이 또는 무결성 검사에 실패했습니다: '+name);
      this.checkAbort();this.cache.set(name,data);return data;
    }
    async xml(name) { return parseXML(await this.read(name),name); }
  }
  function decodeText(bytes,warnings) {
    if(bytes[0]===0xff&&bytes[1]===0xfe)return new TextDecoder('utf-16le').decode(bytes);
    if(bytes[0]===0xfe&&bytes[1]===0xff)return new TextDecoder('utf-16be').decode(bytes);
    try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
    catch(e){if(warnings)warnings.push('UTF-8이 아닌 텍스트를 CP949/EUC-KR로 해석했습니다. 글자가 올바른지 확인하세요.');return new TextDecoder('euc-kr').decode(bytes);}
  }
  function decodeTextContent(bytes) {
    if(!(bytes instanceof Uint8Array))bytes=new Uint8Array(bytes);
    if(bytes.length>LIMIT.file)fail('파일 크기가 30MiB를 초과합니다.');
    const warnings=[];
    if((bytes[0]===0x50&&bytes[1]===0x4b&&bytes[2]===3&&bytes[3]===4)||
      (bytes[0]===0xd0&&bytes[1]===0xcf&&bytes[2]===0x11&&bytes[3]===0xe0)||
      binary(bytes.subarray(0,5))==='%PDF-')fail('문서 형식과 파일 확장자가 다릅니다. PDF·HWPX·DOCX는 원래 확장자로 추가해 주세요.');
    const isUTF16LE=bytes[0]===0xff&&bytes[1]===0xfe,isUTF16BE=bytes[0]===0xfe&&bytes[1]===0xff;
    let text,encoding='UTF-8';
    if(isUTF16LE||isUTF16BE){
      encoding=isUTF16LE?'UTF-16LE':'UTF-16BE';
      text=new TextDecoder(isUTF16LE?'utf-16le':'utf-16be').decode(bytes);
    }else{
      if(bytes.includes(0))fail('텍스트에 바이너리 값이 있습니다. UTF-8로 다시 저장하거나 원래 문서 형식으로 추가해 주세요.');
      try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
      catch(_){encoding='CP949/EUC-KR';text=new TextDecoder('euc-kr').decode(bytes);warnings.push('CP949/EUC-KR 텍스트로 읽었습니다. 원문의 글자가 일치하는지 확인해 주세요.');}
    }
    const controls=(text.match(/[\u0000-\u0008\u000B\u000E-\u001F]/g)||[]).length;
    if(controls>Math.max(3,text.length*0.01))fail('바이너리 또는 손상된 텍스트일 수 있습니다. 원본을 UTF-8로 저장해 다시 추가해 주세요.');
    const replacement=text.includes('\ufffd');
    if(replacement)warnings.push('해석하지 못한 문자가 있습니다. 이 상태로 문언을 확정하지 말고 UTF-8 원본을 다시 추가해 주세요.');
    if(controls)warnings.push('제어문자를 제거했습니다. 원문과 추출 결과를 대조해 주세요.');
    // Preserve form-feed page separators for the review engine's page map.
    return {text:text.replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000B\u000E-\u001F]/g,'').replace(/^\uFEFF/,''),encoding,status:replacement||controls?'partial':'good',warnings};
  }
  function parseXML(bytes,label) {
    // XML must not silently fall back to lossy CP949 decoding. A declared legacy
    // encoding is supported, while corrupted Unicode is a hard parse failure.
    let encoding='utf-8';
    if(bytes[0]===0xff&&bytes[1]===0xfe||bytes[0]===0x3c&&bytes[1]===0&&bytes[2]===0x3f&&bytes[3]===0)encoding='utf-16le';
    else if(bytes[0]===0xfe&&bytes[1]===0xff||bytes[0]===0&&bytes[1]===0x3c&&bytes[2]===0&&bytes[3]===0x3f)encoding='utf-16be';
    else {
      const declaration=binary(bytes.subarray(0,250)).match(/^\s*<\?xml[^?]*encoding\s*=\s*['"]([^'"]+)['"]/i);
      if(declaration){const declared=declaration[1].toLowerCase();if(['euc-kr','cp949','ks_c_5601-1987'].includes(declared))encoding='euc-kr';else if(!['utf-8','utf8'].includes(declared))fail('지원하지 않거나 BOM과 일치하지 않는 XML 문자 인코딩입니다: '+label);}
    }
    let source;try{source=new TextDecoder(encoding,{fatal:true}).decode(bytes);}catch(_){fail('XML 문자 인코딩이 손상되었습니다. 원본을 다시 저장해 주세요: '+label);}
    if(source.includes('\ufffd'))fail('XML에 해석되지 않은 문자가 있어 문언을 확정할 수 없습니다: '+label);
    if(/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source))fail('외부 선언이 포함된 XML은 안전을 위해 처리하지 않습니다: '+label);
    if(typeof DOMParser==='undefined')fail('이 브라우저는 XML 문서 읽기를 지원하지 않습니다.');
    const doc=new DOMParser().parseFromString(source,'application/xml');
    if(doc.getElementsByTagName('parsererror').length||doc.getElementsByTagNameNS('*','parsererror').length||!doc.documentElement)fail('문서 XML이 손상되었습니다: '+label);
    const stack=[[doc.documentElement,1]];let count=0;
    while(stack.length){const [node,depth]=stack.pop();if(++count>LIMIT.xmlNodes||depth>LIMIT.xmlDepth)fail('문서 XML의 요소 수 또는 중첩 깊이가 안전 한도를 초과했습니다: '+label);for(const child of node.children)stack.push([child,depth+1]);}
    return doc;
  }
  const elements=(node,local)=>Array.from(node.getElementsByTagNameNS('*',local));
  const firstText=(node,local)=>{const el=elements(node,local)[0];return el?el.textContent.trim():'';};
  function ancestor(node,names,stop) {for(let n=node.parentElement;n&&n!==stop;n=n.parentElement)if(names.includes(n.localName))return n;return null;}
  function ownParagraphText(p,format) {
    let text='';
    function visit(node) {
      if(node.nodeType!==1)return;
      const n=node.localName;
      if(node!==p&&n==='p')return;
      if(n==='del'||n==='moveFrom'||n==='delText'||n==='instrText'||n==='oMath'||n==='oMathPara'||n==='equation')return;
      if(n==='t'){
        const appendText=container=>{for(const child of container.childNodes){if(child.nodeType===3||child.nodeType===4)text+=child.nodeValue;else if(child.nodeType===1){if(child.localName==='tab')text+='\t';else if(['br','cr','lineBreak'].includes(child.localName))text+='\n';else appendText(child);}}};
        appendText(node);return;
      }
      if(n==='tab'){text+='\t';return;}
      if(n==='br'||n==='cr'||n==='lineBreak'){text+='\n';return;}
      if(n==='noBreakHyphen'){text+='-';return;}
      if(n==='softHyphen')return;
      for(const child of node.children)visit(child);
    }
    visit(p);return text;
  }
  function paragraphRows(doc,part,kind,format) {
    const rows=[],paragraphs=elements(doc,'p'),tables=elements(doc,'tbl');
    const paragraphIndex=new Map(paragraphs.map((p,i)=>[p,i+1])),tableIndex=new Map(tables.map((t,i)=>[t,i+1])),rowIndex=new Map(),cellIndex=new Map();
    for(const table of tables){let row=0;for(const tr of elements(table,'tr'))if(ancestor(tr,['tbl'])===table){rowIndex.set(tr,++row);let cell=0;for(const tc of tr.children)if(tc.localName==='tc')cellIndex.set(tc,++cell);}}
    const excluded=new Set(['del','moveFrom','delText','instrText','oMath','oMathPara','equation']);
    function emitParagraph(p){
      let text='',fragment=0;
      const table=ancestor(p,['tc']),tableNode=table&&ancestor(table,['tbl']),rowNode=table&&ancestor(table,['tr']);
      const location={part,paragraph:paragraphIndex.get(p)};
      if(table){location.table=tableIndex.get(tableNode)||1;if(rowNode){location.row=rowIndex.get(rowNode);location.cell=cellIndex.get(table);}}
      const flush=()=>{if(text.trim()){fragment++;rows.push({text,part,kind:table?'table':kind,location:{...location,fragment},label:part+' · '+(table?'표 '+location.table+' / '+(location.row||'?')+'행 '+(location.cell||'?')+'셀 · ':'')+'문단 '+location.paragraph+(fragment>1?' ('+fragment+')':'')});}text='';};
      const walk=node=>{
        if(node.nodeType!==1)return;const n=node.localName;if(excluded.has(n))return;
        if(node!==p&&n==='p'){flush();emitParagraph(node);return;}
        if(n==='t'){text+=ownParagraphText({nodeType:1,localName:'p',children:[node]},format);return;}
        if(n==='tab'){text+='\t';return;}if(['br','cr','lineBreak'].includes(n)){text+='\n';return;}if(n==='noBreakHyphen'){text+='-';return;}if(n==='softHyphen')return;
        for(const child of node.children)walk(child);
      };
      walk(p);flush();
    }
    const visit=node=>{if(node.nodeType!==1||excluded.has(node.localName))return;if(node.localName==='p'){emitParagraph(node);return;}for(const child of node.children)visit(child);};
    visit(doc.documentElement);return rows;
  }
  async function parseDocx(bytes,progress,checkAbort) {
    const zip=new ZipReader(bytes,checkAbort),warnings=[],rows=[],metadata={};
    if(!zip.has('word/document.xml'))fail('DOCX 본문(word/document.xml)을 찾을 수 없습니다. 파일 형식을 확인하세요.');
    const names=zip.names();let doc=await zip.xml('word/document.xml');
    rows.push(...paragraphRows(doc,'본문','paragraph','docx'));
    const deleted=elements(doc,'del').length+elements(doc,'moveFrom').length,inserted=elements(doc,'ins').length;
    if(deleted||inserted)warnings.push('변경 이력이 있습니다. 삭제·이동 전 텍스트는 제외하고 삽입 텍스트를 포함한 현재 본문을 읽었습니다.');
    let pictures=elements(doc,'drawing').length+elements(doc,'pict').length,formula=elements(doc,'oMath').length,altChunks=elements(doc,'altChunk').length,tables=elements(doc,'tbl').length;const omittedContent=[];
    const visibility=elements(doc,'vanish').length+elements(doc,'webHidden').length,alternates=elements(doc,'AlternateContent').length;if(visibility){omittedContent.push({kind:'uncertain-visibility',count:visibility});warnings.push('숨김 글자 속성이 있어 화면에 보이는 문언과 추출 텍스트가 다를 수 있습니다.');}if(alternates){omittedContent.push({kind:'alternate-content',count:alternates});warnings.push('대체 표시 콘텐츠(AlternateContent)가 있어 동일 내용의 중복 또는 표시 차이가 있을 수 있습니다.');}
    const numbering=elements(doc,'numPr').length,symbols=elements(doc,'sym').length;if(numbering){omittedContent.push({kind:'automatic-numbering',count:numbering});warnings.push('자동 문단 번호는 실제 글자로 복원하지 않았습니다. 청구항 번호·목록 번호는 PDF 원문과 대조해 주세요.');}if(symbols){omittedContent.push({kind:'font-symbols',count:symbols});warnings.push('글꼴 기호(sym)의 문자 매핑은 읽지 않았습니다.');}
    if(pictures)omittedContent.push({kind:'images',count:pictures});if(formula)omittedContent.push({kind:'equations',count:formula});if(altChunks)omittedContent.push({kind:'altChunk',count:altChunks});
    if(pictures)warnings.push('그림·도형 '+pictures+'개는 시각 분석하지 않았습니다. 그림 속 글자나 이미지 생성 여부는 별도 확인이 필요합니다.');
    if(formula)warnings.push('수식 객체의 구조와 의미는 읽지 않았습니다. 수식이 핵심인 문서는 원문 대조가 필요합니다.');
    if(altChunks)warnings.push('외부 삽입 콘텐츠(altChunk)는 읽지 않았습니다.');
    const recordAncillary=partDoc=>{const pi=elements(partDoc,'drawing').length+elements(partDoc,'pict').length,eq=elements(partDoc,'oMath').length,ac=elements(partDoc,'altChunk').length;pictures+=pi;formula+=eq;altChunks+=ac;tables+=elements(partDoc,'tbl').length;if(pi)omittedContent.push({kind:'images',count:pi});if(eq)omittedContent.push({kind:'equations',count:eq});if(ac)omittedContent.push({kind:'altChunk',count:ac});if(pi||eq||ac)warnings.push('각주·미주·머리말·꼬리말의 그림·수식·외부 콘텐츠 일부는 텍스트로 읽지 않았습니다.');};
    const noteParts=['word/footnotes.xml','word/endnotes.xml'];
    for(const part of noteParts)if(zip.has(part)){
      doc=await zip.xml(part);rows.push(...paragraphRows(doc,part.includes('footnotes')?'각주':'미주','note','docx'));recordAncillary(doc);await new Promise(resolve=>setTimeout(resolve,0));if(checkAbort)checkAbort();
    }
    const ancillary=names.filter(n=>/^word\/(header|footer)\d*\.xml$/i.test(n)).sort();
    for(const part of ancillary){doc=await zip.xml(part);rows.push(...paragraphRows(doc,part.includes('header')?'머리말':'꼬리말',part.includes('header')?'header':'footer','docx'));recordAncillary(doc);await new Promise(resolve=>setTimeout(resolve,0));if(checkAbort)checkAbort();}
    if(zip.has('word/comments.xml'))warnings.push('검토 메모(주석)는 작성 본문과 분리하기 위해 분석 대상에서 제외했습니다.');
    const embedded=names.filter(n=>/^word\/embeddings\//.test(n)).length;if(embedded){omittedContent.push({kind:'embedded-documents',count:embedded});warnings.push('본문에 삽입된 별도 문서·OLE 개체의 내부 내용은 분석하지 않았습니다.');}
    metadata.metadataEntries=[];
    if(zip.has('docProps/core.xml')){doc=await zip.xml('docProps/core.xml');for(const key of ['creator','lastModifiedBy','created','modified','title']){const v=firstText(doc,key).slice(0,4000);if(v){metadata[key]=v;metadata.metadataEntries.push({key,value:v,source:'docProps/core.xml',verified:false});}}}
    if(zip.has('docProps/app.xml')){doc=await zip.xml('docProps/app.xml');metadata.producer=firstText(doc,'Application').slice(0,4000);metadata.application=metadata.producer;metadata.appVersion=firstText(doc,'AppVersion').slice(0,100);if(metadata.producer)metadata.metadataEntries.push({key:'application',value:metadata.producer,source:'docProps/app.xml',verified:false});}
    if(zip.has('docProps/custom.xml')){
      try{doc=await zip.xml('docProps/custom.xml');metadata.customProperties=Object.create(null);for(const el of elements(doc,'property').slice(0,100)){const key=String(el.getAttribute('name')||'').slice(0,120),value=String(el.textContent||'').trim().slice(0,4000);if(key&&value){metadata.customProperties[key]=value;metadata.metadataEntries.push({key,value,source:'docProps/custom.xml',verified:false});}}}
      catch(e){warnings.push('사용자 지정 속성을 읽지 못했습니다. 본문 분석은 계속하되 속성의 진위는 확인하지 않습니다.');}
    }
    warnings.push('DOCX의 페이지 번호와 표·단의 시각적 배치는 계산하지 않습니다. 문단과 표 셀의 XML 순서를 사용합니다.');
    if(progress)progress(1);
    return resultOf('DOCX',rows,metadata,warnings,{status:omittedContent.length?'partial':'good',images:pictures,equations:formula,tables,pageProvenance:'nonphysical',pageOrderVerified:false,visualReviewRequired:Boolean(omittedContent.length||tables),omittedContent,unreadablePages:[]});
  }
  async function parseHwpx(bytes,progress,checkAbort) {
    const zip=new ZipReader(bytes,checkAbort),warnings=[],rows=[],metadata={};
    for(const manifest of ['META-INF/manifest.xml','META-INF/encryption.xml'])if(zip.has(manifest)){
      const raw=decodeText(await zip.read(manifest));
      if(/<(?:[\w.-]+:)?(?:encryption-data|EncryptedData|encryption)\b/i.test(raw))fail('암호화된 HWPX 문서는 분석할 수 없습니다. 암호를 해제한 사본을 사용하세요.');
    }
    const availableSections=zip.names().filter(n=>/^Contents\/section\d+\.xml$/i.test(n)).sort((a,b)=>Number(a.match(/section(\d+)/i)[1])-Number(b.match(/section(\d+)/i)[1]));
    if(!availableSections.length)fail('HWPX 본문 구역(Contents/section*.xml)을 찾을 수 없습니다. 미리보기 텍스트를 본문으로 대신 사용하지 않습니다.');
    let sections=availableSections,spineVerified=false,packageDoc=null;
    if(zip.has('Contents/header.xml')){const header=await zip.xml('Contents/header.xml'),declared=Number(header.documentElement.getAttribute('secCnt'));if(Number.isInteger(declared)&&declared>0&&declared!==availableSections.length)fail('HWPX 헤더의 구역 수와 실제 본문 구역 수가 다릅니다.');metadata.declaredSections=Number.isInteger(declared)&&declared>0?declared:null;}
    if(zip.has('Contents/content.hpf')){
      packageDoc=await zip.xml('Contents/content.hpf');const items=new Map();
      for(const item of elements(packageDoc,'item')){
        const id=item.getAttribute('id'),href=item.getAttribute('href')||'';
        if(!id)continue;if(items.has(id))fail('HWPX 패키지에 중복된 문서 ID가 있습니다.');
        if(/^[a-z][a-z\d+.-]*:|^[\/\\]|[?#]|(?:^|[\/\\])\.\.(?:[\/\\]|$)/i.test(href))fail('HWPX 본문 경로가 외부 또는 잘못된 위치를 가리킵니다.');
        const normalized=href.replace(/^\.\//,'').replace(/\\/g,'/');items.set(id,zip.has(normalized)||/^(?:Contents|BinData)\//.test(normalized)?normalized:'Contents/'+normalized);
      }
      const refs=elements(packageDoc,'itemref'),ordered=[];
      for(const ref of refs){const part=items.get(ref.getAttribute('idref'));if(!part)fail('HWPX 읽기 순서의 문서 참조를 찾을 수 없습니다.');if(/^Contents\/section\d+\.xml$/i.test(part)){if(!zip.has(part))fail('HWPX 읽기 순서에 필요한 본문 구역이 없습니다.');if(ordered.includes(part))fail('HWPX 본문 구역이 읽기 순서에 중복되어 있습니다.');ordered.push(part);}}
      if(ordered.length){if(availableSections.some(x=>!ordered.includes(x)))fail('HWPX 본문 구역과 패키지 읽기 순서가 일치하지 않습니다.');sections=ordered;spineVerified=true;}
    }
    if(!spineVerified)warnings.push('HWPX 패키지의 읽기 순서(spine)를 확인하지 못해 구역 파일 번호순으로 복구했습니다. 문단 순서를 원문과 대조해 주세요.');
    metadata.sectionOrder=sections.slice();metadata.sectionOrderSource=spineVerified?'package-spine':'filename-fallback';
    let pictures=0,formula=0,tables=0,embedded=0,numbering=0;
    for(let i=0;i<sections.length;i++){
      const doc=await zip.xml(sections[i]);rows.push(...paragraphRows(doc,'구역 '+(i+1)+' ('+sections[i]+')','paragraph','hwpx'));
      pictures+=elements(doc,'pic').length;formula+=elements(doc,'equation').length;tables+=elements(doc,'tbl').length;embedded+=elements(doc,'ole').length;numbering+=elements(doc,'autoNum').length;
      if(progress)progress((i+1)/sections.length);if(i%4===0)await new Promise(resolve=>setTimeout(resolve,0));
    }
    if(packageDoc){
      const doc=packageDoc;
      for(const key of ['title','creator','date','description']){const value=firstText(doc,key);if(value)metadata[key]=value;}
      metadata.metadataEntries=[];
      for(const el of elements(doc,'meta').slice(0,100)){
        const key=String(el.getAttribute('name')||'').slice(0,120),value=(String(el.textContent||'').trim()||String(el.getAttribute('content')||'')).slice(0,4000);
        if(key&&value){metadata.metadataEntries.push({key,value,source:'Contents/content.hpf',verified:false});const normalized=key.toLowerCase();if(['creator','producer','application','generator','created','modified'].includes(normalized))metadata[normalized]=value;}
      }
    }
    const omittedContent=[];
    if(pictures){omittedContent.push({kind:'images',count:pictures});warnings.push('그림 '+pictures+'개는 시각 분석하지 않았습니다. 이미지 속 텍스트는 별도 확인이 필요합니다.');}
    if(formula){omittedContent.push({kind:'equations',count:formula});warnings.push('수식 객체 '+formula+'개는 의미 분석에서 제외했습니다. PDF로 저장한 원문을 대조하세요.');}
    if(embedded){omittedContent.push({kind:'embedded-documents',count:embedded});warnings.push('본문에 삽입된 별도 문서·OLE 개체의 내부 내용은 분석하지 않았습니다.');}
    if(numbering){omittedContent.push({kind:'automatic-numbering',count:numbering});warnings.push('자동 번호 객체는 실제 글자로 복원하지 않았습니다. 청구항·각주·목록 번호는 PDF 원문과 대조해 주세요.');}
    warnings.push('HWPX 문단과 표 셀의 구조 위치를 기록했습니다. 원본의 쪽 번호, 단 배치, 그림·수식의 의미는 재현하지 않습니다.');
    return resultOf('HWPX',rows,metadata,warnings,{status:!spineVerified||omittedContent.length?'partial':'good',sections:sections.length,images:pictures,equations:formula,tables,sectionOrderVerified:spineVerified,pageProvenance:'nonphysical',pageOrderVerified:false,visualReviewRequired:Boolean(!spineVerified||omittedContent.length||tables),omittedContent,unreadablePages:[]});
  }
  function parseMarkdown(bytes,format='MD') {
    const decoded=decodeTextContent(bytes),warnings=decoded.warnings,source=decoded.text;
    const rows=[];let line=1;
    for(const text of source.split(/\n\s*\n/)){
      rows.push({text,kind:/^\s*#{1,6}\s/.test(text)?'heading':'paragraph',label:'텍스트 문단 '+line,part:'본문'});
      line++;
    }
    if(/!\[[^\]]*\]\(/.test(source))warnings.push('Markdown의 연결 이미지와 외부 문서는 내려받거나 분석하지 않았습니다.');
    if(source.includes('\ufffd'))warnings.push('해석하지 못한 문자가 있습니다. UTF-8로 저장한 원본을 사용하세요.');
    return resultOf(format,rows,{encoding:decoded.encoding},warnings,{status:decoded.status});
  }

  /* PDF object/token reader. This intentionally does not render or execute PDF. */
  class PDFLexer {
    constructor(s,p){this.s=s;this.p=p||0;this.count=0;}
    skip(){while(this.p<this.s.length){const c=this.s.charCodeAt(this.p);if(c===0||c===9||c===10||c===12||c===13||c===32){this.p++;continue;}if(c===37){while(this.p<this.s.length&&!/[\r\n]/.test(this.s[this.p]))this.p++;continue;}break;}}
    word(){const start=this.p;while(this.p<this.s.length&&!/[\s\x00()[\]<>/%]/.test(this.s[this.p]))this.p++;if(start===this.p)this.p++;return this.s.slice(start,this.p);}
    value(depth) {
      if((depth||0)>60)fail('PDF 객체의 중첩 깊이가 안전 한도를 초과했습니다.');
      if(++this.count>LIMIT.tokens)fail('PDF 콘텐츠가 너무 복잡합니다. 문서를 나누어 사용하세요.');
      this.skip();if(this.p>=this.s.length)return undefined;
      const c=this.s[this.p];
      if(c==='/'){this.p++;return {name:this.word().replace(/#([0-9a-f]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)))};}
      if(c==='('){
        this.p++;let level=1,out=[];
        while(this.p<this.s.length&&level){let x=this.s[this.p++];
          if(x==='\\'){
            if(this.p>=this.s.length)break;x=this.s[this.p++];
            const esc={n:10,r:13,t:9,b:8,f:12};
            if(Object.prototype.hasOwnProperty.call(esc,x))out.push(esc[x]);
            else if(/[0-7]/.test(x)){let oct=x;for(let n=0;n<2&&/[0-7]/.test(this.s[this.p]||'x');n++)oct+=this.s[this.p++];out.push(parseInt(oct,8)&255);}
            else if(x==='\r'){if(this.s[this.p]==='\n')this.p++;}
            else if(x!=='\n')out.push(x.charCodeAt(0)&255);
          } else if(x==='('){level++;out.push(40);}else if(x===')'){if(--level)out.push(41);}else if(x==='\r'){out.push(10);if(this.s[this.p]==='\n')this.p++;}else out.push(x.charCodeAt(0)&255);
        }
        if(level)fail('PDF 문자열이 닫히지 않았습니다.');return {bytes:new Uint8Array(out)};
      }
      if(c==='<'&&this.s[this.p+1]==='<'){
        this.p+=2;const dict=Object.create(null);let n=0;
        for(;;){this.skip();if(this.s.slice(this.p,this.p+2)==='>>'){this.p+=2;break;}if(this.p>=this.s.length||++n>50000)fail('PDF 사전 구조가 잘못되었습니다.');
          const key=this.value((depth||0)+1);if(!nameOf(key))fail('PDF 사전 키가 올바르지 않습니다.');dict[key.name]=this.value((depth||0)+1);}
        return dict;
      }
      if(c==='<'){
        const end=this.s.indexOf('>',++this.p);if(end<0)fail('PDF 16진 문자열이 닫히지 않았습니다.');
        let hex=this.s.slice(this.p,end).replace(/\s/g,'');if(!/^[0-9a-f]*$/i.test(hex))fail('PDF 16진 문자열이 올바르지 않습니다.');if(hex.length%2)hex+='0';
        this.p=end+1;return {bytes:hexBytes(hex)};
      }
      if(c==='['){this.p++;const arr=[];for(;;){this.skip();if(this.s[this.p]===']'){this.p++;break;}if(this.p>=this.s.length||arr.length>1000000)fail('PDF 배열 구조가 잘못되었습니다.');arr.push(this.value((depth||0)+1));}return arr;}
      const token=this.word();
      if(/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)){
        const num=Number(token),save=this.p;
        if(Number.isInteger(num)&&num>=0){this.skip();const next=this.word();if(/^\d+$/.test(next)){this.skip();if(this.word()==='R')return {ref:num,gen:Number(next)};}this.p=save;}
        return num;
      }
      if(token==='true')return true;if(token==='false')return false;if(token==='null')return null;
      return {op:token};
    }
  }
  function hexBytes(s){const out=new Uint8Array(Math.ceil(s.length/2));for(let i=0;i<out.length;i++)out[i]=parseInt(s.slice(i*2,i*2+2),16)||0;return out;}
  function hexOf(bytes){let s='';for(const b of bytes)s+=b.toString(16).padStart(2,'0');return s.toUpperCase();}
  function utf16BE(bytes){return new TextDecoder('utf-16be').decode(bytes).replace(/^\uFEFF/,'');}
  function pdfString(value){if(!isString(value))return '';const b=value.bytes;if(b[0]===0xfe&&b[1]===0xff)return utf16BE(b);if(b[0]===0xff&&b[1]===0xfe)return new TextDecoder('utf-16le').decode(b);return new TextDecoder('windows-1252').decode(b);}
  function cappedBytes(initial){
    let data=new Uint8Array(Math.min(LIMIT.entry,Math.max(1024,initial||0))),length=0;
    return {append(...values){const need=length+values.length;if(need>LIMIT.entry)fail('PDF 압축 해제 한도를 초과했습니다.');if(need>data.length){const next=new Uint8Array(Math.min(LIMIT.entry,Math.max(need,data.length*2)));next.set(data);data=next;}data.set(values,length);length=need;},finish(){return data.slice(0,length);}};
  }
  function ascii85(bytes){
    let s=binary(bytes).replace(/\s/g,'').replace(/^<~/,'').replace(/~>$/,'');const out=cappedBytes(bytes.length);let group=[];
    const flush=(pad)=>{const n=group.length;while(group.length<5)group.push(84);let x=0;for(const b of group)x=x*85+b;if(x>0xffffffff)fail('PDF ASCII85 데이터가 잘못되었습니다.');const b=[x>>>24,(x>>>16)&255,(x>>>8)&255,x&255];out.append(...b.slice(0,pad?n-1:4));group=[];};
    for(const c of s){if(c==='z'&&!group.length){out.append(0,0,0,0);continue;}const n=c.charCodeAt(0)-33;if(n<0||n>84)fail('PDF ASCII85 문자가 잘못되었습니다.');group.push(n);if(group.length===5)flush(false);}
    if(group.length===1)fail('PDF ASCII85 마지막 묶음이 올바르지 않습니다.');if(group.length)flush(true);return out.finish();
  }
  function runLength(bytes){const out=cappedBytes(bytes.length*2);for(let p=0;p<bytes.length;){const n=bytes[p++];if(n===128)break;if(n<128){if(p+n+1>bytes.length)fail('PDF RunLength 데이터가 잘못되었습니다.');for(let i=0;i<=n;i++)out.append(bytes[p++]);}else{if(p>=bytes.length)fail('PDF RunLength 데이터가 잘못되었습니다.');const c=bytes[p++];for(let i=0;i<257-n;i++)out.append(c);}}return out.finish();}

  class PDFReader {
    constructor(bytes,checkAbort) {this.checkAbort=checkAbort||(()=>{});this.checkAbort();this.bytes=bytes;this.raw=binary(bytes);this.objects=new Map();this.cache=new Map();this.fontCache=new Map();this.warnings=[];this.budget={used:0,checkAbort:this.checkAbort};this.partial=false;this.root=null;this.info=null;this.missingGlyphs=0;this.totalGlyphs=0;this.structureErrors=0;this.pageOrderVerified=true;}
    warn(s){this.warnings.push(s);}
    resolve(v,depth){if((depth||0)>40)return null;return isRef(v)?this.resolve(this.objects.get(v.ref+' '+v.gen)?.value,(depth||0)+1):v;}
    object(v){return isRef(v)?this.objects.get(v.ref+' '+v.gen):null;}
    async load() {
      if(!/^%PDF-/.test(this.raw.slice(0,1024).trimStart()))fail('PDF 머리글을 찾을 수 없습니다.');
      if(Array.from(this.raw.matchAll(/startxref\s+\d+\s+%%EOF/g)).length>1){this.partial=true;this.pageOrderVerified=false;this.warn('PDF에 여러 저장 리비전이 있습니다. 이 경량 파서는 xref의 현재 리비전 권한을 완전히 검증하지 않으므로 현재 본문을 확정하지 않습니다. 새 PDF로 저장한 사본과 대조하세요.');}
      const re=/(\d+)\s+(\d+)\s+obj\b/g;let m,count=0;
      while((m=re.exec(this.raw))) {
        if(++count>LIMIT.objects)fail('PDF 객체 수가 안전 한도를 초과했습니다.');
        const lexer=new PDFLexer(this.raw,re.lastIndex);let value;
        try{value=lexer.value();}catch(e){this.structureErrors++;continue;}
        lexer.skip();let stream=null,streamStart=null;
        if(this.raw.slice(lexer.p,lexer.p+6)==='stream'&&/[\r\n\s]/.test(this.raw[lexer.p+6]||'')){
          let start=lexer.p+6;if(this.raw[start]==='\r')start++;if(this.raw[start]==='\n')start++;else if(this.raw[start]===' ')start++;
          let end=typeof value?.Length==='number'?start+value.Length:-1;
          if(end<start||end>this.raw.length||!/^\s*endstream/.test(this.raw.slice(end,end+32)))end=this.raw.indexOf('endstream',start);
          if(end<0){this.structureErrors++;continue;}
          streamStart=start;stream=this.bytes.subarray(start,end);lexer.p=this.raw.indexOf('endstream',end)+9;
        }
        const endObj=this.raw.indexOf('endobj',lexer.p);if(endObj<0){this.structureErrors++;continue;}
        const key=m[1]+' '+m[2];this.objects.set(key,{key,value,stream,streamStart,offset:m.index});
        if(nameOf(value?.Type)==='XRef')this.trailer(value);
        re.lastIndex=endObj+6;
      }
      const tr=/trailer\s*<</g;while((m=tr.exec(this.raw))){try{this.trailer(new PDFLexer(this.raw,m.index+7).value());}catch(e){if(/암호화/.test(e.message))throw e;}}
      for(const obj of this.objects.values())if(obj.stream){
        const length=this.resolve(obj.value.Length);
        if(Number.isInteger(length)&&length>=0&&obj.streamStart+length<=this.bytes.length)obj.stream=this.bytes.subarray(obj.streamStart,obj.streamStart+length);
        else {let end=obj.stream.length;if(end&&obj.stream[end-1]===10)end--;if(end&&obj.stream[end-1]===13)end--;obj.stream=obj.stream.subarray(0,end);}
      }
      for(const obj of Array.from(this.objects.values()))if(nameOf(obj.value?.Type)==='ObjStm'){
        try{
          const decoded=await this.stream(obj),s=binary(decoded),n=this.resolve(obj.value.N),first=this.resolve(obj.value.First);
          if(!Number.isInteger(n)||n<0||n>LIMIT.objects||!Number.isInteger(first)||first<0||first>s.length)throw new Error('잘못된 객체 스트림');
          const header=new PDFLexer(s.slice(0,first)),pairs=[];
          for(let i=0;i<n;i++){const id=header.value(),offset=header.value();if(!Number.isInteger(id)||!Number.isInteger(offset)||offset<0||first+offset>s.length)throw new Error('잘못된 압축 객체 위치');pairs.push([id,offset]);}
          for(const [id,offset] of pairs){const key=id+' 0',old=this.objects.get(key);if(old&&old.offset>obj.offset)continue;const value=new PDFLexer(s,first+offset).value();this.objects.set(key,{key,value,stream:null,offset:obj.offset});}
        }catch(e){if(e.name==='AbortError')throw e;this.partial=true;this.warn('압축 PDF 객체의 일부를 읽지 못했습니다: '+e.message);}
      }
      if(this.structureErrors){this.partial=true;this.warn('PDF 객체 구조 '+this.structureErrors+'곳을 읽지 못했습니다. 복구 추출 결과를 원문과 대조하세요.');}
      if(!this.root){this.pageOrderVerified=false;const catalogs=Array.from(this.objects.values()).filter(o=>nameOf(o.value?.Type)==='Catalog');if(catalogs.length)this.root={ref:Number(catalogs[catalogs.length-1].key.split(' ')[0]),gen:Number(catalogs[catalogs.length-1].key.split(' ')[1])};this.partial=true;this.warn('PDF의 문서 루트 정보를 복구했습니다. 문서 순서를 원문과 대조하세요.');}
    }
    trailer(value){if(!value||typeof value!=='object')return;if(value.Encrypt)fail('암호화된 PDF는 분석할 수 없습니다. 암호를 해제한 사본을 사용하세요.');if(value.Root)this.root=value.Root;if(value.Info)this.info=value.Info;}
    async stream(obj) {
      this.checkAbort();
      if(!obj||!obj.stream)throw new Error('PDF 스트림이 없습니다.');if(this.cache.has(obj.key))return this.cache.get(obj.key);
      let data=obj.stream,filters=this.resolve(obj.value.Filter)||[];if(!Array.isArray(filters))filters=[filters];
      let parms=this.resolve(obj.value.DecodeParms)||[];if(!Array.isArray(parms))parms=[parms];
      for(let i=0;i<filters.length;i++){
        const filter=nameOf(this.resolve(filters[i])),p=this.resolve(parms[i]);
        if(p?.Predictor&&p.Predictor!==1)throw new Error('텍스트 스트림의 Predictor 방식은 지원하지 않습니다.');
        if(filter==='FlateDecode'||filter==='Fl')data=await decompress(data,'deflate',LIMIT.entry,this.budget);
        else if(filter==='ASCII85Decode'||filter==='A85')data=ascii85(data);
        else if(filter==='ASCIIHexDecode'||filter==='AHx'){let s=binary(data).replace(/\s/g,'').replace(/>$/,'');if(!/^[a-f0-9]*$/i.test(s))throw new Error('잘못된 ASCIIHex');if(s.length%2)s+='0';data=hexBytes(s);}
        else if(filter==='RunLengthDecode'||filter==='RL')data=runLength(data);
        else throw new Error('지원하지 않는 PDF 압축: '+filter);
        if(data.length>LIMIT.entry)throw new Error('PDF 스트림 한도 초과');
        if(filter!=='FlateDecode'&&filter!=='Fl'){this.budget.used+=data.length;if(this.budget.used>LIMIT.expanded)throw new Error('PDF 전체 스트림 한도 초과');}
      }
      if(!filters.length){this.budget.used+=data.length;if(this.budget.used>LIMIT.expanded)throw new Error('PDF 전체 스트림 한도 초과');}
      this.cache.set(obj.key,data);return data;
    }
    pages(){
      const pages=[],seen=new Set();const catalog=this.resolve(this.root);
      const walk=(ref,resources,depth)=>{
        if(depth>60||pages.length>=LIMIT.pages){this.partial=true;this.pageOrderVerified=false;return;}
        const key=isRef(ref)?ref.ref+' '+ref.gen:ref;if(seen.has(key)){this.partial=true;this.pageOrderVerified=false;this.warn('PDF 페이지 트리에 순환 또는 중복 참조가 있어 쪽 순서를 확정하지 않습니다.');return;}seen.add(key);
        const node=this.resolve(ref);if(!node){this.partial=true;this.pageOrderVerified=false;return;}
        const res=this.resolve(node.Resources)||resources||Object.create(null);
        if(nameOf(node.Type)==='Page'){pages.push({node,resources:res});return;}
        for(const child of this.resolve(node.Kids)||[])walk(child,res,depth+1);
      };
      if(catalog?.Pages)walk(catalog.Pages,null,0);
      if(!pages.length){this.partial=true;this.pageOrderVerified=false;this.warn('페이지 트리를 읽지 못해 PDF 내부 페이지 객체 순서로 추출했습니다.');for(const obj of this.objects.values())if(nameOf(obj.value?.Type)==='Page'){let res=this.resolve(obj.value.Resources),parent=this.resolve(obj.value.Parent),i=0;while(!res&&parent&&i++<30){res=this.resolve(parent.Resources);parent=this.resolve(parent.Parent);}pages.push({node:obj.value,resources:res||{}});if(pages.length>=LIMIT.pages)break;}}
      const expected=this.resolve(this.resolve(catalog?.Pages)?.Count);if(Number.isInteger(expected)&&expected!==pages.length){this.partial=true;this.pageOrderVerified=false;this.warn('PDF '+expected+'쪽 중 '+pages.length+'쪽의 구조만 읽었습니다.');}
      return {pages,expected:Number.isInteger(expected)?Math.max(expected,pages.length):pages.length};
    }
    async font(ref){
      const key=isRef(ref)?ref.ref+' '+ref.gen:ref;if(this.fontCache.has(key))return this.fontCache.get(key);
      const resolved=this.resolve(ref),value=resolved||{},font={value,map:null,lengths:[],encoding:nameOf(this.resolve(value.Encoding)),differences:new Map(),unsupported:!resolved};
      this.fontCache.set(key,font);
      if(value.ToUnicode){try{font.map=parseCMap(binary(await this.stream(this.object(value.ToUnicode))));font.lengths=Array.from(new Set(Array.from(font.map.keys(),s=>s.length/2))).sort((a,b)=>b-a);if(!font.map.size)throw new Error('빈 ToUnicode');}catch(e){if(e.name==='AbortError')throw e;this.partial=true;this.warn('PDF 글꼴 Unicode 매핑을 읽지 못했습니다: '+e.message);}}
      const enc=this.resolve(value.Encoding);
      if(enc&&typeof enc==='object'&&!nameOf(enc)){font.encoding=nameOf(this.resolve(enc.BaseEncoding));let code=0;for(const item of this.resolve(enc.Differences)||[]){if(typeof item==='number')code=item;else if(nameOf(item)){font.differences.set(code++,glyphName(nameOf(item)));}}}
      const base=nameOf(value.BaseFont).replace(/^[A-Z]{6}\+/,'');
      font.composite=nameOf(value.Subtype)==='Type0';
      font.symbolic=/^(?:Symbol|ZapfDingbats|Wingdings|Webdings)/.test(base)||!value.Encoding&&Boolean((this.resolve(value.FontDescriptor)?.Flags||0)&4);
      return font;
    }
    decode(bytes,font){
      this.totalGlyphs+=bytes.length;
      if(!font||font.unsupported){this.missingGlyphs+=bytes.length;return '\ufffd';}
      if(font.map){let out='';for(let p=0;p<bytes.length;){let found=false;for(const size of font.lengths){if(p+size>bytes.length)continue;const v=font.map.get(hexOf(bytes.subarray(p,p+size)));if(v!==undefined){out+=v;this.missingGlyphs+=(v.match(/\ufffd/g)||[]).length;p+=size;found=true;break;}}if(!found){out+='\ufffd';p+=font.composite?Math.min(2,bytes.length-p):1;this.missingGlyphs++;}}return out;}
      if(font.composite){
        if(/^Uni(?:KS|JIS|GB|CNS)-(?:UCS2|UTF16)-[HV]$/.test(font.encoding)){const text=utf16BE(bytes);this.missingGlyphs+=(text.match(/\ufffd/g)||[]).length;return text;}
        if(/^(?:KSC-EUC|KSCms-UHC)-[HV]$/.test(font.encoding)){const text=new TextDecoder('euc-kr').decode(bytes);this.missingGlyphs+=(text.match(/\ufffd/g)||[]).length;return text;}
        if(/^GBK-EUC-[HV]$/.test(font.encoding)){const text=new TextDecoder('gbk').decode(bytes);this.missingGlyphs+=(text.match(/\ufffd/g)||[]).length;return text;}
        this.missingGlyphs+=bytes.length;return '\ufffd'.repeat(Math.max(1,Math.ceil(bytes.length/2)));
      }
      let out='';for(const b of bytes){
        if(font.differences.has(b)){const g=font.differences.get(b);out+=g||'\ufffd';if(!g)this.missingGlyphs++;}
        else if(font.symbolic){out+='\ufffd';this.missingGlyphs++;}
        else if(font.encoding==='WinAnsiEncoding'){const t=new TextDecoder('windows-1252').decode(new Uint8Array([b]));out+=t;this.missingGlyphs+=(t.match(/\ufffd/g)||[]).length;}
        else if(font.encoding==='MacRomanEncoding')out+=new TextDecoder('macintosh').decode(new Uint8Array([b]));
        else if(b>=32&&b<=126)out+=String.fromCharCode(b);
        else if(STANDARD[b])out+=STANDARD[b];
        else if(b===9||b===10||b===13)out+=' ';
        else {out+='\ufffd';this.missingGlyphs++;}
      }return out;
    }
    async content(source,resources,state,depth,seen){
      if(depth>15){this.partial=true;this.warn('중첩된 PDF 폼의 일부를 제외했습니다.');return;}
      const lexer=new PDFLexer(source),args=[],graphics=[];let currentFont=null,inText=false,lastY=null,actual=[],renderMode=0;
      const fonts=this.resolve(resources?.Font)||{},xobjects=this.resolve(resources?.XObject)||{},properties=this.resolve(resources?.Properties)||{};
      const append=s=>{if(!actual.some(x=>x!==null)){state.line+=s;state.charCount=(state.charCount||0)+s.length;if(state.charCount>LIMIT.text)throw new Error('PDF 본문 추출 한도 초과');}};
      const show=b=>{if(!actual.some(x=>x!==null))append(this.decode(b,currentFont));};
      const newline=()=>{if(state.line.trim()){state.lines.push(state.line.trimEnd());state.line='';}};
      while(lexer.p<source.length){
        const value=lexer.value();if(value===undefined)break;
        if(!value||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,'op')){args.push(value);if(args.length>100000)throw new Error('PDF 연산자 인수가 너무 많습니다.');continue;}
        const op=value.op;
        if(op==='q')graphics.push({font:currentFont,renderMode});
        else if(op==='Q'){if(graphics.length){const state=graphics.pop();currentFont=state.font;renderMode=state.renderMode;}}
        else if(op==='BT'){newline();inText=true;lastY=null;}
        else if(op==='ET'){newline();inText=false;}
        else if(op==='Tf'){currentFont=await this.font(fonts[nameOf(args[args.length-2])]);}
        else if(op==='Tr'){renderMode=Number(args[args.length-1]);if(renderMode===3||renderMode===7){this.partial=true;this.warn('화면에 직접 표시되지 않는 PDF 텍스트 렌더링 모드(Tr '+renderMode+')가 있습니다. OCR·숨은 텍스트를 포함할 수 있어 가시 본문과의 일치를 확정하지 않습니다.');}}
        else if(op==='Tm'){const y=args[args.length-1];if(lastY!==null&&typeof y==='number'&&Math.abs(y-lastY)>0.3)newline();else if(state.line&&!/\s$/.test(state.line))append(' ');lastY=y;}
        else if(op==='Td'||op==='TD'){if(Math.abs(Number(args[args.length-1]))>0.3)newline();else if(Number(args[args.length-2])>2&&state.line&&!/\s$/.test(state.line))append(' ');}
        else if(op==='T*')newline();
        else if(op==='Tj'&&inText&&isString(args[args.length-1]))show(args[args.length-1].bytes);
        else if(op==='TJ'&&inText&&Array.isArray(args[args.length-1])){for(const item of args[args.length-1]){if(isString(item))show(item.bytes);else if(typeof item==='number'&&item<-120&&state.line&&!/\s$/.test(state.line))append(' ');}}
        else if((op==="'"||op==='"')&&inText){newline();const t=args[args.length-1];if(isString(t))show(t.bytes);}
        else if(op==='Do'){
          const ref=xobjects[nameOf(args[args.length-1])],obj=this.object(ref),dict=this.resolve(ref);
          if(nameOf(dict?.Subtype)==='Image')state.images++;
          else if(nameOf(dict?.Subtype)==='Form'&&obj&&!seen.has(obj.key)){
            seen.add(obj.key);newline();try{await this.content(binary(await this.stream(obj)),this.resolve(dict.Resources)||resources,state,depth+1,seen);}catch(e){if(e.name==='AbortError')throw e;this.partial=true;this.warn('PDF 폼 텍스트를 일부 읽지 못했습니다: '+e.message);}seen.delete(obj.key);newline();
          }
        }
        else if(op==='BDC'){if(nameOf(args[0])==='OC'){this.partial=true;this.warn('PDF 선택 표시 레이어(OC)의 콘텐츠가 포함되어 있습니다. 현재 화면에서 보이는 내용과 추출 텍스트가 다를 수 있습니다.');}let props=args[args.length-1];if(nameOf(props))props=this.resolve(properties[nameOf(props)]);actual.push(isString(props?.ActualText)?pdfString(props.ActualText):null);}
        else if(op==='BMC')actual.push(null);
        else if(op==='EMC'){const text=actual.pop();if(text)append(text);}
        else if(op==='BI'){const end=/\sEI(?=\s|$)/g;end.lastIndex=lexer.p;const match=end.exec(source);if(!match)throw new Error('인라인 이미지 종료를 찾지 못했습니다.');lexer.p=match.index+match[0].length;state.images++;}
        args.length=0;
        if(state.lines.length>LIMIT.blocks)throw new Error('PDF 본문 추출 한도 초과');
      }
      newline();
    }
    async extract(progress){
      await this.load();const {pages,expected}=this.pages(),rows=[],pageDetails=[],unreadablePages=[],pagesWithImages=[],omittedContent=[];let parsedPages=0,images=0,annotations=0,extractedChars=0;
      const catalog=this.resolve(this.root);
      if(catalog?.AcroForm){omittedContent.push({kind:'form-fields',count:1});this.partial=true;this.warn('대화형 PDF 양식 필드의 별도 값은 추출하지 않았습니다. 정적인 PDF로 저장한 사본을 권장합니다.');}
      if(catalog?.OCProperties){this.partial=true;this.warn('PDF에 선택 표시 레이어(OCProperties)가 있습니다. 레이어의 표시 상태를 계산하지 않으므로 가시 본문을 확정하지 않습니다.');}
      pageLoop: for(let i=0;i<pages.length;i++){
        this.checkAbort();
        const page=pages[i],state={lines:[],line:'',images:0},glyphsBefore=this.missingGlyphs,warningsBefore=this.warnings.length;let refs=page.node.Contents;
        const pageAnnotations=this.resolve(page.node.Annots);if(Array.isArray(pageAnnotations)&&pageAnnotations.length){annotations+=pageAnnotations.length;this.partial=true;this.warn((i+1)+'쪽의 주석·첨부·표시 객체 '+pageAnnotations.length+'개는 본문으로 추출하지 않았습니다.');}
        refs=this.resolve(refs);if(!Array.isArray(refs)){refs=page.node.Contents?[page.node.Contents]:[];}
        let source='';
        for(const ref of refs){try{const obj=this.object(ref);source+=binary(await this.stream(obj))+'\n';}catch(e){if(e.name==='AbortError')throw e;this.partial=true;this.warn((i+1)+'쪽의 콘텐츠 일부를 읽지 못했습니다: '+e.message);}}
        try{await this.content(source,page.resources,state,0,new Set());}catch(e){if(e.name==='AbortError')throw e;this.partial=true;this.warn((i+1)+'쪽 텍스트 추출이 일부 중단되었습니다: '+e.message);}
        const pageText=state.lines.join('\n');
        const usableChars=(pageText.match(/[\p{L}\p{N}]/gu)||[]).length;
        if(usableChars>=5)parsedPages++;
        else{unreadablePages.push(i+1);this.partial=true;this.warn((i+1)+'쪽에서 읽을 수 있는 텍스트를 찾지 못했습니다. 스캔·도면·빈 페이지 또는 미지원 문자매핑일 수 있습니다.');}
        images+=state.images;if(state.images){pagesWithImages.push(i+1);this.partial=true;}
        pageDetails.push({page:i+1,chars:pageText.length,usableChars,images:state.images,missingGlyphs:this.missingGlyphs-glyphsBefore,status:usableChars<5?'unreadable':state.images||this.missingGlyphs>glyphsBefore||this.warnings.length>warningsBefore?'partial':'text'});
        for(let j=0;j<state.lines.length;j++){
          extractedChars+=state.lines[j].length+2;
          if(extractedChars>LIMIT.text||rows.length>=LIMIT.blocks){this.partial=true;this.warn('PDF 본문 추출 한도(200만 자 또는 25,000문단)에 도달해 이후 내용은 제외했습니다.');break pageLoop;}
          rows.push({text:state.lines[j],kind:'paragraph',page:i+1,part:'본문',label:(i+1)+'쪽 · 텍스트 '+(j+1)});
        }
        if(progress)progress((i+1)/pages.length);
        if(i%4===0)await new Promise(resolve=>setTimeout(resolve,0));
      }
      if(this.missingGlyphs){this.partial=true;this.warn('Unicode로 확인하지 못한 문자 코드 '+this.missingGlyphs+'개가 있습니다. 깨진 글자를 AI 작성 특징으로 해석하지 마세요.');}
      if(images){omittedContent.push({kind:'images',count:images});this.warn('PDF의 그림·스캔 영역은 OCR이나 시각 판독을 수행하지 않았습니다. 텍스트 레이어만 추출했으며 그림이 있는 쪽은 원문 확인이 필요합니다.');}
      if(annotations)omittedContent.push({kind:'annotations',count:annotations});
      this.warn('PDF는 그려지는 순서의 텍스트를 읽습니다. 다단 편집, 표, 수식, 숨은 OCR 텍스트는 원문 화면과 다를 수 있습니다.');
      const metadata={metadataEntries:[]};const info=this.resolve(this.info)||{};for(const key of ['Creator','Producer','Author','Title','CreationDate','ModDate']){const v=pdfString(info[key]).slice(0,4000);if(v){metadata[key[0].toLowerCase()+key.slice(1)]=v;metadata.metadataEntries.push({key,value:v,source:'PDF Info dictionary',verified:false});}}
      if(catalog&&catalog.Metadata){
        try{
          const data=await this.stream(this.object(catalog.Metadata));
          if(data.length>1024*1024)throw new Error('XMP 크기 한도 초과');
          const xmp=parseXML(data,'PDF XMP');
          for(const [tag,key] of [['CreatorTool','xmpCreatorTool'],['Producer','xmpProducer'],['CreateDate','xmpCreateDate'],['ModifyDate','xmpModifyDate']]){
            let value=firstText(xmp,tag);
            if(!value){for(const el of elements(xmp,'Description')){for(const attr of Array.from(el.attributes||[])){if(attr.localName===tag)value=attr.value;}}}
            value=String(value||'').trim().slice(0,4000);if(value){metadata[key]=value;metadata.metadataEntries.push({key:tag,value,source:'PDF Catalog /Metadata XMP',verified:false});}
          }
        }catch(e){this.warn('PDF XMP 속성을 완전히 읽지 못했습니다. 본문 추출과 별개이며 전자서명·출처 진위를 검증하지 않았습니다.');}
      }
      return resultOf('PDF',rows,metadata,this.warnings,{status:this.partial?'partial':'good',pages:expected,parsedPages,images,missingGlyphs:this.missingGlyphs,coverage:expected?Math.round(parsedPages/expected*100):0,coverageMeaning:'pages-with-text-not-reading-accuracy',pageProvenance:this.pageOrderVerified?'physical':'recovered',pageOrderVerified:this.pageOrderVerified,pageDetails,unreadablePages,pagesWithImages,visualReviewRequired:Boolean(this.partial||omittedContent.length),omittedContent});
    }
  }

  function parseCMap(source){
    const map=new Map();
    function set(key,value){if(map.size>=LIMIT.cmap)throw new Error('Unicode 매핑 한도 초과');if(key&&value)map.set(key.toUpperCase(),utf16BE(hexBytes(value)));}
    for(const match of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))for(const pair of match[1].matchAll(/<([0-9a-f\s]+)>\s*<([0-9a-f\s]+)>/gi))set(pair[1].replace(/\s/g,''),pair[2].replace(/\s/g,''));
    for(const match of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)){
      const re=/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<([0-9a-f]+)>|\[([^\]]*)\])/gi;let m;
      while((m=re.exec(match[1]))){const start=parseInt(m[1],16),end=parseInt(m[2],16);if(end<start||end-start>65535)throw new Error('Unicode 범위가 잘못되었거나 너무 큽니다.');
        if(m[5]!==undefined){const values=Array.from(m[5].matchAll(/<([0-9a-f\s]+)>/gi),x=>x[1].replace(/\s/g,''));for(let i=start;i<=end&&i-start<values.length;i++)set(i.toString(16).padStart(m[1].length,'0'),values[i-start]);}
        else{const base=BigInt('0x'+m[4]);for(let i=start;i<=end;i++)set(i.toString(16).padStart(m[1].length,'0'),(base+BigInt(i-start)).toString(16).padStart(m[4].length,'0'));}
      }
    }
    return map;
  }
  const GLYPHS={space:' ',exclam:'!',quotedbl:'"',numbersign:'#',dollar:'$',percent:'%',ampersand:'&',quotesingle:"'",quoteright:'’',quoteleft:'‘',parenleft:'(',parenright:')',asterisk:'*',plus:'+',comma:',',hyphen:'-',period:'.',slash:'/',colon:':',semicolon:';',less:'<',equal:'=',greater:'>',question:'?',at:'@',bracketleft:'[',backslash:'\\',bracketright:']',asciicircum:'^',underscore:'_',grave:'`',braceleft:'{',bar:'|',braceright:'}',asciitilde:'~',zero:'0',one:'1',two:'2',three:'3',four:'4',five:'5',six:'6',seven:'7',eight:'8',nine:'9',endash:'–',emdash:'—',bullet:'•',ellipsis:'…',quotedblleft:'“',quotedblright:'”',minus:'−',multiply:'×',divide:'÷',degree:'°',mu:'μ',alpha:'α',beta:'β',gamma:'γ',Delta:'Δ',Omega:'Ω',pi:'π',fi:'fi',fl:'fl',ff:'ff',ffi:'ffi',ffl:'ffl',Euro:'€',copyright:'©',registered:'®',trademark:'™',plusminus:'±'};
  function glyphName(name){name=name.split('.')[0];if(name.length===1)return name;if(GLYPHS[name])return GLYPHS[name];if(/^uni(?:[A-Fa-f0-9]{4})+$/.test(name))return utf16BE(hexBytes(name.slice(3)));if(/^u[A-Fa-f0-9]{4,6}$/.test(name)){const cp=parseInt(name.slice(1),16);if(cp<=0x10ffff)return String.fromCodePoint(cp);}if(name.includes('_'))return name.split('_').map(glyphName).join('');return '';}
  const STANDARD={161:'¡',162:'¢',163:'£',164:'⁄',165:'¥',166:'ƒ',167:'§',168:'¤',169:"'",170:'“',171:'«',172:'‹',173:'›',174:'fi',175:'fl',177:'–',178:'†',179:'‡',180:'·',182:'¶',183:'•',184:'‚',185:'„',186:'”',187:'»',188:'…',189:'‰',191:'¿',193:'`',194:'´',195:'ˆ',196:'˜',197:'¯',198:'˘',199:'˙',200:'¨',202:'˚',203:'¸',205:'˝',206:'˛',207:'ˇ',208:'—',225:'Æ',227:'ª',232:'Ł',233:'Ø',234:'Œ',235:'º',241:'æ',245:'ı',248:'ł',249:'ø',250:'œ',251:'ß'};

  async function parse(file,options){
    options=options||{};if(!file||typeof file.arrayBuffer!=='function')fail('읽을 파일을 선택해 주세요.');
    const checkAbort=()=>{if(options.signal&&options.signal.aborted)throw new DOMException('문서 읽기를 중지했습니다.','AbortError');};
    checkAbort();
    if(file.size>LIMIT.file)fail('파일당 최대 30MiB까지 분석할 수 있습니다. 문서를 나누어 주세요.');
    if(!file.size)fail('비어 있는 파일입니다.');
    const extension=(file.name||'').split('.').pop().toLowerCase();
    if(!['pdf','docx','hwpx','txt','md','markdown','json'].includes(extension))fail('PDF, HWPX, DOCX, TXT, MD, JSON 파일을 지원합니다. HWP·DOC 파일은 원래 프로그램에서 HWPX·DOCX로 변환해 주세요.');
    const bytes=new Uint8Array(await file.arrayBuffer());
    checkAbort();
    if(bytes.length>LIMIT.file)fail('파일 크기가 30MiB를 초과합니다.');
    if((extension==='docx'||extension==='hwpx')&&bytes[0]===0xd0&&bytes[1]===0xcf&&bytes[2]===0x11&&bytes[3]===0xe0)fail('암호화된 Office 문서 또는 이전 바이너리 형식입니다. 암호를 해제하고 DOCX/HWPX로 저장한 사본을 사용하세요.');
    const progress=value=>{checkAbort();if(typeof options.onProgress==='function')options.onProgress(value);};
    progress(0);
    let result;
    if(extension==='pdf')result=await new PDFReader(bytes,checkAbort).extract(progress);
    else if(extension==='docx')result=await parseDocx(bytes,progress,checkAbort);
    else if(extension==='hwpx')result=await parseHwpx(bytes,progress,checkAbort);
    else result=parseMarkdown(bytes,extension==='txt'?'TXT':extension==='json'?'JSON':'MD');
    checkAbort();progress(1);return result;
  }
  root.SpecParsers=Object.freeze({VERSION,LIMIT,parse,decodeTextContent});
})(globalThis);

