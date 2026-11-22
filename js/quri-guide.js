/* AI 심사팀장 큐리 v3.0.0 — local, accessible guided tour and real sprite frames. */
(function (root) {
  'use strict';
  if (!root.document) return;
  const doc = root.document;
  const byId = id => doc.getElementById(id);
  const states = new Set(['welcome','reading','upload','input','complete','hold']);
  let activeState = 'welcome', busy = false, startedAt = 0, ticker = null, lastCase;
  let progressMessage = '원문과 근거를 차례로 확인하고 있어요.';
  let panel, launcher, waiting, waitingText, elapsed, target, lastFocus, tourIndex = -1;
  let intersections, observer, queued = false;
  const spriteNodes = new Set();
  const captions = {
    welcome:'심사관님을 반갑게 맞이하는 큐리',
    reading:'문서를 한 장씩 확인하며 기다리는 큐리',
    upload:'문서를 넣는 위치를 알려 주는 큐리',
    input:'출원번호 입력 위치를 알려 주는 큐리',
    complete:'확인한 내용을 정리해 안내하는 큐리',
    hold:'추가로 확인할 원문을 살피는 큐리'
  };
  const steps = [
    {view:'review',mode:'manual',selector:'.input-mode-tabs',pose:'welcome',title:'심사관님, 편한 방법으로 시작해요.',message:'내 문서를 올리거나, KIPRIS Plus에 출원번호를 입력해 자료를 가져올 수 있어요.',tip:'문서를 올리는 것만으로 외부 API에 전송되지는 않습니다.'},
    {view:'review',mode:'manual',selector:'#home-drop-zone',pose:'upload',title:'문서는 바로 여기에 넣어 주세요.',message:'PDF·HWPX·DOCX 등을 끌어 놓거나 파일 선택을 누르세요. 여러 문서를 함께 올릴 수 있어요.',tip:'스캔·수식·도면처럼 읽기 어려운 부분은 원문과 대조해 주세요.'},
    {view:'review',mode:'live',selector:'#application-number',pose:'input',title:'출원번호는 이 칸에 입력해요.',message:'13자리 번호를 입력해 주세요. 하이픈이 있어도 괜찮아요. 조회에는 KIPRIS Plus 연결이 필요합니다.',tip:'예: 10-2023-0106975 · API 설정은 왼쪽 설정에서 할 수 있어요.'},
    {view:'documents',selector:'#preparation-title',pose:'upload',title:'진단 전에 서류의 시점을 확인해요.',message:'문서 종류·발송일과 판독 상태를 확인하고, 통지 당시 청구항과 인용문헌 원문을 함께 준비해 주세요.',tip:'공개공보·등록청구항을 과거 통지 당시 판본으로 대신할 수는 없어요.'},
    {view:'documents',selector:'#review-documents',pose:'reading',title:'준비가 되면 큐리에게 진단을 맡겨요.',message:'LLM 연결 후 진단받기를 실행합니다. 진행 상황과 현재 검토하는 문서를 화면에서 알려드릴게요.',tip:'모션은 기다리는 동안의 안내입니다. 진단 완료 여부는 화면의 상태와 검토 범위로 확인해 주세요.'},
    {view:'results',selector:'#result-hero',pose:'complete',title:'결과와 근거를 함께 확인해요.',message:'반려 검토사항, 추가로 필요한 자료, 적용한 규칙과 근거를 살펴보세요. 필요한 결과는 보고서·사건 저장으로 보관해 주세요.',tip:'새 사건을 시작하면 이전 사건의 앱 내부 임시 자료를 정리합니다. 내보낸 파일은 PC에 남아요.'}
  ];
  function node(tag, cls, text) { const el=doc.createElement(tag); if(cls)el.className=cls; if(text!==undefined)el.textContent=text; return el; }
  function animationAllowed() { return !doc.hidden && !doc.body.classList.contains('reduce-motion') && !(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  function setSprite(el, pose, decorative) {
    if (!el) return;
    el.dataset.quriMotion = states.has(pose) ? pose : 'welcome';
    if (!decorative && el.getAttribute('aria-hidden')!=='true') el.setAttribute('aria-label', captions[pose] || captions.welcome);
    if(!spriteNodes.has(el)) { spriteNodes.add(el); if(intersections)intersections.observe(el); }
    el.dataset.quriPlay = String(animationAllowed() && el.dataset.quriVisible!=='false' && pose!=='hold');
  }
  function elapsedLabel(ms) { const sec=Math.floor(ms/1000),min=Math.floor(sec/60);return min+'분 '+String(sec%60).padStart(2,'0')+'초'; }
  function updateElapsed() { if(elapsed)elapsed.textContent='경과 '+elapsedLabel(startedAt ? Date.now()-startedAt : 0); }
  function syncActivity(nextBusy) {
    if(nextBusy&&!busy) { startedAt=Date.now();progressMessage='원문과 근거를 차례로 확인하고 있어요.';if(!ticker&&!doc.hidden)ticker=root.setInterval(updateElapsed,1000); }
    if(!nextBusy&&busy) { root.clearInterval(ticker);ticker=null;startedAt=0; }
    busy=nextBusy;
    if(waiting)waiting.hidden=!busy;
    updateElapsed();
  }
  function idleState(c) { return c&&c.status==='clear'?'complete':c&&c.documents&&c.documents.length?'hold':'welcome'; }
  function setState(value, options) {
    if(!states.has(value))return;
    activeState=value;
    syncActivity(value==='reading');
    if(options&&typeof options.message==='string')progressMessage=options.message.slice(0,240);
    if(waitingText)waitingText.textContent=progressMessage;
    refresh();
  }
  function refresh() {
    const app=root.ReviewApp,c=app&&app.getCase?app.getCase():null;
    // The controller is authoritative. A navigation event must not clear an active
    // review animation or leave a stale waiting animation after the job stopped.
    if(app&&typeof app.isBusy==='function') {
      const actual=Boolean(app.isBusy());
      if(actual) { syncActivity(true);activeState='reading'; }
      else if(busy||activeState==='reading') { syncActivity(false);activeState=idleState(c); }
    }
    if(c!==lastCase) { if(!busy)activeState=idleState(c);lastCase=c; }
    const resultState=c&&c.status==='clear'?'complete':'hold';
    setSprite(byId('hero-robot'),busy?'reading':activeState);
    setSprite(byId('stage-robot'),busy?'reading':c&&c.status==='clear'?'complete':activeState==='welcome'?'welcome':'hold');
    setSprite(byId('guide-sprite'),busy?'reading':activeState);
    setSprite(byId('result-robot'),c?resultState:'welcome');
    doc.querySelectorAll('.upload-quri').forEach(el=>setSprite(el,'upload',true));
    doc.querySelectorAll('.quri-input-avatar').forEach(el=>setSprite(el,'input',true));
    if(waitingText)waitingText.textContent=progressMessage;
    if(busy) { const heading=byId('guide-heading'),message=byId('guide-message'),stage=byId('stage-title');if(heading)heading.textContent=stage&&stage.textContent||'큐리가 자료를 확인하고 있어요';if(message)message.textContent=progressMessage; }
    if(c&&c.mode==='demo'&&byId('result-robot'))byId('result-robot').setAttribute('aria-label','실제 진단이 아닌 합성 예시를 안내하는 큐리');
    if(launcher)launcher.disabled=busy;
    if(busy&&tourIndex>=0)endTour(false);
    spriteNodes.forEach(el=>{ if(!el.isConnected) { if(intersections)intersections.unobserve(el);spriteNodes.delete(el);return; } el.dataset.quriPlay=String(animationAllowed()&&el.dataset.quriVisible!=='false'&&el.dataset.quriMotion!=='hold'); });
  }
  function scheduleRefresh() { if(queued)return;queued=true;root.requestAnimationFrame(()=>{queued=false;refresh();}); }
  function makePanel() {
    panel=node('section','quri-tour-panel');panel.id='quri-tour-panel';panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','false');panel.setAttribute('aria-labelledby','quri-tour-title');panel.setAttribute('aria-describedby','quri-tour-message');
    const top=node('div','quri-tour-top');top.append(node('span','quri-tour-eyebrow','QURI · 함께 둘러보기'));
    const close=node('button','quri-tour-close','×');close.type='button';close.setAttribute('aria-label','큐리 안내 닫기');close.addEventListener('click',()=>endTour());top.append(close);
    const intro=node('div','quri-tour-intro'),sprite=node('div','quri-v3-sprite');sprite.id='quri-tour-sprite';sprite.setAttribute('aria-hidden','true');const copy=node('div');const heading=node('h2','quri-tour-title');heading.id='quri-tour-title';heading.tabIndex=-1;const message=node('p','quri-tour-message');message.id='quri-tour-message';copy.append(heading,message);intro.append(sprite,copy);
    const tip=node('p','quri-tour-tip');tip.id='quri-tour-tip';const controls=node('div','quri-tour-controls'),position=node('span');position.id='quri-tour-position';const buttons=node('div','quri-tour-control-buttons');const prev=node('button','button secondary small','이전');prev.type='button';prev.id='quri-tour-previous';prev.addEventListener('click',()=>showStep(tourIndex-1));const next=node('button','button primary small','다음');next.type='button';next.id='quri-tour-next';next.addEventListener('click',()=>tourIndex>=steps.length-1?endTour():showStep(tourIndex+1));buttons.append(prev,next);controls.append(position,buttons);panel.append(top,intro,tip,controls);doc.body.append(panel);
    panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();endTour();}});
  }
  function showStep(index) {
    if(busy||index<0||index>=steps.length)return;
    if(target)target.classList.remove('quri-tour-target');
    tourIndex=index;const step=steps[index];
    if(root.ReviewApp) { root.ReviewApp.showView(step.view,false);if(step.mode)root.ReviewApp.setInputMode(step.mode); }
    target=doc.querySelector(step.selector);
    panel.hidden=false;launcher.setAttribute('aria-expanded','true');
    byId('quri-tour-title').textContent=step.title;byId('quri-tour-message').textContent=step.message;byId('quri-tour-tip').textContent=step.tip;byId('quri-tour-position').textContent=(index+1)+' / '+steps.length;
    byId('quri-tour-previous').disabled=index===0;byId('quri-tour-next').textContent=index===steps.length-1?'안내 마치기':'다음';
    setSprite(byId('quri-tour-sprite'),step.pose,true);
    if(target) { target.classList.add('quri-tour-target');target.scrollIntoView({behavior:'auto',block:'center'}); }
    byId('quri-tour-title').focus({preventScroll:true});
  }
  function startTour() { refresh();if(busy)return;lastFocus=doc.activeElement;showStep(0); }
  function endTour(restoreFocus=true) { if(target)target.classList.remove('quri-tour-target');target=null;tourIndex=-1;if(panel)panel.hidden=true;if(launcher)launcher.setAttribute('aria-expanded','false');if(restoreFocus&&lastFocus&&lastFocus.isConnected)lastFocus.focus({preventScroll:true});refresh(); }
  function init() {
    if(byId('quri-tour-panel'))return;
    if(typeof root.IntersectionObserver==='function')intersections=new root.IntersectionObserver(entries=>entries.forEach(entry=>{entry.target.dataset.quriVisible=String(entry.isIntersecting);entry.target.dataset.quriPlay=String(entry.isIntersecting&&animationAllowed()&&entry.target.dataset.quriMotion!=='hold');}),{threshold:0.02});
    launcher=node('button','quri-tour-launcher');launcher.type='button';launcher.id='quri-tour-start';launcher.setAttribute('aria-controls','quri-tour-panel');launcher.setAttribute('aria-expanded','false');launcher.append(node('span','quri-launch-dot'),node('span','','큐리와 둘러보기'));launcher.addEventListener('click',startTour);const actions=doc.querySelector('.topbar-actions');if(actions)actions.insertBefore(launcher,byId('motion-toggle'));else doc.body.append(launcher);
    makePanel();
    const form=byId('review-form');
    if(form) { const guide=node('div','quri-field-guide');const avatar=node('div','quri-v3-sprite quri-input-avatar');avatar.setAttribute('aria-hidden','true');const copy=node('div');copy.append(node('strong','','심사관님, 출원번호는 위 칸에 넣어 주세요.'),node('p','','번호와 연결 설정을 확인한 뒤 조회하고 진단을 눌러 주세요.'));guide.append(avatar,copy);form.append(guide); }
    const progress=byId('progress-detail');if(progress) { waiting=node('div','quri-waiting-status');waiting.hidden=true;waiting.append(node('span','quri-live-dot'));waitingText=node('span','','원문과 근거를 차례로 확인하고 있어요.');elapsed=node('time','','경과 0분 00초');elapsed.setAttribute('aria-live','off');waiting.append(waitingText,elapsed);progress.append(waiting); }
    byId('application-number')?.addEventListener('focus',()=>{if(!busy)setState('input');});
    byId('home-drop-zone')?.addEventListener('focusin',()=>{if(!busy)setState('upload');});
    byId('home-drop-zone')?.addEventListener('dragenter',()=>{if(!busy)setState('upload');});
    byId('drop-zone')?.addEventListener('focusin',()=>{if(!busy)setState('upload');});
    byId('motion-toggle')?.addEventListener('click',scheduleRefresh);
    doc.addEventListener('visibilitychange',()=>{doc.documentElement.dataset.quriHidden=String(doc.hidden);if(doc.hidden&&ticker){root.clearInterval(ticker);ticker=null;}else if(!doc.hidden&&busy&&!ticker){updateElapsed();ticker=root.setInterval(updateElapsed,1000);}refresh();});
    if(root.matchMedia){const reduced=root.matchMedia('(prefers-reduced-motion: reduce)');if(reduced.addEventListener)reduced.addEventListener('change',scheduleRefresh);}
    if(typeof root.MutationObserver==='function') { observer=new root.MutationObserver(scheduleRefresh);doc.querySelectorAll('.view').forEach(el=>observer.observe(el,{attributes:true,attributeFilter:['hidden']}));const result=byId('result-status');if(result)observer.observe(result,{childList:true,characterData:true,subtree:true}); }
    doc.addEventListener('click',event=>{ if(tourIndex>=0&&event.target.closest&&event.target.closest('[data-view]'))endTour(false); });
    doc.addEventListener('keydown',event=>{if(tourIndex>=0&&event.key==='Escape'){event.preventDefault();endTour();}});
    if(waiting)waiting.hidden=!busy;
    refresh();
  }
  root.QuriGuide=Object.freeze({setState,refresh,startTour,endTour,version:'3.0.0'});
  if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',init,{once:true});else init();
})(typeof window!=='undefined'?window:globalThis);
