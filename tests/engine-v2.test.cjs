'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../js/engine.js');
const API = require('../js/api.js');
const R = require('../js/rules-data.js');
const app='1020260000001';
const settings={...API.defaults,model:'fixture-model',llmKey:'fixture',kiprisKey:'',maxTokens:50000,outputTokens:4096,pdfInput:false,tokenCounting:'estimated'};
const file=(name,text)=>{const bytes=Buffer.from(text);return {name,size:bytes.length,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};};
const doc=(id,type,text,extra={})=>({id,type,title:id,date:'20260401',documentNumber:id,applicationNumber:app,filename:id+'.txt',text,pages:[{page:1,text}],pageCount:1,source:'manual',identityVerified:true,reviewerIdentityConfirmed:true,extraction:{source:'local',complete:true,status:'good',visualPending:false,warnings:[]},retention:'retain',...extra});
const version=(id,date,text)=>({id,date,source:'claims-api',complete:true,historyMatched:true,verifiedAgainstNotice:true,claims:[{number:1,text}]});
function response(prompt){const claims=JSON.parse((prompt.match(/"expectedClaimNumbers":(\[[^\]]*\])/)||[])[1]||'[]');const ids=[...prompt.matchAll(/^## ((?:OA|RD|RC)-\d{2}) /gm)].map(m=>m[1]);return {checks:ids.map(ruleId=>({ruleId,result:'none',reason:'합성 검증용 원문의 확인된 범위입니다.',missing:[],checkedClaims:claims})),findings:[],missingSources:[],scopeComplete:true};}
function candidate(evidence,extra={}){return {ruleId:'OA-02',code:'1221',verdict:'confirmed',claims:[1],title:'법조문 대조',summary:'원문 내 법조문 연결을 검토합니다.',evidence,alternative:'',missing:[],...extra};}

test('manual document review accepts no application number and no KIPRIS key',async()=>{
  const c=E.createCase('');c.documents=[await E.ingestFile(file('notice.txt','의견제출통지서\n주문 제29조제2항\n이유 제42조제4항제2호'),{type:'oa',applicationNumber:'',identityConfirmed:true,completeConfirmed:true})];
  let calls=0;await E.review(c,settings,{callLLM:async(s,o)=>{calls++;return {json:response(o.prompt)};}});
  assert(calls>0);assert.equal(c.applicationNumber,'');assert.equal(c.status,'hold');assert(!c.failures.some(x=>/KIPRIS|출원번호/.test(x.message)));
  const restored=await E.importCase(E.serializeCase(c));assert.equal(restored.applicationNumber,'');assert.match(E.makeReport(c),/미입력 · 문서 직접 검토/);assert.equal(JSON.parse(E.serializeCase(c)).appVersion,'3.0.0');
});

test('case-number adoption checks actual first-page labels before changing any state',async()=>{
  const c=E.createCase('');c.documents=[await E.ingestFile(file('notice.txt','의견제출통지서\n출원번호: 10-2026-0000001'),{type:'oa'})];
  assert.throws(()=>E.setApplicationNumber(c,'1020260000002'),/첫 쪽/);assert.equal(c.applicationNumber,'');assert.equal(c.documents[0].applicationNumber,'');
  E.setApplicationNumber(c,app);assert.equal(c.applicationNumber,app);assert.equal(c.documents[0].applicationNumber,app);
  assert.throws(()=>E.setApplicationNumber(c,'1020260000002'),/새 사건/);
});

test('mixed first-page application numbers in an unnamed case cannot establish a complete packet',async()=>{
  const c=E.createCase('');for(const number of [app,'1020260000002'])c.documents.push(await E.ingestFile(file(number+'.txt','의견제출통지서\n출원번호: '+number),{type:'oa',identityConfirmed:true,completeConfirmed:true}));
  E.confirmScope(c,{historyComplete:true});assert.equal(c.applicationConflict,true);assert.equal(c.completeness.documents,false);assert.equal(c.completeness.identity,false);assert(E.summarizeStatus(c).reasons.some(x=>x.includes('서로 다른 출원')));
});

test('removing a source invalidates its versions, prior coverage, and source-dependent decisions',async()=>{
  const c=E.createCase(app),d=await E.ingestFile(file('claims.txt','청구항 1\n성분 A를 포함하는 조성물.'),{applicationNumber:app});c.documents=[d];
  E.updateDocument(c,d.id,{type:'claims',date:'20260101',identityConfirmed:true,completeConfirmed:true,versionConfirmed:true});
  c.coverage=[{complete:true}];c.reviewConfirmations={historyComplete:true};c.findings=[{id:'old',verdict:'confirmed',code:'0511',evidence:[],claims:[1]}];
  assert.equal(E.removeDocument(c,d.id),true);assert.equal(c.claimVersions.length,0);assert.equal(c.coverage.length,0);assert.equal(c.findings[0].verdict,'conditional');assert.equal(c.findings[0].code,null);assert.deepEqual(c.reviewConfirmations,{});
});

test('a reviewer cannot override missing identity or unread source pages at finding level',()=>{
  const c=E.createCase(app);c.documents=[doc('oa','office-action','주문 제29조제2항 / 이유 제42조제4항제2호',{identityVerified:false,reviewerIdentityConfirmed:false,extraction:{source:'local',complete:false,visualPending:true}})];
  const f=E._validateCandidate(c,candidate([{documentId:'oa',page:1,quote:'주문 제29조제2항'}]),{id:'unit-oa',group:'OA',documentId:'oa'});c.findings=[f];
  E.confirmFinding(c,f.id,{documentIdentityVerified:true,sourceReadabilityVerified:true,evidenceScopeVerified:true});assert.equal(f.code,null);assert.equal(f.verificationState.documentIdentityVerified,false);assert.equal(f.verificationState.sourceReadabilityVerified,false);
});

test('real quotations from an unrelated target or future notice cannot confirm the current notice',()=>{
  const c=E.createCase(app);c.documents=[doc('oa','office-action','원래 통지의 기재',{date:'20260101'}),doc('future','office-action','주문 제29조제2항',{date:'20260201'})];
  const f=E._validateCandidate(c,candidate([{documentId:'future',page:1,quote:'주문 제29조제2항'}]),{id:'unit-oa',group:'OA',documentId:'oa',date:'20260101'});
  assert.equal(f.verificationState.sourceEvidenceVerified,true);assert.equal(f.verificationState.evidenceScopeVerified,false);assert.equal(f.code,null);
});

test('missing information cannot coexist with a confirmed code even if the quote exists',()=>{
  const c=E.createCase(app);c.documents=[doc('oa','office-action','주문 제29조제2항')];
  const f=E._validateCandidate(c,candidate([{documentId:'oa',page:1,quote:'주문 제29조제2항'}],{missing:['대응 이유를 확인해야 합니다.']}),{id:'unit-oa',group:'OA',documentId:'oa'});assert.equal(f.verdict,'conditional');assert.equal(f.code,null);
});

test('duplicate same-day versions and explicitly mapped public snapshots are not selected',()=>{
  const c=E.createCase(app);c.claimVersions=[version('a','20260101','A'),version('b','20260101','B')];assert.equal(E.latestVersionBefore(c,{id:'oa',date:'20260201'}),null);
  c.claimVersions=[{...version('pub','20260101','A'),source:'publication',appliesTo:['oa'],orderingConfirmed:true}];assert.equal(E.latestVersionBefore(c,{id:'oa',date:'20260201'}),null);
});

test('invalid calendar dates cannot become a chronology or claim-version basis',async()=>{
  const d=await E.ingestFile(file('claim.txt','청구항 1\n성분 A.'),{type:'claims',date:'20260230'});assert.equal(d.date,'');
  const c=E.createCase('');c.documents=[d];assert.throws(()=>E.updateDocument(c,d.id,{versionConfirmed:true,date:'20261399',identityConfirmed:true,completeConfirmed:true}),/기준일/);
});

test('scope confirmation cannot fabricate complete API or imported claim versions',()=>{
  const c=E.createCase(app);c.claimVersions=[{...version('incomplete','20260101','A'),complete:false,historyMatched:false}];assert.throws(()=>E.confirmScope(c,{claimVersionsVerified:true}),/누락된 판본/);assert.equal(c.claimVersions[0].complete,false);
});

test('a registration header without actual claims cannot establish registered-claim completeness',()=>{
  const c=E.createCase(app);c.documents=[doc('gazette','registration-gazette','등록특허공보\n서지 정보만 수록')];c.reviewConfirmations={historyComplete:true,registeredClaimsVerified:true};E.recomputeCompleteness(c);assert.equal(c.completeness.claims,false);assert.throws(()=>E.confirmScope(c,{registeredClaimsVerified:true}),/실제 청구항/);
});

test('final notice review receives both earlier and current claim-version text',async()=>{
  const c=E.createCase(app);c.documents=[doc('first','office-action','최초 의견제출통지서',{date:'20260201'}),doc('last','final-notice','최후 의견제출통지서',{date:'20260401'})];
  c.history=c.documents.map(d=>({id:'h-'+d.id,type:d.type,date:d.date,documentId:d.id}));c.completeness.history=true;c.claimVersions=[version('before','20260101','보정 전 구성 A'),version('after','20260301','보정 후 구성 B')];
  const requests=[];await E.review(c,settings,{callLLM:async(s,o)=>{requests.push(o.prompt);return {json:response(o.prompt)};}});
  const last=requests.find(p=>p.includes('"documentId":"last"')&&p.includes('"unitId":"unit-last"'));assert(last);assert(last.includes('보정 전 구성 A'));assert(last.includes('보정 후 구성 B'));
});

test('OA-15 code confirmation requires actual cited before-and-after versions',()=>{
  const c=E.createCase(app);c.documents=[doc('first','office-action','최초 통지 원문',{date:'20260201'}),doc('last','final-notice','최후 통지 원문',{date:'20260401'})];c.history=c.documents.map(d=>({type:d.type,date:d.date,documentId:d.id}));c.completeness.history=true;c.claimVersions=[version('before','20260101','보정 전 구성 A'),version('after','20260301','보정 후 구성 B')];
  const unit=E.buildUnits(c).find(u=>u.documentId==='last');const f=E._validateCandidate(c,candidate([{documentId:'last',page:1,quote:'최후 통지 원문'}],{ruleId:'OA-15',code:'1024'}),unit);c.findings=[f];E.confirmFinding(c,f.id,{reasonPredatedAmendment:true,claimVersionsCompared:true});assert.equal(f.code,null);assert.equal(f.verificationState.claimVersionsCompared,false);
  f.evidence.push({documentId:'before',page:'claim-1',quote:'보정 전 구성 A'},{documentId:'after',page:'claim-1',quote:'보정 후 구성 B'});E.confirmFinding(c,f.id,{reasonPredatedAmendment:true});assert.equal(f.code,'1024');
});

test('local registration checks ignore preferred words in superseded claim documents',()=>{
  const c=E.createCase(app);c.documents=[doc('old','claims','청구항 1\nA, 특히 B를 포함하는 조성물.',{date:'20260101'}),doc('final','registration-gazette','청구범위\n청구항 1\nB를 포함하는 조성물.')];E.localReview(c);assert.equal(c.findings.length,0);
});

test('claim relation analysis finds missing/forward references and indirect multiple dependency',()=>{
  const graph=E.analyzeClaimStructure([{number:1,text:'장치.'},{number:2,text:'제1항에 있어서, 부재를 포함하는 장치.'},{number:3,text:'제1항 또는 제2항에 있어서, 센서를 포함하는 장치.'},{number:4,text:'제3항에 있어서, 제어기를 포함하는 장치.'},{number:5,text:'제2항 또는 제4항에 있어서, 기어를 포함하는 장치.'},{number:6,text:'제9항에 있어서, 모터를 포함하는 장치.'}]);
  assert(graph.issues.some(x=>x.ruleId==='RC-02'&&x.claims[0]===5&&x.detail.includes('제5항 → 제4항 → 제3항')));assert(graph.issues.some(x=>x.ruleId==='RC-01'&&x.claims[0]===6));assert(!graph.issues.some(x=>x.ruleId==='RC-02'&&x.claims[0]===3));
  assert.equal(E.analyzeClaimStructure([{number:1,text:'문헌의 제2항을 설명하는 장치.'}]).nodes[0].references.length,0);
});

test('offline structural findings remain conditional and preserve exact source quotation',()=>{
  const c=E.createCase('');const text='청구범위\n청구항 1\n장치.\n청구항 2\n제9항에 있어서, 센서를 포함하는 장치.';c.documents=[doc('g','registration-gazette',text,{applicationNumber:''})];E.localReview(c);const f=c.findings.find(f=>f.ruleId==='RC-01');assert(f);assert.equal(f.verdict,'conditional');assert.equal(f.code,null);assert.equal(f.codeCandidate,'0622');assert(E.evidenceValid(c,f.evidence[0]));assert.match(E.makeReport(c),/등록청구항의 인용관계 보조 분석/);
});

test('manual missing-source requests never call KIPRIS automatically, even with a saved key',async()=>{
  const old=API.collectCitedOriginal;let called=0;API.collectCitedOriginal=async()=>{called++;throw new Error('must not run');};
  try{const c=E.createCase(app);c.documents=[doc('oa','office-action','의견제출통지서 인용발명 1')];await E.review(c,{...settings,kiprisKey:'saved-key'},{callLLM:async(s,o)=>{const j=response(o.prompt);j.scopeComplete=false;j.missingSources=[{type:'citation',identifier:'KR1020260000001A',documentId:'oa',reason:'원문을 확인해야 합니다.'}];return {json:j};}});assert.equal(called,0);assert(c.missingSources.every(x=>!x.attempted));assert.equal(c.status,'hold');}finally{API.collectCitedOriginal=old;}
});

test('contradictory not-applicable findings are rejected and document-code families are enforced',()=>{
  const c=E.createCase(app);c.documents=[doc('r','rejection','거절결정 원문')];const u={id:'unit-r',group:'RD',documentId:'r'};const f=E._validateCandidate(c,candidate([{documentId:'r',page:1,quote:'거절결정 원문'}],{ruleId:'RD-04'}),u);assert.equal(f.code,null);assert(f.codeValidation.errors.some(x=>x.includes('12xx')));
  assert.throws(()=>E._checkResponse(c,{checks:[{ruleId:'RD-04',result:'not_applicable',reason:'해당 없음',missing:[]}],findings:[{...candidate([{documentId:'r',page:1,quote:'거절결정 원문'}]),ruleId:'RD-04'}],missingSources:[],scopeComplete:true},u,[R.byId['RD-04']]),/충돌/);
});

test('adding a document invalidates prior outcome findings and rejects a different primary application',()=>{
  const c=E.createCase(app);c.findings=[{id:'old',verdict:'confirmed',code:'0521',claims:[1],evidence:[]}];c.coverage=[{complete:true}];c.reviewConfirmations={historyComplete:true,citationsComplete:true};
  E.addDocument(c,doc('oa','office-action','의견제출통지서'));assert.equal(c.coverage.length,0);assert.equal(c.findings[0].code,null);assert.equal(c.findings[0].verdict,'conditional');assert.deepEqual(c.reviewConfirmations,{});
  assert.throws(()=>E.addDocument(c,doc('wrong','office-action','의견제출통지서',{applicationNumber:'1020260000002'})),/다른 출원/);assert.equal(c.documents.length,1);
  assert.throws(()=>E.addDocument(c,doc('oa','office-action','다른 내용')),/같은 문서/);
});

test('suggested metadata cannot verify itself until the actual metadata is reviewed',async()=>{
  const text='의견제출통지서\n출원번호: 10-2026-0000001\n발송일자: 2026년 4월 1일\n발송번호: 12345678';
  const d=await E.ingestFile(file('notice.txt',text),{type:'oa',applicationNumber:app,date:'20260401',documentNumber:'12345678',metadataSuggested:true});assert.equal(d.identityVerified,false);
  const c=E.createCase(app);E.addDocument(c,d);E.updateDocument(c,d.id,{type:'office-action',date:'20260401',documentNumber:'12345678'});assert.equal(d.identityVerified,false);
  E.updateDocument(c,d.id,{metadataConfirmed:true});assert.equal(d.metadataSuggested,false);assert.equal(d.identityVerified,true);
});

test('reviewer exclusion is reasoned, auditable, and does not complete unreviewed rules',async()=>{
  const c=E.createCase(''),text='청구범위\n청구항 1\nA, 특히 B를 포함하는 조성물.';c.documents=[doc('g','registration-gazette',text,{applicationNumber:''})];E.localReview(c);const f=c.findings[0],originalEvidence=JSON.stringify(f.evidence);
  assert.throws(()=>E.excludeFinding(c,f.id,'아님'),/10~2,000/);E.excludeFinding(c,f.id,'원문과 정의를 대조하였고 해당 표현이 별개의 보호범위를 만들지 않음을 확인했습니다.');
  assert.equal(f.verdict,'excluded');assert.equal(f.code,null);assert.equal(f.codeCandidate,'0511');assert.equal(JSON.stringify(f.evidence),originalEvidence);assert.equal(E.summarizeStatus(c).excluded,1);assert.equal(c.completeness.rules,false);assert.equal(c.status,'hold');
  assert.match(E.makeReport(c),/검토자 제외 이력/);const out=JSON.parse(E.serializeCase(c));assert.equal(out.adjudications.length,1);assert.equal(out.findings[0].reviewerExclusion.reason,f.reviewerExclusion.reason);
  const restored=await E.importCase(JSON.stringify(out));assert.equal(restored.findings[0].verdict,'conditional');assert.equal(restored.adjudications[0].historical,true);
  f.verdict='confirmed';assert.throws(()=>E.excludeFinding(c,f.id,'확정된 항목도 제외하려는 시도입니다.'),/확정 항목/);
});

test('exclusion export still omits unretained registration-decision original quotes',()=>{
  const c=E.createCase(app);c.documents=[doc('grant','registration-decision','PRIVATE GRANT ORIGINAL',{officialCorrection:'no'})];c.findings=[{id:'f',ruleId:'RD-06',title:'검토 항목',verdict:'conditional',codeCandidate:'1321',claims:[1],summary:'판단',evidence:[{documentId:'grant',page:1,quote:'PRIVATE GRANT ORIGINAL'}],alternative:'',missing:[]}];
  E.excludeFinding(c,'f','이 항목은 확인한 해당 문서의 검토 범위에 포함되지 않는 것으로 판단했습니다.');assert(!E.serializeCase(c).includes('PRIVATE GRANT ORIGINAL'));
});

test('native document synthetic pages remain nonphysical through confirmation, export, import, and reparse',async()=>{
  const original=globalThis.SpecParsers;const text='의견제출통지서\n출원번호: 10-2026-0000001\n주문 제29조제2항\n이유 제42조제4항제2호';
  globalThis.SpecParsers={parse:async()=>({text,blocks:[{page:1,text}],metadata:{format:'HWPX'},quality:{status:'good',pages:1,parsedPages:1},warnings:[]})};
  try{
    const c=E.createCase(app),d=await E.ingestFile(file('notice.hwpx','synthetic fixture archive bytes'),{type:'oa',applicationNumber:app,identityConfirmed:true,completeConfirmed:true});E.addDocument(c,d);
    assert.equal(d.extraction.syntheticPages,true);assert.equal(d.extraction.complete,false);assert.throws(()=>E.updateDocument(c,d.id,{completeConfirmed:true}),e=>e.code==='PAGE_PROVENANCE');
    const f=E._validateCandidate(c,candidate([{documentId:d.id,page:1,quote:'주문 제29조제2항'}]),{id:'unit-'+d.id,group:'OA',documentId:d.id});c.findings=[f];assert.equal(f.code,null);assert.equal(f.verificationState.sourceReadabilityVerified,false);
    const report=E.makeReport(c);assert.match(report,/전체 본문 · 원문 쪽 위치 미확정/);assert(!report.includes(d.id+' · 1쪽'));
    const saved=JSON.parse(E.serializeCase(c));assert.equal(saved.documents[0].extraction.syntheticPages,true);assert.equal(saved.documents[0].extraction.format,'HWPX');
    const imported=await E.importCase(JSON.stringify(saved));assert.equal(imported.documents[0].extraction.syntheticPages,true);assert.throws(()=>E.updateDocument(imported,d.id,{identityConfirmed:true,completeConfirmed:true}),e=>e.code==='PAGE_PROVENANCE');
    await E.prepareCase(imported,settings);assert.equal(imported.documents[0].extraction.syntheticPages,true);assert.equal(imported.documents[0].extraction.complete,false);
    const legacy=JSON.parse(E.serializeCase(c));delete legacy.documents[0].extraction.syntheticPages;delete legacy.documents[0].extraction.pageProvenance;delete legacy.documents[0].extraction.format;const legacyImport=await E.importCase(JSON.stringify(legacy));assert.equal(legacyImport.documents[0].extraction.syntheticPages,true);
  }finally{globalThis.SpecParsers=original;}
});
