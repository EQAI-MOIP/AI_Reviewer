'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const API = require('../js/api.js');
const { createServer } = require('../server.js');
const { once } = require('node:events');
const settings = { connectionMode:'direct', llmBase:'https://api.openai.com/v1', llmKey:'synthetic-fixture-only', model:'fixture-model' };
const response = (data, status=200) => new Response(JSON.stringify(data), {status,headers:{'content-type':'application/json'}});
const completed = data => ({status:'completed',output:[{status:'completed',content:[{type:'output_text',text:JSON.stringify(data)}]}],usage:{input_tokens:80,output_tokens:40}});

test('v3 default generation reserves 32768 output tokens in a 128000 total budget', async () => {
  let generation;
  const r=await API.callLLM(settings,{prompt:'synthetic case',fetcher:async(url,init)=>{
    const body=JSON.parse(init.body);if(url.endsWith('/input_tokens'))return response({input_tokens:94720});
    generation=body;return response(completed({ok:true}));
  }});
  assert.equal(generation.max_output_tokens,32768);assert.equal(generation.store,false);assert.equal(generation.truncation,'disabled');
  assert.equal(r.budget.maxTokens,128000);assert.equal(r.budget.outputTokens,32768);
});

test('v3 never silently reduces an invalid output reservation',async()=>{
  let calls=0;
  await assert.rejects(API.callLLM({...settings,maxTokens:8192,outputTokens:32768},{fetcher:async()=>{calls++;return response({});}}),{code:'TOKEN_SETTINGS'});
  assert.equal(calls,0);
});

test('Responses token truncation preserves reason and usage while refusing partial JSON',async()=>{
  await assert.rejects(API.callLLM(settings,{prompt:'fixture',fetcher:async url=>response(url.endsWith('/input_tokens')?{input_tokens:123}:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{content:[{type:'output_text',text:'{"partial":true}'}]}],usage:{input_tokens:123,output_tokens:32768}})}),e=>{
    assert.equal(e.code,'LLM_TRUNCATED');assert.equal(e.details.reason,'max_output_tokens');assert.equal(e.details.requestedOutputTokens,32768);assert.equal(e.details.usage.output_tokens,32768);return true;
  });
});

test('other incomplete responses are not misreported as recoverable output truncation',async()=>{
  await assert.rejects(API.callLLM(settings,{fetcher:async url=>response(url.endsWith('/input_tokens')?{input_tokens:12}:{status:'incomplete',incomplete_details:{reason:'content_filter'},output:[]})}),{code:'LLM_INCOMPLETE'});
});

test('unread HTTP failure body is cancelled and never exposed as an error message',async()=>{
  let cancelled=false;
  const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('private-untrusted-error'));},cancel(){cancelled=true;}});
  await assert.rejects(API.callLLM(settings,{fetcher:async()=>new Response(body,{status:429})}),e=>e.code==='HTTP_429'&&!e.message.includes('private-untrusted-error'));
  assert.equal(cancelled,true);
});

test('explicit PDF capability test sends a valid synthetic PDF and verifies actual marker',async()=>{
  const calls=[];
  const r=await API.testGeneration(settings,{pdf:true,fetcher:async(url,init)=>{
    const data=JSON.parse(init.body);calls.push(data);
    return response(url.endsWith('/input_tokens')?{input_tokens:300}:completed({marker:'QURI PDF CHECK 314159'}));
  }});
  assert.equal(r.connected,true);assert.equal(r.kind,'pdf');assert.equal(calls.length,2);
  const file=calls[1].input[0].content[1];const pdf=Buffer.from(file.file_data.split(',')[1],'base64').toString('ascii');
  assert.match(pdf,/^%PDF-1\.4/);assert.match(pdf,/QURI PDF CHECK 314159/);
  const offset=Number(pdf.match(/startxref\n(\d+)/)[1]);assert.equal(pdf.slice(offset,offset+4),'xref');
  assert.equal(calls[1].store,false);assert(!pdf.includes(settings.llmKey));
});

test('capability checks reject a hallucinated marker and block PDF in Chat before transmission',async()=>{
  await assert.rejects(API.testGeneration(settings,{fetcher:async url=>response(url.endsWith('/input_tokens')?{input_tokens:12}:completed({marker:'wrong'}))}),{code:'CAPABILITY_CHECK'});
  let calls=0;
  await assert.rejects(API.testGeneration({...settings,apiMode:'chat'},{pdf:true,fetcher:async()=>{calls++;return response({});}}),{code:'PDF_MODE'});
  assert.equal(calls,0);
});

test('local relay advertises v3, keeps missing assets 404, and rejects invalid timeout settings',async t=>{
  let remoteCalls=0;const server=createServer({requestRemote:async()=>{remoteCalls++;return{status:200,bytes:Buffer.from('{}')};}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const base='http://127.0.0.1:'+server.address().port;
  const session=await(await fetch(base+'/api/session')).json();assert.equal(session.version,'3.0.0');
  const missing=await fetch(base+'/never-existing.js');assert.equal(missing.status,404);
  const r=await fetch(base+'/api/llm',{method:'POST',headers:{'content-type':'application/json','x-review-token':session.token},body:JSON.stringify({url:'https://api.openai.com/v1/responses',kind:'responses',key:'',payload:{model:'fixture'},timeoutMs:900001})});
  assert.equal(r.status,400);assert.equal(remoteCalls,0);
});
