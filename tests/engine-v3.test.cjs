'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const E=require('../js/engine.js');
const API=require('../js/api.js');
const Rules=require('../js/rules-data.js');
const app='1020260000001';
const settings={...API.defaults,model:'fixture-model',llmKey:'fixture-only',kiprisKey:'',maxTokens:128000,outputTokens:32768,pdfInput:false,tokenCounting:'estimated'};
const document=(id,type,text,extra={})=>({id,type,title:id,date:'20260401',documentNumber:id,applicationNumber:app,filename:id+'.txt',text,pages:[{page:1,text}],pageCount:1,source:'manual',identityVerified:true,reviewerIdentityConfirmed:true,extraction:{source:'local',complete:true,status:'good',visualPending:false,warnings:[]},retention:'retain',...extra});
function fullCase(){const c=E.createCase(app);c.documents=[document('gazette','registration-gazette','등록특허공보\n청구범위\n청구항 1\n성분 A를 포함하는 조성물.')];c.isRegistered=true;c.completeness.history=true;c.reviewConfirmations={historyComplete:true,registeredClaimsVerified:true,lawVersionVerified:true,citationsComplete:true};return c;}
const ruleIds=prompt=>[...prompt.matchAll(/^## ((?:OA|RD|RC)-\d{2}) /gm)].map(x=>x[1]);
function response(prompt){const claims=JSON.parse((prompt.match(/"expectedClaimNumbers":(\[[^\]]*\])/)||[])[1]||'[]');return {checks:ruleIds(prompt).map(ruleId=>({ruleId,result:'none',reason:'합성 원문과 규칙의 검토 범위입니다.',missing:[],checkedClaims:claims})),findings:[],missingSources:[],scopeComplete:true};}
const error=(code,message='합성 오류')=>Object.assign(new Error(message),{code});
const modelResponse=json=>({json,usage:{input_tokens:10,output_tokens:6,output_tokens_details:{reasoning_tokens:4}}});
function finding(){return {ruleId:'RC-07',code:'0511',title:'합성 반려 후보',verdict:'confirmed',claims:[1],summary:'합성 첫 단계에서 제시된 판단입니다.',evidence:[{documentId:'gazette',page:1,quote:'성분 A를 포함하는 조성물.'}],alternative:'문맥에 따라 해석이 가능합니다.',missing:[]};}
function withCandidate(prompt){const j=response(prompt);if(j.checks.some(x=>x.ruleId==='RC-07')){j.checks.find(x=>x.ruleId==='RC-07').result='finding';j.findings=[finding()];}return j;}
const audit=(judgment='supported',quote='성분 A를 포함하는 조성물.')=>({audits:[{candidateId:'candidate-0',judgment,reason:'원문에 해석상 반론이 존재하는지 별도로 대조했습니다.',alternative:'용어의 정의와 적용 판본을 함께 확인합니다.',evidence:[{documentId:'gazette',page:1,quote}],missing:[]}]});

test('v3 limits every first review batch to three rules and recovers truncated groups',async()=>{
  const c=fullCase(),sizes=[];await E.review(c,settings,{callLLM:async(s,o)=>{const n=ruleIds(o.prompt).length;sizes.push(n);if(n>1)throw error('LLM_TRUNCATED');return modelResponse(response(o.prompt));}});
  assert(Math.max(...sizes)<=3);assert(sizes.some(n=>n>1));assert.equal(c.coverage.length,7);assert(c.coverage.every(x=>x.complete));assert.equal(c.status,'clear');assert(c.runMetrics.failed>0);assert.equal(c.runMetrics.completed,7);assert.equal(c.runMetrics.outputTokens,42);assert.equal(c.runMetrics.reasoningTokens,28);assert(c.ledger.some(x=>x.stage==='규칙 분할'));
});

test('one truncated rule remains pending while sibling and later rules still run',async()=>{
  const c=fullCase();await E.review(c,settings,{callLLM:async(s,o)=>{if(ruleIds(o.prompt).includes('RC-01'))throw error('LLM_TRUNCATED');return modelResponse(response(o.prompt));}});
  assert.equal(c.coverage.find(x=>x.ruleId==='RC-01').complete,false);for(const id of ['RC-02','RC-03','RC-04','RC-05','RC-06','RC-07'])assert.equal(c.coverage.find(x=>x.ruleId===id).complete,true,id);assert.equal(c.status,'hold');assert.equal(c.failures.filter(x=>x.code==='LLM_TRUNCATED').length,1);
});

test('declared scopeComplete cannot hide an explicit missing original request',async()=>{
  const c=fullCase();await E.review(c,settings,{callLLM:async(s,o)=>{const j=response(o.prompt);j.missingSources=[{type:'description',identifier:'보정 후 발명의 설명',documentId:'gazette',reason:'해당 시점의 정의 문언을 확보하지 못했습니다.'}];return modelResponse(j);}});
  assert.equal(c.completeness.rules,false);assert(c.coverage.every(x=>!x.complete&&!x.sourceComplete));assert.equal(c.status,'hold');assert.equal(c.missingSources.length,1);
});

test('explicit per-rule claim omissions prevent an otherwise complete packet from clearing',async()=>{
  const c=fullCase();await E.review(c,settings,{callLLM:async(s,o)=>{const j=response(o.prompt);j.checks.forEach(x=>{x.checkedClaims=[];});return modelResponse(j);}});assert.equal(c.status,'hold');assert(c.coverage.every(x=>x.invalid&&x.missing.some(y=>y.includes('청구항 번호'))));
});

test('a claimed confirmed finding is subjected to a separate evidenced counterargument pass',async()=>{
  const c=fullCase();let audits=0;await E.review(c,settings,{callLLM:async(s,o)=>{if(o.prompt.startsWith('이미 제안된 반려 후보')){audits++;assert(o.prompt.includes('원문 데이터:'));assert(o.prompt.includes('성분 A를 포함하는 조성물.'));return modelResponse(audit());}return modelResponse(withCandidate(o.prompt));}});
  assert.equal(audits,1);const f=c.findings.find(x=>x.ruleId==='RC-07');assert(f);assert.equal(f.secondPass.status,'supported');assert.equal(f.code,null,'second model agreement cannot replace missing manual legal proof');assert.equal(f.verdict,'conditional');assert.match(E.makeReport(c),/반론 재검토: supported/);
});

test('a counterargument disagreement preserves the original candidate and evidence as conditional',async()=>{
  const c=fullCase();await E.review(c,settings,{callLLM:async(s,o)=>modelResponse(o.prompt.startsWith('이미 제안된 반려 후보')?audit('disputed'):withCandidate(o.prompt))});const f=c.findings.find(x=>x.ruleId==='RC-07');assert.equal(f.verdict,'conditional');assert.equal(f.code,null);assert.equal(f.codeCandidate,'0511');assert.equal(f.evidence[0].quote,finding().evidence[0].quote);assert.equal(f.secondPass.status,'disputed');assert(f.missing.some(x=>x.includes('의견 불일치')));assert.equal(c.status,'hold');
});

test('a hallucinated quote in the second pass cannot support the initial finding',async()=>{
  const c=fullCase();await E.review(c,settings,{callLLM:async(s,o)=>modelResponse(o.prompt.startsWith('이미 제안된 반려 후보')?audit('supported','원문에 존재하지 않는 다른 문장'):withCandidate(o.prompt))});assert(c.failures.some(x=>x.code==='AUDIT_EVIDENCE'));const f=c.findings.find(x=>x.ruleId==='RC-07');assert.equal(f.secondPass.status,'incomplete');assert.equal(f.code,null);assert.equal(c.status,'hold');
});

test('request cap stops new network calls and exposes every skipped rule',async()=>{
  const c=fullCase();let calls=0;await E.review(c,{...settings,maxModelCalls:2},{callLLM:async(s,o)=>{calls++;return modelResponse(response(o.prompt));}});assert.equal(calls,2);assert.equal(c.runMetrics.attempted,2);assert.equal(c.coverage.length,7);assert.equal(c.coverage.find(x=>x.ruleId==='RC-07').mode,'failed');assert(c.failures.some(x=>x.code==='CALL_LIMIT'));assert.equal(c.status,'hold');
});

function scanCase(){const c=E.createCase(app);c.documents=[document('scan','office-action','local page 1',{filename:'scan.pdf',bytes:Uint8Array.from(Buffer.from('%PDF-1.4\nfixture')),verifiedPdf:true,pageCount:4,pages:[1,2,3,4].map(page=>({page,text:'local page '+page})),extraction:{source:'local',status:'partial',complete:false,visualPending:true,pageProvenance:'physical',pageOrderVerified:true},identityVerified:false,reviewerIdentityConfirmed:false})];return c;}
function transcriptPages(prompt){return prompt.match(/실제 쪽 번호 ([0-9, ]+)쪽만/)[1].split(',').map(Number);}

test('PDF transcription uses adaptive page windows and keeps visual verification pending',async()=>{
  const c=scanCase(),windows=[];await E.prepareCase(c,{...settings,pdfInput:true},{callLLM:async(s,o)=>{assert.equal(o.maxOutputTokens,32768);const pages=transcriptPages(o.prompt);windows.push(pages);if(pages.length>1)throw error('LLM_TRUNCATED');return modelResponse({pageCount:4,pages:pages.map(page=>({page,text:'전사한 원문 '+page+'쪽',complete:true,uncertain:[]}))});}});
  assert(windows.some(x=>x.length===2));assert.equal(c.documents[0].pages.length,4);assert.equal(c.documents[0].extraction.complete,true);assert.equal(c.documents[0].extraction.visualPending,true);assert.equal(c.documents[0].identityVerified,false);assert.equal(c.documents[0].extraction.transcribedPages,4);
});

test('one failed PDF page preserves local text and cannot be checkbox-promoted',async()=>{
  const c=scanCase();await E.prepareCase(c,{...settings,pdfInput:true},{callLLM:async(s,o)=>{const pages=transcriptPages(o.prompt);if(pages.includes(1))throw error('LLM_TRUNCATED');return modelResponse({pageCount:4,pages:pages.map(page=>({page,text:'전사한 원문 '+page+'쪽',complete:true,uncertain:[]}))});}});
  const d=c.documents[0];assert.equal(d.pages[0].text,'local page 1');assert.deepEqual(d.extraction.unreadablePages,[1]);assert.equal(d.extraction.complete,false);assert.throws(()=>E.updateDocument(c,d.id,{completeConfirmed:true}),e=>e.code==='UNREADABLE_PAGES');
});

test('recovered PDF ordering and parser omitted content stay visible and prevent full verification',async()=>{
  const previous=globalThis.SpecParsers;globalThis.SpecParsers={parse:async()=>({text:'검사할 원문',blocks:[{page:1,text:'검사할 원문'}],metadata:{format:'PDF'},quality:{status:'good',pages:1,parsedPages:1,pageProvenance:'recovered',pageOrderVerified:false,visualReviewRequired:true,omittedContent:[{kind:'equations',count:1}],unreadablePages:[]},warnings:['페이지 순서 확인 필요']})};
  try{const bytes=Uint8Array.from(Buffer.from('%PDF-1.4\nfixture'));const d=await E.ingestFile({name:'recovered.pdf',size:bytes.length,arrayBuffer:async()=>bytes.buffer},{applicationNumber:app,identityConfirmed:true,completeConfirmed:true});const c=E.createCase(app);E.addDocument(c,d);assert.equal(d.extraction.complete,false);assert.equal(d.extraction.visualPending,true);assert.equal(d.extraction.omittedContent[0].kind,'equations');assert.throws(()=>E.updateDocument(c,d.id,{completeConfirmed:true}),e=>e.code==='PAGE_PROVENANCE');const saved=JSON.parse(E.serializeCase(c));assert.equal(saved.documents[0].extraction.originalPageProvenance,'recovered');assert.match(E.makeReport(c),/페이지 순서 확인 필요/);}finally{globalThis.SpecParsers=previous;}
});

test('raw byte limits prevent a new file from exceeding a case memory budget',()=>{
  const c=E.createCase(app);c.documents=[document('existing','other','기존 자료',{byteLength:E.LIMIT.totalBytes-10})];assert.throws(()=>E.addDocument(c,document('new','other','새 자료',{byteLength:11})),e=>e.code==='CASE_SIZE');assert.equal(c.documents.length,1);assert.equal(E.LIMIT.totalBytes,180*1024*1024);
});

test('version 3 exports execution counts and counterargument records without request payloads',async()=>{
  const c=fullCase();await E.review(c,settings,{callLLM:async(s,o)=>modelResponse(o.prompt.startsWith('이미 제안된 반려 후보')?audit('disputed'):withCandidate(o.prompt))});const saved=JSON.parse(E.serializeCase(c));assert.equal(saved.appVersion,'3.0.0');assert.equal(saved.runMetrics.attempted,4);assert.equal(saved.findings[0].secondPass.status,'disputed');assert(!JSON.stringify(saved).includes('fixture-only'));assert.match(E.makeReport(c),/실행량과 출력 범위/);
});

test('omitted checkedClaims cannot yield all-clear even when every check claims none',async()=>{
  const c=fullCase(),sizes=[];await E.review(c,settings,{callLLM:async(s,o)=>{const j=response(o.prompt);sizes.push(j.checks.length);j.checks.forEach(x=>{delete x.checkedClaims;});return modelResponse(j);}});
  assert(sizes.includes(3)&&sizes.includes(1),'missing claim coverage is retried in smaller batches');assert.equal(c.status,'hold');assert.equal(c.completeness.rules,false);assert.equal(c.coverage.length,7);assert(c.coverage.every(x=>!x.complete&&x.result==='unverifiable'));assert(c.failures.some(x=>x.code==='CLAIM_COVERAGE'));
});

test('a finding from an incomplete claim check cannot be promoted by a supported second pass',async()=>{
  const c=E.createCase(app),text='의견제출통지서\n주문 제29조제2항\n이유 제42조제4항제2호';c.documents=[document('oa','office-action',text)];c.claimVersions=[{id:'v1',date:'20260301',source:'claims-api',complete:true,historyMatched:true,verifiedAgainstNotice:true,claims:[{number:1,text:'성분 A를 포함하는 조성물.'}]}];c.history=[{type:'office-action',date:'20260401',documentId:'oa'}];c.reviewConfirmations={historyComplete:true,lawVersionVerified:true};let audits=0;
  await E.review(c,settings,{callLLM:async(s,o)=>{if(o.prompt.startsWith('이미 제안된')){audits++;return modelResponse({audits:[{candidateId:'candidate-0',judgment:'supported',reason:'원문 법조문의 불일치를 대조했습니다.',evidence:[{documentId:'oa',page:1,quote:'주문 제29조제2항'}],missing:[]}]});}const j=response(o.prompt);if(j.checks.some(x=>x.ruleId==='OA-02')){const check=j.checks.find(x=>x.ruleId==='OA-02');check.result='finding';check.checkedClaims=[];j.findings=[{ruleId:'OA-02',code:'1221',title:'법조문 대조 후보',verdict:'confirmed',claims:[1],summary:'합성 원문 주문과 이유 법조문의 불일치',evidence:[{documentId:'oa',page:1,quote:'주문 제29조제2항'}],alternative:'정합적 해석을 확인합니다.',missing:[]}];}return modelResponse(j);}});
  const f=c.findings.find(x=>x.ruleId==='OA-02');assert(f);assert.equal(f.verdict,'conditional');assert.equal(f.code,null);assert.equal(f.codeCandidate,'1221');assert(f.missing.some(x=>x.includes('청구항 번호')));assert.equal(audits,0,'already incomplete scope is held before second pass');assert.equal(c.coverage.find(x=>x.ruleId==='OA-02').complete,false);
});

test('ordinary PDF retry reads only failed pages and resolves prior failures without repeating successful pages',async()=>{
  const c=scanCase();await E.prepareCase(c,{...settings,pdfInput:true},{callLLM:async(s,o)=>{const pages=transcriptPages(o.prompt);if(pages.includes(1))throw error('LLM_TRUNCATED');return modelResponse({pageCount:4,pages:pages.map(page=>({page,text:'첫 시도 성공 원문 '+page+'쪽',complete:true,uncertain:[]}))});}});
  const d=c.documents[0];assert.deepEqual(d.extraction.unreadablePages,[1]);const secondWindows=[];await E.prepareCase(c,{...settings,pdfInput:true},{callLLM:async(s,o)=>{const pages=transcriptPages(o.prompt);secondWindows.push(pages);return modelResponse({pageCount:4,pages:pages.map(page=>({page,text:'재시도 성공 원문 '+page+'쪽',complete:true,uncertain:[]}))});}});
  assert.deepEqual(secondWindows,[[1]]);assert.equal(d.extraction.complete,true);assert.deepEqual(d.extraction.unreadablePages,[]);assert.equal(d.pages[1].text,'첫 시도 성공 원문 2쪽');assert.equal(d.localPages[0].text,'local page 1');assert(c.failures.filter(x=>x.stage==='PDF 원문 읽기').every(x=>x.resolved));assert.equal(d.extraction.visualPending,true);
  await E.prepareCase(c,{...settings,pdfInput:true},{callLLM:async()=>{assert.fail('complete transcripts awaiting visual confirmation must not be sent again');}});
});

test('ordinary PDF retry also revisits uncertain transcription while retaining prior complete pages',async()=>{
  const c=scanCase();await E.prepareCase(c,{...settings,pdfInput:true},{callLLM:async(s,o)=>{const pages=transcriptPages(o.prompt);return modelResponse({pageCount:4,pages:pages.map(page=>({page,text:'최초 전사 '+page+'쪽',complete:page!==2,uncertain:page===2?['수식의 아래첨자가 흐립니다.']:[]}))});}});
  assert.deepEqual(c.documents[0].extraction.unreadablePages,[2]);const retried=[];await E.prepareCase(c,{...settings,pdfInput:true},{callLLM:async(s,o)=>{const pages=transcriptPages(o.prompt);retried.push(...pages);return modelResponse({pageCount:4,pages:pages.map(page=>({page,text:'수식까지 다시 확인한 '+page+'쪽',complete:true,uncertain:[]}))});}});
  assert.deepEqual(retried,[2]);assert.equal(c.documents[0].extraction.complete,true);assert.equal(c.documents[0].pages[0].text,'최초 전사 1쪽');assert.equal(c.documents[0].pages[1].text,'수식까지 다시 확인한 2쪽');assert.equal(c.documents[0].extraction.visualPending,true);
});

test('oversized binary export fails before Base64 allocation and leaves current documents intact',()=>{
  const c=E.createCase(app);
  const huge={byteLength:80*1024*1024,length:80*1024*1024,subarray(){throw new Error('must not allocate export');}};
  c.documents=[document('large-export','other','분할 보관할 원문',{bytes:huge,sha256:'a'.repeat(64)})];
  assert.throws(()=>E.serializeCase(c),e=>e.code==='EXPORT_SIZE');
  assert.equal(c.documents.length,1);assert.equal(c.documents[0].bytes,huge);
});
