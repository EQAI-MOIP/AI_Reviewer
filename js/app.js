/* AI 심사팀장 큐리 3.0.0 — accessible, dependency-free workspace controller. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = window.ReviewAPI, Rules = window.ReviewRules, Engine = window.ReviewEngine;
  const runtime = API.runtimeInfo(location);
  const state = { caseData: null, settings: { ...API.defaults }, busy: false, controller: null,
    filter: 'all', view: 'review', inputMode: 'manual', demoBackup: null, dirty: false, objectURLs: new Set(), downloadURLs: new Map(), motion: true, intakePending: false, connectionTest: false };
  const names = { review: '진단 시작', results: '진단 결과', documents: '서류 준비', rules: '검토 규칙', guide: '사용 안내', settings: '설정' };
  const typeNames = { 'office-action': '의견제출통지서', 'final-notice': '최후 의견제출통지서', rejection: '거절결정서',
    'registration-decision': '등록결정서', publication: '공개공보', 'registration-gazette': '등록공보',
    claims: '시점별 청구항', amendment: '보정서', opinion: '의견서', citation: '인용문헌', other: '추가 원문' };
  const stageNames = { history: '행정처리 이력 확인', documents: '서류 수집·원문 확인', claims: '청구항 판본 확인',
    oa: '의견제출통지서 검토', decision: '결정서·등록청구항 검토', evidence: '근거와 코드 조건 확인' };
  const stageOrder = Object.keys(stageNames);
  const statusNames = { issues: '반려 검토사항이 있어요', clear: '적용한 규칙에서 발견되지 않았어요', hold: '추가 확인이 필요해요', idle: '심사관님, 자료를 준비해 주세요' };
  const labels = { confirmed: '근거가 확인된 검토사항', conditional: '조건 확인 필요', unverifiable: '자료 확인 필요', none: '발견 없음' };
  let toastTimer;
  const unsavedCases = new Set();
  function markDirty(c = current()) { if (c && c.mode !== 'demo') unsavedCases.add(c); state.dirty = unsavedCases.size > 0; }

  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = String(text); return n; }
  function button(label, action, value, cls = 'button secondary small') { const b = el('button', cls, label); b.type = 'button'; b.dataset.action = action; if (value !== undefined) b.dataset.value = value; return b; }
  function setText(id, text) { if ($(id)) $(id).textContent = String(text == null ? '' : text); }
  function safeError(error) { return API.redact(error && error.message || String(error), [state.settings.kiprisKey, state.settings.llmKey]); }
  function announce(text) { setText('status-announcement', text); }
  function toast(text) { clearTimeout(toastTimer); setText('toast', text); $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000); }
  function dateText(date) { const s = String(date || '').replace(/\D/g, ''); return s.length === 8 ? s.slice(0, 4) + '.' + s.slice(4, 6) + '.' + s.slice(6) : date || '기준일 미확인'; }
  function formatNo(no) { return /^\d{13}$/.test(no || '') ? no.slice(0, 2) + '-' + no.slice(2, 6) + '-' + no.slice(6) : no || '문서로 시작한 사건'; }
  function array(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
  function desc(value) { return typeof value === 'string' ? value : value && (value.message || value.reason || value.description || value.title) || ''; }
  function current() { return state.caseData; }

  function showView(view, focus = true, recordHistory = true) {
    if (!Object.hasOwn(names, view)) return;
    const changed = state.view !== view;
    state.view = view;
    document.querySelectorAll('.view').forEach(n => { n.hidden = n.id !== 'view-' + view; });
    document.querySelectorAll('.nav-item[data-view]').forEach(n => { const active = n.dataset.view === view; n.classList.toggle('active', active); if (active) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current'); });
    setText('current-view-label', names[view]); updateGuidance();
    if (recordHistory) {
      try {
        if (focus && changed && typeof history.pushState === 'function') history.pushState(null, '', '#' + view);
        else history.replaceState(null, '', '#' + view);
      } catch (_) { /* File origins may restrict history. */ }
    }
    document.title = names[view] + ' · AI 심사팀장 큐리';
    if (view === 'rules') renderRules();
    if (focus) { const heading = $('view-' + view).querySelector('h1'); if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); } window.scrollTo({ top: 0 }); }
  }

  function updateConnection() {
    const s = state.settings;
    let localModel = false;
    try { localModel = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(s.llmBase).hostname); } catch (_) { /* Incomplete settings are not ready. */ }
    const configured = Boolean(s.model && (s.llmKey || localModel));
    $('settings-dot').classList.toggle('ready', configured);
    $('settings-dot').title = configured ? 'API 설정 입력됨 · 실제 연결은 연결 확인으로 점검' : 'AI 진단용 LLM 연결을 설정해 주세요';
    setText('connection-label', navigator.onLine === false ? '오프라인 · 문서 작업 가능' : runtime.mode === 'web' ? '웹에서 사용 중' : runtime.canUseRelay && API.usesRelay(s) ? '로컬 중계 모드' : '브라우저 직접 연결');
    $('connection-badge').classList.toggle('offline', navigator.onLine === false);
    renderHosting();
  }

  function renderHosting() {
    const web = runtime.mode === 'web';
    if ($('hosting-notice')) $('hosting-notice').hidden = false;
    if ($('hosting-settings-message')) $('hosting-settings-message').hidden = false;
    setText('hosting-title', web ? '설치 없이, 문서부터 준비하세요' : runtime.mode === 'file' ? '파일로 실행 중입니다' : '이 컴퓨터에서 실행 중입니다');
    setText('hosting-message', web
      ? '문서 추가와 예시 보기는 바로 사용할 수 있어요. AI 진단은 연결 설정 후 시작하세요.'
      : runtime.mode === 'file' ? '문서 추가와 예시 보기를 사용할 수 있어요. API 연결이 막히면 내려받은 폴더의 실행 도우미를 이용하세요.'
      : '문서를 준비한 뒤 연결을 확인하세요. 자동 연결은 이 주소에서 실행 중인 로컬 도우미를 사용합니다.');
    setText('hosting-settings-message', web
      ? 'GitHub Pages에서는 브라우저가 설정한 API에 직접 연결합니다. API 제공자가 이 사이트의 연결(CORS)을 허용해야 해요. 연결이 차단되면 앱을 내려받아 로컬 실행 도우미로 여세요. 이 웹사이트에는 API 중계 서버가 없습니다.'
      : runtime.mode === 'file' ? '파일로 연 앱에서는 API에 직접 연결합니다. 연결이 차단되면 내려받은 폴더에서 node server.js를 실행하고 표시된 주소로 접속하세요.'
      : '자동 연결은 node server.js로 실행한 로컬 도우미를 사용합니다. 일반 정적 서버로 열었다면 브라우저 직접 연결을 선택하세요.');
    setText('connection-mode-help', runtime.canUseRelay ? '자동 연결은 로컬 실행 도우미를 사용합니다. 직접 연결은 API 제공자의 CORS 허용이 필요합니다.' : '이 화면에서는 자동·직접 연결 모두 브라우저에서 API에 연결합니다. 로컬 중계는 내려받은 앱의 실행 도우미에서 사용할 수 있습니다.');
    const relayOption = $('connection-mode').querySelector('option[value="relay"]');
    if (relayOption) relayOption.disabled = !runtime.canUseRelay;
    const autoOption = $('connection-mode').querySelector('option[value="auto"]');
    if (autoOption) autoOption.textContent = runtime.canUseRelay ? '자동 · 로컬 실행 도우미' : '자동 · 브라우저 직접 연결';
  }

  function readSettings() {
    const fd = new FormData($('settings-form'));
    const result = { ...API.defaults };
    for (const key of ['kiprisBase', 'kiprisKey', 'llmBase', 'llmKey', 'model', 'apiMode', 'tokenCounting', 'connectionMode', 'chatTokenField']) result[key] = String(fd.get(key) || '').trim();
    result.maxTokens = Number(fd.get('maxTokens'));
    result.outputTokens = Number(fd.get('outputTokens'));
    result.timeoutMs = Number(fd.get('timeoutSeconds') || 300) * 1000;
    result.maxModelCalls = Number(fd.get('maxModelCalls') || 100);
    result.pdfInput = fd.has('pdfInput');
    if (!Number.isInteger(result.maxTokens) || result.maxTokens < 4096 || result.maxTokens > 1000000) throw new Error('요청 예산은 4,096~1,000,000 사이의 정수로 입력해 주세요.');
    if (!Number.isInteger(result.outputTokens) || result.outputTokens < 1024 || result.outputTokens >= result.maxTokens - 1024) throw new Error('최대 출력 토큰은 전체 예산보다 1,024 이상 작아야 합니다.');
    if (!Number.isInteger(result.timeoutMs) || result.timeoutMs < 30000 || result.timeoutMs > 900000) throw new Error('호출 대기 시간은 30~900초로 설정해 주세요.');
    if (!Number.isInteger(result.maxModelCalls) || result.maxModelCalls < 1 || result.maxModelCalls > 300) throw new Error('사건당 AI 호출 상한은 1~300회로 설정해 주세요.');
    API.endpointURL(result.llmBase, result.apiMode);
    if (result.connectionMode === 'relay' && !runtime.canUseRelay) throw new Error('이 화면에서는 로컬 중계를 사용할 수 없습니다. 자동 또는 브라우저 직접 연결을 선택해 주세요.');
    if (!result.kiprisBase) result.kiprisBase = API.defaults.kiprisBase;
    const k = new URL(result.kiprisBase); if (k.protocol !== 'https:' || k.username || k.password || k.search || k.hash) throw new Error('KIPRIS Plus Base URL은 인증정보나 쿼리가 없는 HTTPS 주소여야 합니다.');
    return result;
  }

  function applySettings(quiet = false) {
    state.settings = readSettings(); updateConnection(); renderPreparation(); renderBudgetHint();
    if (!quiet) { setText('settings-feedback', '설정을 적용했습니다. API 키는 이 탭을 닫으면 지워집니다.'); toast('API 설정을 적용했습니다.'); }
    return state.settings;
  }

  function setBusy(value) {
    state.busy = value;
    $('start-review').disabled = value; $('cancel-review').hidden = !value;
    for (const id of ['demo-button', 'document-files', 'home-document-files', 'home-upload-button', 'upload-document-type', 'start-paste', 'mode-manual', 'mode-live', 'manual-case-number', 'import-case-button', 'application-number', 'save-settings', 'test-llm', 'test-kipris', 'test-text-generation', 'test-pdf-generation', 'forget-keys', 'purge-case', 'storage-new-case']) if ($(id)) $(id).disabled = value;
    document.querySelectorAll('[data-token-profile]').forEach(n => { n.disabled = value; });
    $('manual-document-form').querySelectorAll('input,select,textarea,button').forEach(n => { n.disabled = value; });
    $('settings-form').querySelectorAll('input,select,button').forEach(n => { n.disabled = value && n.id !== 'cancel-connection'; });
    $('review-documents').disabled = value || !current()?.documents?.length;
    $('clear-documents').disabled = value || !current()?.documents?.length;
    $('export-case').disabled = value || !current(); $('export-report').disabled = value || !current();
    $('review-form').setAttribute('aria-busy', String(value));
    $('settings-form').setAttribute('aria-busy', String(value && state.connectionTest));
    if ($('cancel-connection')) $('cancel-connection').hidden = !value || !state.connectionTest;
    document.querySelectorAll('[data-input-mode], #manual-case-form button').forEach(n => { n.disabled = value; });
    $('home-drop-zone')?.setAttribute('aria-disabled', String(value)); $('drop-zone').setAttribute('aria-disabled', String(value));
    updateGuidance();
    if (!value) renderStorage();
    window.QuriGuide?.setState(value ? 'reading' : current()?.status === 'clear' ? 'complete' : current()?.documents?.length ? 'hold' : 'welcome');
  }

  function mapStage(stage) {
    if (stageOrder.includes(stage)) return stage;
    if (/OA|통지서.*검토|통지서.*규칙/.test(stage)) return 'oa';
    if (/RD|RC|거절결정.*검토|등록청구항.*검토/.test(stage)) return 'decision';
    if (/근거|검증|코드|최종|evidence|complete/.test(stage)) return 'evidence';
    if (/청구|보정|판본/.test(stage)) return 'claims';
    if (/이력|history/.test(stage)) return 'history';
    return 'documents';
  }
  function resetProgress() { document.querySelectorAll('.step').forEach(n => { n.dataset.state = 'pending'; }); $('run-log').replaceChildren(); }
  function progress(event) {
    const e = typeof event === 'string' ? { message: event } : event || {};
    const stage = mapStage(e.stage || ''), idx = stageOrder.indexOf(stage);
    document.querySelectorAll('.step').forEach(n => { const at = stageOrder.indexOf(n.dataset.step); if (n.dataset.step === stage) n.dataset.state = 'active'; else if (at < idx && n.dataset.state === 'active') n.dataset.state = 'done'; });
    setText('stage-title', stageNames[stage]); setText('stage-message', e.message || '원문과 규칙을 확인하고 있습니다.');
    setText('progress-label', (idx + 1) + ' / 6 단계 · 검토 진행 중'); $('progress-detail').hidden = false; $('run-log').hidden = false;
    const pose = ['compare','upload','compare','thoughtful','explain','complete'][idx];
    $('stage-robot').className = 'quri-v2-sprite quri-pose-' + pose + ' stage-sprite';
    setText('hero-caption', '심사관님, ' + stageNames[stage] + ' 중이에요.');
    setText('guide-heading', stageNames[stage]); setText('guide-message', e.message || '근거를 확인하고 있어요.');
    $('guide-sprite').className = 'quri-v2-sprite quri-pose-' + pose + ' guide-avatar';
    const item = el('li', 'log-entry', e.message || stageNames[stage]); item.prepend(el('span', 'log-time', new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' '));
    $('run-log').append(item); while ($('run-log').children.length > 150) $('run-log').firstElementChild.remove();
    if (e.budget) setText('token-meter', (e.budget.inputTokens || 0).toLocaleString() + ' 입력 / ' + state.settings.maxTokens.toLocaleString() + ' 예산');
    renderStorage();
    window.QuriGuide?.setState('reading', { message: e.message || stageNames[stage] });
    announce(e.message || stageNames[stage]);
  }
  function finishProgress() {
    const status = current()?.status || 'hold';
    document.querySelectorAll('.step').forEach(n => { if (status === 'clear' || current()?.mode === 'demo') n.dataset.state = 'done'; else if (n.dataset.state === 'active') n.dataset.state = 'warning'; });
    setText('progress-label', statusNames[status] || '검토 종료'); setText('stage-title', '검토 내역을 확인해 주세요');
    setText('stage-message', current()?.summary || '확인한 범위와 추가로 필요한 자료를 진단 결과 화면에서 안내합니다.');
    $('progress-detail').hidden = false;
    const ledger = array(current()?.ledger), last = ledger[ledger.length - 1];
    if (last) setText('token-meter', '기본 요청 예산 ' + state.settings.maxTokens.toLocaleString() + ' tokens');
    $('stage-robot').className = 'quri-v2-sprite quri-pose-' + (status === 'clear' ? 'complete' : 'thoughtful') + ' stage-sprite';
    setText('hero-caption', '심사관님, 확인한 근거를 정리했어요.');
  }

  function retainedCases() { return [...new Set([current(), state.demoBackup].filter(Boolean))]; }
  function memoryStats() {
    const docs = retainedCases().flatMap(c => array(c.documents));
    return { documents: docs.length, bytes: docs.reduce((n, d) => n + (d.bytes?.byteLength || 0), 0),
      textChars: docs.reduce((n, d) => n + String(d.text || '').length, 0), activeCases: retainedCases().filter(c => c.mode !== 'demo').length,
      previewURLs: state.objectURLs.size, downloadURLs: state.downloadURLs.size };
  }
  function renderStorage() {
    const stats = memoryStats();
    setText('storage-size', (stats.bytes / 1048576).toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + ' MiB / 180 MiB');
    setText('storage-detail', '현재 탭 원문 ' + stats.documents + '개 · 추출 텍스트 ' + stats.textChars.toLocaleString() + '자. 새 사건을 시작하면 이전 원문과 결과를 자동 정리합니다.');
    const usage = $('storage-meter'); if (usage) { usage.value = stats.bytes; usage.max = 180 * 1048576; }
    if ($('purge-case')) $('purge-case').disabled = state.busy || !retainedCases().length;
    const m = current()?.runMetrics;
    if (m) setText('run-usage', 'AI 호출 ' + (m.attempted || 0) + '회 · 입력 ' + Number(m.inputTokens || 0).toLocaleString() + ' / 출력 ' + Number(m.outputTokens || 0).toLocaleString() + ' tokens (제공자 보고값 · 실패 요청 일부와 계산 요청은 제외될 수 있음)');
    else setText('run-usage', '사건당 AI 호출 상한 ' + state.settings.maxModelCalls + '회 · 규칙을 나눠 검토합니다.');
  }
  function releasePreview() {
    $('document-pdf').removeAttribute('src'); $('document-pdf').hidden = true;
    state.objectURLs.forEach(u => URL.revokeObjectURL(u)); state.objectURLs.clear();
  }
  function disposeCase(c) {
    if (!c) return;
    unsavedCases.delete(c);
    for (const d of array(c.documents)) { d.bytes = null; d.text = ''; d.pages = []; d.localPages = []; d.sourceLocations = []; d.metadataSuggestions = []; if (d.extraction) { d.extraction.summaries = []; d.extraction.diagnostics = null; d.extraction.pageDetails = []; } }
    for (const key of ['documents','history','claimVersions','registeredClaims','metadata','findings','coverage','ledger','failures','missingSources','adjudications']) c[key] = [];
    c.reviewConfirmations = {}; c.acquisition = {}; c.summary = ''; c.applicationNumber = ''; c._secrets = []; c.runMetrics = null; c.disposed = true;
  }
  function clearWorkspace() {
    releasePreview();
    for (const id of ['document-dialog', 'finding-dialog']) { const d = $(id); if (d?.open) d.close(); }
    for (const id of ['document-dialog-content', 'finding-detail', 'upload-feedback', 'run-log']) $(id)?.replaceChildren();
    state.downloadURLs.forEach((timer, url) => { clearTimeout(timer); URL.revokeObjectURL(url); }); state.downloadURLs.clear();
    retainedCases().forEach(disposeCase); state.caseData = null; state.demoBackup = null; unsavedCases.clear(); state.dirty = false;
    $('manual-document-form').reset();
    for (const id of ['document-files','home-document-files','import-case-file','manual-case-number','application-number']) $(id).value = '';
    for (const id of ['case-number-feedback','document-feedback','document-dialog-title','document-dialog-meta']) setText(id, '');
    state.filter = 'all';
    $('finding-filters').querySelectorAll('[data-filter]').forEach(b => { const active = b.dataset.filter === 'all'; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); });
    resetProgress(); $('progress-detail').hidden = true; $('run-log').hidden = true;
    setText('progress-label', '자료를 준비해 주세요');
  }
  function newCase() {
    if (state.busy || state.intakePending) return;
    clearWorkspace(); state.caseData = Engine.createCase(''); state.caseData.mode = 'manual';
    $('upload-document-type').value = 'auto'; renderAll(); setInputMode('manual'); showView('review');
    toast('이전 사건의 원문·추출문·결과·미리보기를 정리했습니다. 새 서류를 넣어 주세요.');
  }
  function renderBudgetHint() {
    const output = Number($('output-tokens').value), context = Number($('max-tokens').value);
    document.querySelectorAll('[data-token-profile]').forEach(b => { b.setAttribute('aria-pressed', String(Number(b.dataset.tokenProfile) === output)); });
    setText('budget-hint', '입력에 사용할 여유: 최대 ' + Math.max(0, context - output - 512).toLocaleString() + ' tokens. 출력 상한에는 추론 토큰도 포함될 수 있습니다. ' + (output < 25000 ? '복잡한 진단은 32k 이상을 검토해 주세요. ' : '') + '선택한 모델의 실제 컨텍스트·출력 한도를 확인하세요.');
  }

  async function runLive(event) {
    if (event) event.preventDefault(); if (state.busy) return;
    $('application-error').hidden = true;
    let no;
    try { no = API.normalizeApplicationNumber($('application-number').value); applySettings(true); if (!state.settings.kiprisKey) throw new Error('설정에서 KIPRIS Plus API 키를 입력해 주세요.'); if (!state.settings.model) throw new Error('설정에서 LLM 모델 ID를 입력해 주세요.'); }
    catch (error) { setText('application-error', safeError(error)); $('application-error').hidden = false; announce(safeError(error)); return; }
    clearWorkspace(); $('application-number').value = formatNo(no); state.caseData = Engine.createCase(no); state.caseData.mode = 'live';
    await executeReview(true);
  }

  async function executeReview(prepare) {
    state.controller = new AbortController(); markDirty(); resetProgress(); setBusy(true); showView('review', false);
    try {
      const options = { signal: state.controller.signal, onProgress: progress };
      if (state.settings.model) state.caseData = await Engine.review(current(), state.settings, options) || current();
      else { if (prepare) state.caseData = await Engine.prepareCase(current(), state.settings, options) || current(); state.caseData = Engine.localReview(current()) || current(); toast('LLM을 연결하지 않아 로컬 예비 점검만 실행했습니다. 전체 검토는 보류됩니다.'); }
    } catch (error) {
      const c = current(); c.status = 'hold'; c.summary = error.name === 'AbortError' ? '검토를 중단했습니다. 현재까지 확보한 자료는 남아 있습니다.' : safeError(error);
      c.failures = array(c.failures); c.failures.push({ stage: '검토', code: error.name === 'AbortError' ? 'ABORTED' : error.code || 'REVIEW_ERROR', message: c.summary });
      toast(c.summary);
    } finally {
      setBusy(false); renderAll(); finishProgress(); showView('results'); state.controller = null;
    }
  }

  async function runDocuments() {
    if (state.busy || !current()?.documents?.length) return;
    if (current().mode === 'demo') { toast('예시를 끝낸 뒤 실제 서류를 추가해 주세요.'); return; }
    try { applySettings(true); } catch (e) { toast(safeError(e)); return; }
    if (current().mode !== 'live') current().mode = 'manual'; await executeReview(true);
  }

  function showDemo(scenario = 'finding') {
    if (state.busy) return;
    if (current()?.mode !== 'demo') state.demoBackup = current();
    state.caseData = Engine.demoCase(scenario); state.caseData.mode = 'demo';
    setText('application-error', ''); $('application-error').hidden = true;
    resetProgress(); renderAll(); finishProgress(); showView('results'); announce('합성 자료로 구성한 ' + (statusNames[current().status] || '') + ' 예시입니다. 실제 출원에 대한 검토가 아닙니다.');
  }
  function exitDemo() { if (state.busy) return; state.caseData = state.demoBackup; state.demoBackup = null; resetProgress(); renderAll(); showView('review'); toast('예시를 닫았습니다.'); }

  function resultFindings() { return array(current()?.findings).filter(f => !['none','excluded'].includes(f.verdict) && f.isReturnReason !== false && !/^15\d\d$/.test(f.code || f.codeCandidate || '')); }
  function renderResults() {
    const c = current(), findings = resultFindings(); const status = c?.status || 'idle';
    $('demo-banner').hidden = c?.mode !== 'demo';
    setText('result-application', c ? (c.mode === 'demo' ? '합성 예시 · ' : '') + formatNo(c.applicationNumber) : '아직 검토한 출원이 없습니다');
    setText('result-status', statusNames[status] || '검토 보류');
    setText('result-summary', c?.summary || '출원번호를 입력하거나, 예시로 검토 화면을 살펴보세요.');
    setText('result-scope', c ? c.mode === 'demo' ? '설명용 합성 사건입니다. API 호출이나 실제 심사 판단을 수행한 결과가 아닙니다.' : (c.imported ? '저장한 사건을 불러왔습니다. 원문 검증 상태와 재검토 필요 항목을 확인해 주세요. ' : '') + '확보한 자료와 적용한 규칙 범위의 검토입니다. 미확인 항목은 검토 범위에서 구분합니다.' : '자료 수집 실패와 원문 미확인은 반려사유가 없다는 뜻이 아닙니다.');
    $('result-hero').dataset.status = status;
    $('result-hero').className = 'result-hero ' + (status === 'issues' ? 'result-danger' : status === 'clear' ? 'result-clear' : 'result-pending');
    $('coverage-panel').hidden = !c;
    $('result-robot').className = 'quri-v2-sprite result-robot quri-pose-' + (status === 'issues' ? 'explain' : status === 'clear' ? 'complete' : status === 'idle' ? 'welcome' : 'thoughtful');
    $('result-robot').setAttribute('aria-label', statusNames[status] || '추가 확인이 필요한 큐리');
    const confirmed = findings.filter(f => f.verdict === 'confirmed' && f.code).length;
    setText('confirmed-count', confirmed); setText('pending-count', findings.length - confirmed);
    setText('reviewed-count', array(c?.documents).length);
    const coverage = array(c?.coverage); setText('applied-count', new Set(coverage.map(x => x.ruleId).filter(Boolean)).size);
    setText('result-nav-count', findings.length); setText('finding-count-label', '전체 ' + findings.length + '건');
    const target = $('findings-list'); target.replaceChildren();
    const shown = findings.filter(f => state.filter === 'all' || state.filter === 'confirmed' && f.verdict === 'confirmed' || (state.filter === 'pending' || state.filter === 'conditional') && f.verdict !== 'confirmed');
    if (!shown.length) {
      const empty = el('div', 'empty-state card'); empty.append(el('h3', '', findings.length ? '이 분류에 해당하는 항목이 없습니다' : status === 'clear' ? '적용한 규칙에서 반려사유를 찾지 못했습니다' : '확인된 반려사유가 아직 없습니다'));
      empty.append(el('p', '', status === 'hold' ? '추가 자료와 검토 범위를 확인해 주세요. 확인하지 못한 항목은 아래에 표시합니다.' : status === 'idle' ? '예시를 둘러보거나 출원번호로 검토를 시작하세요.' : '검토 범위와 원문을 함께 확인해 주세요.')); target.append(empty);
    }
    shown.forEach(f => {
      const card = el('article', 'finding-card card'); card.dataset.verdict = f.verdict;
      const top = el('div', 'finding-card-top'); top.append(el('span', 'finding-code', f.code || (f.codeCandidate ? '후보 ' + f.codeCandidate : '코드 미확정')), el('span', 'status-pill ' + (f.verdict === 'confirmed' ? 'danger' : 'warning'), labels[f.verdict] || '확인 필요'));
      card.append(top, el('h3', 'finding-title', f.title || Rules.byId[f.ruleId]?.title || '확인할 사항'), el('p', 'finding-summary', f.summary || '세부 근거를 확인해 주세요.'));
      const meta = el('div', 'finding-meta'); meta.append(el('span', '', f.ruleId || '규칙 확인 필요')); if (array(f.claims).length) meta.append(el('span', '', '청구항 ' + array(f.claims).join(', '))); meta.append(el('span', '', '원문 근거 ' + array(f.evidence).length + '건')); card.append(meta);
      const actions = el('div', 'finding-actions'); actions.append(button('근거와 이유 살펴보기 →', 'finding', f.id, 'text-button')); card.append(actions); target.append(card);
    });
    const cov = $('coverage-content'); cov.replaceChildren();
    const comp = c?.completeness || {};
    const checks = [['history', '행정처리 이력 전체'], ['documents', '이력의 대상 원문'], ['identity', '문서 식별자 대조'], ['claims', '통지 시점 청구항 판본']];
    if (c) checks.forEach(([key, label]) => { const row = el('div', 'coverage-row'); row.append(el('span', '', label), el('span', 'status-pill ' + (comp[key] === true ? 'success' : 'warning'), comp[key] === true ? '확인' : '범위 확인 필요')); cov.append(row); });
    array(c?.failures).filter(f => !f.resolved).forEach(f => { const row = el('div', 'coverage-row coverage-warning'); row.append(el('strong', '', f.stage || '추가 확인'), el('span', '', desc(f) || f.code || '원문 확인이 필요합니다.')); cov.append(row); });
    const pendingChecks = coverage.filter(x => !x.complete || ['unverifiable','conditional','hold'].includes(x.result || x.status));
    if (pendingChecks.length) { const details = el('details', 'coverage-details'); details.append(el('summary', '', '검토 보류 규칙 ' + pendingChecks.length + '항목')); const list = el('ul'); pendingChecks.forEach(x => list.append(el('li', '', (x.ruleId || '') + ' · ' + (x.documentId || '') + ' — ' + (x.reason || x.message || '원문·조건 확인 필요')))); details.append(list); cov.append(details); }
    if (coverage.length) { const details = el('details', 'coverage-details'); details.append(el('summary', '', '적용 내역 ' + coverage.length + '건 모두 보기')); coverage.forEach(x => { const row = el('div', 'coverage-row'); row.append(el('span', '', (x.ruleId || '') + ' · ' + (x.documentId || '사건')), el('span', '', ({ checked: '검토', finding: '발견 사항', none: '발견 없음', not_applicable: '해당 없음', unverifiable: '확인 보류', conditional: '조건부 점검' }[x.result || x.status] || x.result || x.status || '') + (x.reason ? ' · ' + x.reason : '') + (Array.isArray(x.checkedClaims) ? ' · 검토 청구항 ' + x.checkedClaims.join(', ') : '') + (array(x.missing).length ? ' · 추가 확인: ' + x.missing.join(' / ') : ''))); details.append(row); }); cov.append(details); }
    if (array(c?.adjudications).length) { const audit = el('details','coverage-details'); audit.append(el('summary','','검토자가 제외 사유를 기록한 항목 ' + c.adjudications.length + '건')); audit.append(el('p','muted','문서가 바뀌거나 다시 진단하면 후보가 다시 나타날 수 있습니다. 제외 사유는 판단 기록으로 보존됩니다.')); c.adjudications.forEach(a => { const row = el('div','adjudication-row'); row.append(el('strong','',(a.ruleId || '') + ' · ' + (a.title || '검토 항목')),el('p','',a.reason || ''),el('small','',a.at ? new Date(a.at).toLocaleString('ko-KR') : '')); audit.append(row); }); cov.append(audit); }
    $('export-case').disabled = state.busy || !c; $('export-report').disabled = state.busy || !c;
  }

  function renderDocuments() {
    const docs = array(current()?.documents); setText('document-count', docs.length); setText('document-nav-count', docs.length);
    $('review-documents').disabled = state.busy || !docs.length; $('clear-documents').disabled = state.busy || !docs.length;
    const host = $('documents-list'); host.replaceChildren();
    renderScope(); renderPreparation();
    if (!docs.length) { const empty = el('div', 'empty-state card'); empty.append(el('h3', '', '아직 수집된 서류가 없습니다'), el('p', '', '출원번호로 서류를 수집하거나 가지고 있는 원문을 추가해 주세요.')); host.append(empty); return; }
    docs.forEach(d => {
      const card = el('article', 'document-card card'), info = el('div', 'document-info');
      const ext = (d.filename || '').split('.').pop().toUpperCase();
      card.append(el('div', 'document-icon', ['PDF','HWPX','DOCX','TXT','MD','JSON'].includes(ext) ? ext : 'DOC'));
      info.append(el('h3', '', d.title || d.filename || '문서'), el('div', 'document-meta', (typeNames[d.type] || d.type || '원문') + ' · ' + dateText(d.date) + ' · ' + (d.extraction?.syntheticPages ? '원문 쪽 위치 미확정' : d.pageCount ? d.pageCount + '쪽' : '쪽수 미확인')));
      const status = el('div', 'document-meta'); status.append(el('span', 'status-pill ' + (d.identityVerified ? 'success' : 'warning'), d.identityVerified ? '식별자 대조됨' : '식별자 확인 필요'));
      if (d.extraction) status.append(el('span', '', d.extraction.visualPending || !d.extraction.complete ? '판독·원문 확인 필요' : '텍스트 추출됨'));
      if (d.extraction?.unreadablePages?.length) status.append(el('span', 'status-pill warning', '미판독 ' + d.extraction.unreadablePages.length + '쪽'));
      if (d.extraction?.omittedContent?.length) status.append(el('span', 'status-pill warning', '그림·수식 등 별도 확인'));
      if (d.metadataSuggested) status.append(el('span', 'suggested-tag', '분류·날짜 제안 · 확인 필요'));
      if (d.type === 'registration-decision') status.append(el('span', '', d.officialCorrection === 'yes' ? '직권보정 확인 · 보관 대상' : '직권보정 확인 전 · 파일 내보내기 제외'));
      info.append(status); card.append(info);
      const actions = el('div', 'document-actions'); actions.append(button(d.identityVerified ? '원문 보기' : '분류·원문 확인', 'document', d.id)); const remove = button('제외', 'remove-document', d.id, 'quiet-button'); remove.disabled = state.busy || current().mode === 'demo'; actions.append(remove); card.append(actions); host.append(card);
    });
  }

  const scopeLabels = {
    historyComplete: '공식 행정처리 이력 전체와 문서 목록을 대조했습니다.',
    documentsComplete: '이력에 있는 모든 통지서·해당 결정서와 필요한 원문을 확보했습니다.',
    claimVersionsVerified: '각 통지 시점의 전체 청구항·인용관계와 보정 접수일을 대조했습니다.',
    registeredClaimsVerified: '등록공보의 최종 유효 청구항 전체와 청구항 텍스트를 대조했습니다.',
    citationsComplete: '검토에 필요한 인용문헌의 식별자와 실제 해당 원문을 모두 확인했습니다.',
    lawVersionVerified: '이 사건의 적용 시점에 맞는 공식 법령 원문과 조·항·호를 확인했습니다.'
  };
  function renderScope() {
    let host = $('scope-confirmation');
    if (!host) { host = el('details', 'card reviewer-confirmation'); host.id = 'scope-confirmation'; $('view-documents').append(host); }
    host.hidden = !current()?.documents?.length || current()?.mode === 'demo'; host.replaceChildren(); if (host.hidden) return;
    host.append(el('summary', '', '원문 확인과 검토 범위 보완'));
    host.append(el('p', 'muted', '자동으로 확인할 수 없는 항목을 원문과 대조한 경우에만 기록하세요. 이 확인은 규칙 검토 자체를 대신하지 않습니다.'));
    const form = el('form'); form.id = 'scope-confirmation-form';
    Object.entries(scopeLabels).forEach(([key, text]) => { const label = el('label', 'checkbox-row'), input = el('input'); input.type = 'checkbox'; input.name = key; input.checked = current().reviewConfirmations?.[key] === true; input.disabled = state.busy; label.append(input, el('span', '', text)); form.append(label); });
    const save = el('button', 'button secondary', '확인한 범위 기록'); save.type = 'submit'; save.disabled = state.busy; form.append(save); host.append(form);
  }

  function documentEditForm(d) {
    const details = el('details', 'reviewer-confirmation'); details.open = !d.identityVerified || d.metadataSuggested === true; details.append(el('summary', '', '문서 종류·기준일·원문 확인'));
    details.append(el('p', 'muted', '심사관님, 자동으로 찾은 정보는 제안입니다. 아래 원문과 대조한 항목만 확인해 주세요.'));
    const form = el('form'); form.dataset.documentEdit = d.id; const grid = el('div', 'form-grid');
    if (d.metadataSuggestions?.length) { const provenance = el('details', 'metadata-provenance'); provenance.append(el('summary', '', '자동 제안은 어디에서 찾았나요?')); d.metadataSuggestions.forEach(x => provenance.append(el('p', '', (x.basis || '원문에서 제안') + (x.quote ? ' · ' + x.quote : '')))); details.append(provenance); }
    function field(labelText, name, value, type = 'text') { const wrapper = el('div', 'field'); const label = el('label', '', labelText), input = el('input'); input.type = type; input.name = name; input.value = value || ''; input.id = 'edit-doc-' + name; input.disabled = state.busy; label.htmlFor = input.id; wrapper.append(label, input); grid.append(wrapper); return input; }
    const typeBox = el('div', 'field'), typeLabel = el('label', '', '문서 종류'), select = el('select'); select.name = 'type'; select.id = 'edit-doc-type'; typeLabel.htmlFor = select.id; select.disabled = state.busy;
    Object.entries(typeNames).forEach(([key, title]) => { const option = el('option', '', title); option.value = key; select.append(option); }); select.value = d.type; typeBox.append(typeLabel, select); grid.append(typeBox);
    field('문서 이름', 'title', d.title); field('발송·접수·기준일', 'date', /^\d{8}$/.test(d.date || '') ? d.date.slice(0, 4) + '-' + d.date.slice(4, 6) + '-' + d.date.slice(6) : '', 'date');
    field('발송·접수·공보번호', 'documentNumber', d.documentNumber); field('이 문서의 출원번호', 'applicationNumber', d.applicationNumber || current().applicationNumber); field('청구항 판본 기준일', 'versionDate', /^\d{8}$/.test(d.versionDate || '') ? d.versionDate.slice(0, 4) + '-' + d.versionDate.slice(4, 6) + '-' + d.versionDate.slice(6) : '', 'date');
    form.append(grid);
    for (const [key, prop, text] of [
      ['identityConfirmed', 'reviewerIdentityConfirmed', '실제 원문의 출원번호·문서명·일자·식별자를 대조했습니다.'],
      ['completeConfirmed', 'reviewerCompleteConfirmed', '모든 쪽의 텍스트·표·수식·도면을 원문과 대조하여 누락이 없음을 확인했습니다.'],
      ['versionConfirmed', 'reviewerVersionConfirmed', '이 청구항의 기준 시점과 이후 보정 반영 여부를 확인했습니다.'],
      ['orderingConfirmed', 'orderingConfirmed', '같은 날 접수·발송된 문서는 접수·발송 순서를 확인하여 이 판본이 해당 통지 전에 적용되었음을 확인했습니다.']]) {
      const label = el('label', 'checkbox-row'), input = el('input'); input.type = 'checkbox'; input.name = key; input.checked = d[prop] === true; input.disabled = state.busy || key === 'completeConfirmed' && d.extraction?.syntheticPages === true; if (key === 'completeConfirmed' && d.extraction?.syntheticPages) input.checked = false; label.append(input, el('span', '', text)); form.append(label);
    }
    if (d.extraction?.syntheticPages) form.append(el('p', 'source-warning', 'HWPX·DOCX는 본문 텍스트를 추출하지만 실제 쪽 배치와 모든 그림·수식을 재현하지 못합니다. 정확한 원문 인용이 필요한 판정에는 PDF 또는 [쪽 n] 표시를 넣어 원문과 대조한 텍스트를 추가해 주세요.'));
    const correction = el('div', 'field'), correctionLabel = el('label', '', '등록결정서의 직권보정 확인'), cs = el('select'); cs.name = 'officialCorrection'; cs.id = 'edit-doc-correction'; correctionLabel.htmlFor = cs.id; cs.disabled = state.busy;
    [['unknown', '미확인 / 해당 없음'], ['yes', '직권보정 있음 · 원문 확인'], ['no', '직권보정 없음 · 원문 확인']].forEach(([value, text]) => { const o = el('option', '', text); o.value = value; cs.append(o); }); cs.value = d.officialCorrection || 'unknown'; correction.append(correctionLabel, cs); form.append(correction);
    const notices = array(current().documents).filter(x => ['office-action', 'final-notice', 'rejection'].includes(x.type));
    if (notices.length) { const fs = el('fieldset'); fs.append(el('legend', '', '이 청구항 판본이 적용되는 통지·결정 (해당할 때만)')); notices.forEach(n => { const label = el('label', 'checkbox-row'), input = el('input'); input.type = 'checkbox'; input.name = 'appliesTo'; input.value = n.id; input.checked = array(d.appliesTo).includes(n.id); input.disabled = state.busy; label.append(input, el('span', '', dateText(n.date) + ' · ' + n.title)); fs.append(label); }); form.append(fs); }
    const save = el('button', 'button primary', '문서 정보 반영'); save.type = 'submit'; save.disabled = state.busy; form.append(save); details.append(form); return details;
  }

  function inlineText(parent, text) { String(text).split(/(`[^`]+`|\*\*[^*]+\*\*)/g).forEach(part => { if (/^`.*`$/.test(part)) parent.append(el('code', '', part.slice(1, -1))); else if (/^\*\*.*\*\*$/.test(part)) parent.append(el('strong', '', part.slice(2, -2))); else parent.append(document.createTextNode(part)); }); }
  function renderMarkdown(container, source) {
    let list = null;
    String(source || '').split('\n').forEach(line => { if (!line.trim()) { list = null; return; }
      const h = line.match(/^(#{1,6})\s+(.*)/); if (h) { list = null; const n = el('h' + Math.min(6, h[1].length + 1)); inlineText(n, h[2]); container.append(n); }
      else if (/^\s*[-*]\s+/.test(line)) { if (!list) { list = el('ul'); container.append(list); } const n = el('li'); inlineText(n, line.replace(/^\s*[-*]\s+/, '')); list.append(n); }
      else { list = null; const n = el('p'); inlineText(n, line); container.append(n); }
    });
  }
  function renderRules() {
    const query = $('rules-search').value.trim().toLowerCase(), group = $('rules-filter').value;
    const host = $('rules-list'); host.replaceChildren();
    const rules = group === 'codes' ? [] : Rules.rules.filter(r => group === 'all' || r.id.startsWith(group));
    rules.filter(r => !query || (r.id + ' ' + r.title + ' ' + r.fullText).toLowerCase().includes(query)).forEach(r => {
      const d = el('details', 'rule-card card'), sum = el('summary'); sum.append(el('span', 'rule-id', r.id), el('span', '', r.title)); const body = el('div', 'rule-body'); renderMarkdown(body, r.fullText); d.append(sum, body); if (query === r.id.toLowerCase()) d.open = true; host.append(d);
    });
    if (group === 'all' || group === 'codes') Rules.codeList.filter(c => !query || (c.code + ' ' + (c.description || c.title) + ' ' + (c.operatingNote || '')).toLowerCase().includes(query)).forEach(c => {
      const d = el('details', 'rule-card card code-card'), sum = el('summary'); sum.append(el('span', 'rule-id', c.code), el('span', '', c.description || c.title)); const body = el('div', 'rule-body'); body.append(el('p', '', c.category || '공식 진단코드')); renderMarkdown(body, c.operatingNote || c.fullText || c.description); if (c.code.startsWith('15')) body.append(el('p', 'muted', '우수사례 분류이며 반려사유로 집계하지 않습니다.')); d.append(sum, body); if (query === c.code) d.open = true; host.append(d);
    });
    if (!host.children.length) host.append(el('div', 'empty-state card', '검색어에 맞는 규칙이나 코드가 없습니다.'));
    setText('rules-version', '규칙판 ' + Rules.version + ' · 원문 수록');
  }

  function showDocument(id, page) {
    releasePreview();
    let d = array(current()?.documents).find(x => x.id === id); let versionRecord = false;
    if (!d) { const v = array(current()?.claimVersions).find(x => x.id === id); if (v) { versionRecord = true; d = { id:v.id, type:'claims', title:v.title || '청구항 변동 이력의 판본', date:v.date, documentNumber:v.receiptNumber, filename:v.id + '.txt', pages:array(v.claims).map(x => ({page:'claim-' + x.number,text:'청구항 ' + x.number + '\n' + x.text})), text:array(v.claims).map(x => '청구항 ' + x.number + '\n' + x.text).join('\n\n'), retention:'retain' }; } }
    if (!d) { toast('이 근거의 원문이 현재 사건에 없습니다.'); return; }
    setText('document-dialog-title', d.title || d.filename || '원문'); setText('document-dialog-meta', (typeNames[d.type] || d.type) + ' · ' + dateText(d.date) + ' · ' + (d.documentNumber || '문서번호 미확인'));
    const target = $('document-dialog-content'); target.replaceChildren();
    if (!versionRecord && current().mode !== 'demo' && Engine.updateDocument) target.append(documentEditForm(d));
    if (d.sha256) target.append(el('p', 'document-hash', 'SHA-256 · ' + d.sha256));
    array(d.extraction?.warnings).forEach(w => target.append(el('p', 'source-warning', desc(w))));
    const q = d.extraction || {};
    const readout = el('section', 'reading-summary'); readout.append(el('h3', '', '이 문서는 어디까지 읽었나요?'));
    readout.append(el('p', '', '추출 텍스트 ' + String(d.text || '').length.toLocaleString() + '자 · ' + (q.syntheticPages ? '구역·문단 위치로 표시 (원문 쪽수 미확정)' : '본문이 확보된 쪽 ' + array(d.pages).length + ' / 전체 ' + (d.pageCount || '?') + '쪽')));
    if (array(q.unreadablePages).length) readout.append(el('p', 'source-warning', '판독하지 못한 쪽: ' + q.unreadablePages.join(', ') + '. 이 쪽을 읽기 전에는 전체 판독을 확인할 수 없습니다.'));
    const kindLabels = { images:'그림·스캔 영역', equations:'수식 객체', 'embedded-documents':'삽입 문서·OLE', 'automatic-numbering':'자동 번호', 'font-symbols':'글꼴 기호', 'form-fields':'PDF 양식 필드', annotations:'PDF 주석', altChunk:'외부 포함 문서', 'uncertain-visibility':'숨김 글자', 'alternate-content':'대체 표시 콘텐츠' };
    if (array(q.omittedContent).length) readout.append(el('p', 'source-warning', '텍스트 판독에 포함되지 않았거나 표시가 불확실한 요소: ' + q.omittedContent.map(x => (kindLabels[x.kind] || x.kind || '기타') + (x.count ? ' ' + x.count + '개' : '')).join(' · ')));
    if (array(q.pageDetails).length) { const detail = el('details', 'coverage-details'); detail.append(el('summary', '', '쪽별 판독 내역')); q.pageDetails.forEach(x => detail.append(el('p', '', x.page + '쪽 · ' + Number(x.chars || 0).toLocaleString() + '자 · ' + ({text:'텍스트 추출',partial:'일부 확인 필요',unreadable:'판독 필요'}[x.status] || x.status || '미확인') + (x.images ? ' · 그림 ' + x.images + '개' : '')))); readout.append(detail); }
    if (array(d.sourceLocations).length) { const structure = el('details', 'coverage-details'); structure.append(el('summary', '', '본문 구조 위치 ' + d.sourceLocations.length + '개')); d.sourceLocations.slice(0, 200).forEach(x => { const part = el('div','source-location'); part.append(el('strong','',x.label || '구조 위치'),el('p','',String(x.text || '').slice(0,1200))); structure.append(part); }); if (d.sourceLocations.length > 200) structure.append(el('p','muted','화면에는 처음 200개 위치를 표시합니다. 전체 추출문은 아래에 있습니다.')); readout.append(structure); }
    target.append(readout);
    const pages = array(d.pages);
    if (pages.length) pages.forEach(p => { const section = el('section', 'source-page'); section.id = 'source-page-' + p.page; section.append(el('h3', '', d.extraction?.syntheticPages ? '전체 본문 · 원문 쪽 위치 미확정' : /^\d+$/.test(String(p.page)) ? p.page + '쪽' : '청구항 기록 ' + p.page), el('pre', 'source-text', p.text || '텍스트 미확보')); if (String(page) === String(p.page)) section.classList.add('highlighted'); target.append(section); });
    else target.append(el('pre', 'source-text', d.text || '현재 확인한 텍스트가 없습니다. PDF 원문을 열어 확인해 주세요.'));
    const frame = $('document-pdf'); frame.removeAttribute('src'); frame.hidden = true;
    if (d.bytes?.length && d.verifiedPdf === true && (d.filename || '').toLowerCase().endsWith('.pdf')) { const url = URL.createObjectURL(new Blob([d.bytes], { type: 'application/pdf' })); state.objectURLs.add(url); frame.src = url + (/^\d+$/.test(String(page)) ? '#page=' + Number(page) : ''); frame.hidden = false; }
    const allowed = d.type !== 'registration-decision' || d.officialCorrection === 'yes';
    $('download-document').disabled = !allowed || versionRecord; $('download-document').dataset.value = d.id;
    if (!allowed) target.prepend(el('p', 'source-warning', '등록결정서는 직권보정이 확인된 경우에만 보관합니다. 현재 원문은 임시로 확인하고 있으며 사건 내보내기에도 포함하지 않습니다.'));
    const dialog = $('document-dialog'); if (!dialog.open) dialog.showModal();
    if (page) requestAnimationFrame(() => $('source-page-' + page)?.scrollIntoView({ block: 'nearest' }));
  }

  const flagLabels = {
    sourceEvidenceVerified: '인용한 문구와 쪽수가 실제 원문과 일치함', documentIdentityVerified: '출원번호·문서 종류·발송번호·날짜를 원문과 대조함',
    claimVersionVerified: '해당 심사 시점의 청구항 전체와 인용관계가 확인됨', grantDecisionVerified: '해당 청구항으로 등록결정된 경과가 확인됨',
    rejectionDecisionVerified: '해당 거절결정서 원문이 확인됨', hasOtherValidReasons: '다른 정당한 거절이유가 없음', rejectedOnThisReason: '이 이유로 거절결정됨',
    claimRequirementErrorVerified: '원문과 설명을 대조하여 청구범위 기재요건 오지적을 확인함', decisionCourseVerified: '통지·거절·등록의 결정 경과를 확인함',
    finalNoticeVerified: '이 문서가 최후통지임을 확인함', claimVersionsCompared: '보정 전후 전체 청구항과 인용관계를 대조함', reasonPredatedAmendment: '해당 이유가 보정 전부터 존재했음을 확인함',
    priorNoticesComplete: '결정 전의 모든 의견제출통지서·최후통지를 확보함', reasonExistedInitially: '해당 이유가 최초 심사 판본부터 존재했음을 확인함',
    splitNoticeVerified: '최초부터 존재한 이유를 나누어 통지했음을 확인함', justifiedSplit: '분할 통지에 정당한 사유가 없음',
    correctionClearFromNotice: '통지서 자체만으로는 올바른 의미를 명백히 복원할 수 없음', citedOriginalVerified: '실제 인용문헌의 식별자와 해당 부분을 확인함',
    actualTypoVerified: '원문 대조로 실제 오기를 확인함', dualLimitationAmbiguityVerified: '선호 표현이 실제 이중한정·해석 장애를 일으킴을 문맥으로 확인함',
    decisionChronologyVerified: '각 선행 통지가 거절결정 전에 발송되었음을 확인함', applicantArgumentOrAmendmentVerified: '출원인의 핵심 주장 또는 보정 원문을 확인함',
    finalDecisionImpactVerified: '해당 검토 누락이 최종 판단에 영향을 줌을 확인함'
  };
  Object.assign(flagLabels, { sourceReadabilityVerified:'인용한 문서의 전체 쪽과 판독 상태 확인', evidenceScopeVerified:'규칙이 요구하는 각 문서의 인용 근거 확보', claimNumbersVerified:'지적한 청구항 번호와 실제 판본 대조', claimVersionsCompared:'보정 전후 청구항 판본 모두 확보', finalNoticeVerified:'실제 최후통지 원문 확보' });
  const falseFlags = new Set(['hasOtherValidReasons', 'justifiedSplit', 'correctionClearFromNotice']);
  function showFinding(id) {
    const f = resultFindings().find(x => x.id === id); if (!f) return;
    setText('finding-dialog-title', f.title || '반려사유와 근거'); const host = $('finding-detail'); host.replaceChildren();
    const intro = el('div', 'finding-intro'), robot = el('div', 'quri-v2-sprite detail-robot quri-pose-' + (f.verdict === 'confirmed' ? 'explain' : 'thoughtful')); robot.setAttribute('role', 'img'); robot.setAttribute('aria-label', f.verdict === 'confirmed' ? '반려사유를 안내하는 큐리' : '추가 확인을 안내하는 큐리'); intro.append(robot, el('p', '', f.summary || '원문과 규칙을 함께 확인해 주세요.')); host.append(intro);
    const badges = el('div', 'finding-meta'); badges.append(el('span', 'finding-code', f.code || (f.codeCandidate ? '후보 ' + f.codeCandidate : '코드 미확정')), button(f.ruleId + ' 규칙 보기', 'rule', f.ruleId, 'text-button')); host.append(badges);
    host.append(el('h3', '', '어떤 원문을 비교했나요?'));
    if (!array(f.evidence).length) host.append(el('p', 'source-warning', '확인 가능한 원문 인용이 충분하지 않습니다.'));
    array(f.evidence).forEach(e => { const doc = array(current().documents).find(d => d.id === e.documentId); const block = el('div', 'evidence-block'); const location = doc?.extraction?.syntheticPages ? '전체 본문 · 원문 쪽 위치 미확정' : /^\d+$/.test(String(e.page)) ? e.page + '쪽' : e.page || e.location || '위치 확인 필요'; block.append(el('strong', '', (doc?.title || e.documentId || '문서 미확인') + ' · ' + location), el('blockquote', '', e.quote || e.text || '인용문 미확보')); const b = button('원문에서 보기', 'evidence', e.documentId, 'text-button'); b.dataset.page = e.page || ''; block.append(b); host.append(block); });
    if (f.alternative) { host.append(el('h3', '', '다르게 해석할 수 있나요?'), el('p', '', f.alternative)); }
    if (f.secondPass) { host.append(el('h3', '', '반론을 한 번 더 검토했나요?'), el('p', '', ({supported:'원문으로 다시 검토함',conditional:'추가 확인 필요',disputed:'검토 의견 불일치',incomplete:'재검토 미완료'}[f.secondPass.status] || '재검토 기록') + ' · ' + (f.secondPass.reason || '')), el('p', 'muted', '같은 모델의 별도 검토입니다. 독립된 전문가의 확인을 대신하지 않습니다.')); }
    const missing = [...array(f.missing).map(desc), ...array(f.codeValidation?.errors).map(desc)].filter(Boolean);
    if (missing.length) { host.append(el('h3', '', '무엇을 더 확인해야 하나요?')); const list = el('ul'); [...new Set(missing)].forEach(x => list.append(el('li', '', x))); host.append(list); }
    const code = f.code || f.codeCandidate; if (code && Rules.codes[code]) { host.append(el('h3', '', '공식 코드의 적용 조건'), el('p', '', Rules.codes[code].description || Rules.codes[code].title)); }
    if (f.verdict !== 'confirmed' && code && current().mode !== 'demo' && Engine.confirmFinding) {
      const required = array(f.codeValidation?.required).map(x => typeof x === 'string' ? x : x.key || x.field).filter(Boolean);
      if (required.length) {
        const section = el('details', 'reviewer-confirmation'); section.append(el('summary', '', '원문을 직접 확인한 뒤 코드 적용 조건 확인'));
        section.append(el('p', 'muted', '각 항목의 근거를 실제 원문에서 확인한 경우에만 선택하세요. 선택한 조건은 검토자의 확인으로 기록됩니다.'));
        const automatic = new Set(Engine.automaticProofFlags || ['sourceEvidenceVerified','sourceReadabilityVerified','evidenceScopeVerified','documentIdentityVerified','claimVersionVerified','claimNumbersVerified','claimVersionsCompared','decisionChronologyVerified','priorNoticesComplete','rejectionDecisionVerified','grantDecisionVerified','decisionCourseVerified','finalNoticeVerified','citedOriginalVerified']);
        const automaticMissing = [...new Set(required)].filter(key => automatic.has(key));
        if (automaticMissing.length) { const note = el('div', 'automatic-proof-note'); note.append(el('strong', '', '원문 자료에서 확인할 항목')); const list = el('ul'); automaticMissing.forEach(key => list.append(el('li', '', flagLabels[key] || key))); note.append(list, el('p', '', '해당 원문과 문서 정보를 보완한 뒤 다시 진단하면 확인됩니다.')); section.append(note); }
        const manualRequired = [...new Set(required)].filter(key => !automatic.has(key));
        const form = el('form'); form.dataset.confirmFinding = f.id;
        manualRequired.forEach(key => { const label = el('label', 'checkbox-row'); const input = el('input'); input.type = 'checkbox'; input.name = key; input.required = true; label.append(input, el('span', '', flagLabels[key] || key)); form.append(label); });
        const go = el('button', 'button primary', '확인한 조건으로 코드 다시 검증'); go.type = 'submit'; go.disabled = state.busy; if (manualRequired.length) { form.append(go); section.append(form); } host.append(section);
      }
    }
    if (['conditional','unverifiable'].includes(f.verdict) && current().mode !== 'demo' && Engine.excludeFinding) {
      const section = el('details','reviewer-confirmation'); section.append(el('summary','','원문 검토 후, 이 후보를 제외하려면')); section.append(el('p','muted','실제 원문을 확인해 문제가 아닌 이유를 구체적으로 남겨 주세요. 이 기록은 자료 부족이나 미완료 규칙을 검토 완료로 바꾸지 않습니다.'));
      const form = el('form'); form.dataset.excludeFinding = f.id; const field = el('div','field'), label = el('label','','검토한 원문과 제외 사유'), input = el('textarea'); input.id='exclude-finding-reason'; input.name='reason'; input.minLength=10; input.maxLength=2000; input.rows=3; input.required=true; input.placeholder='예: 해당 표현은 발명의 설명에만 있고, 등록청구항 제1항부터 제5항에는 없어 현재 청구범위의 문제로 보지 않음.'; label.htmlFor=input.id; field.append(label,input); const save=el('button','button secondary','사유를 기록하고 후보 제외'); save.type='submit'; save.disabled=state.busy; form.append(field,save); section.append(form); host.append(section);
    }
    if (!$('finding-dialog').open) $('finding-dialog').showModal();
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob), a = el('a'); a.href = url; a.download = filename.replace(/[\\/:*?"<>|]/g, '_');
    a.hidden = true; document.body.append(a); a.click(); a.remove();
    const timer = setTimeout(() => { URL.revokeObjectURL(url); state.downloadURLs.delete(url); }, 15000);
    state.downloadURLs.set(url, timer);
  }
  function downloadDocument(id) { const d = array(current()?.documents).find(x => x.id === id); if (!d) return; if (d.type === 'registration-decision' && d.officialCorrection !== 'yes') { toast('직권보정 확인 전의 등록결정서는 내보내지 않습니다.'); return; } const mime = d.bytes?.length ? d.verifiedPdf === true ? 'application/pdf' : 'application/octet-stream' : 'text/plain;charset=utf-8'; downloadBlob(new Blob([d.bytes?.length ? d.bytes : d.text || ''], { type: mime }), d.filename || d.id + '.txt'); }
  function exportCase() { if (!current() || state.busy) return; try { const data = Engine.serializeCase(current()); downloadBlob(new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type: 'application/json' }), 'AI_Review_Leader_QURI_' + (current().applicationNumber || 'case') + (current().mode === 'demo' ? '_DEMO' : '') + '.json'); if (current().mode !== 'demo') unsavedCases.delete(current()); state.dirty = unsavedCases.size > 0; toast('API 키를 제외한 사건 파일의 다운로드를 요청했습니다. 브라우저의 다운로드 폴더를 확인해 주세요.'); } catch (e) { toast(safeError(e)); } }
  function exportReport() { if (!current() || state.busy) return; downloadBlob(new Blob([Engine.makeReport(current())], { type: 'text/markdown;charset=utf-8' }), 'AI_Review_Leader_QURI_' + (current().applicationNumber || 'case') + '_report.md'); }

  async function importSaved(file) {
    if (!file || state.busy) return;
    if (file.size > 100 * 1024 * 1024) { toast('사건 파일은 100 MiB 이하로 나누어 주세요.'); return; }
    const controller = new AbortController(); state.controller = controller; setBusy(true);
    try {
      const data = await Engine.importCase(await file.text());
      if (controller.signal.aborted) throw new DOMException('불러오기를 중단했습니다.', 'AbortError');
      clearWorkspace(); state.caseData = data; state.caseData.imported = true;
      $('application-number').value = data.applicationNumber ? formatNo(data.applicationNumber) : '';
      $('manual-case-number').value = data.applicationNumber ? formatNo(data.applicationNumber) : '';
      resetProgress(); renderAll(); showView('results');
      toast('사건을 불러오고 이전 사건의 임시 원문을 정리했습니다. 원문 확인 상태를 점검해 주세요.');
    } catch (e) { toast('사건 파일을 열지 못했습니다. ' + safeError(e)); }
    finally { state.controller = null; setBusy(false); renderAll(); }
  }
  function ensureManualCase() {
    if (current()?.mode === 'demo') throw new Error('예시를 끝낸 뒤 실제 서류를 추가해 주세요.');
    if (!current()) { const raw = $('manual-case-number').value.trim(); const no = raw ? API.normalizeApplicationNumber(raw) : ''; state.caseData = Engine.createCase(no); state.caseData.mode = 'manual'; }
    return current();
  }
  async function addFiles(files, inputType = 'auto') {
    if (state.busy) return;
    const list = Array.from(files || []); if (!list.length) return;
    if (list.length === 1 && /\.json$/i.test(list[0].name) && list[0].size <= 100 * 1024 * 1024) {
      // Lock the workspace before the first asynchronous read, including format sniffing.
      const controller = new AbortController(); state.controller = controller; state.intakePending = true; setBusy(true);
      let saved = false;
      try { const data = JSON.parse(await list[0].text()); saved = Boolean(data && ['ai-review-chief-case','ai-review-leader-quri-case'].includes(data.format)); }
      catch (_) { /* Ordinary JSON documents follow the normal document route. */ }
      finally { state.controller = null; state.intakePending = false; setBusy(false); }
      if (controller.signal.aborted) return;
      if (saved) { await importSaved(list[0]); return; }
    }
    if (list.length > 60) { toast('한 번에 최대 60개의 파일을 추가해 주세요.'); return; }
    let c; try { c = ensureManualCase(); } catch (e) { toast(safeError(e)); return; }
    if (c.documents.length + list.length > (Engine.LIMIT?.documents || 150)) { toast('한 사건에는 최대 150개의 문서를 준비해 주세요.'); return; }
    const pendingBytes = list.reduce((n, f) => n + Number(f.size || 0), 0) + c.documents.reduce((n, d) => n + (d.bytes?.byteLength || 0), 0);
    if (pendingBytes > (Engine.LIMIT?.totalBytes || 180 * 1024 * 1024)) { toast('현재 원문과 추가할 파일의 합계가 180 MiB를 넘습니다. 파일을 줄이거나 새 사건으로 나누어 주세요.'); return; }
    state.controller = new AbortController(); setBusy(true); let added = 0, duplicates = 0, failed = 0, needsReview = 0;
    const uploadReport = [];
    try {
      for (const file of list) {
        if (state.controller.signal.aborted) break;
        try {
          const doc = await Engine.ingestFile(file, { applicationNumber: c.applicationNumber }, { settings: { ...state.settings, pdfInput: false }, signal: state.controller.signal, onProgress: progress });
          if (state.controller.signal.aborted) break;
          if (doc.extraction?.status === 'failed' && !doc.verifiedPdf) throw new Error(array(doc.extraction.warnings).map(desc).filter(Boolean).join(' · ') || '파일 형식이나 본문을 읽지 못했습니다. PDF 또는 텍스트로 변환해 주세요.');
          if (doc.sha256 && c.documents.some(d => d.sha256 === doc.sha256)) { duplicates++; uploadReport.push(file.name + ' · 동일한 원문이 이미 있어 건너뛰었습니다.'); continue; }
          const suggestion = API.suggestDocumentMetadata ? API.suggestDocumentMetadata(array(doc.pages).find(p => p.page === 1)?.text || doc.text, file.name) : {};
          // Suggestions do not mark identity, extraction or claim versions as verified.
          const metadata = { type: typeNames[inputType] ? inputType : suggestion.type || doc.type, title: suggestion.title || doc.title, date: suggestion.date || doc.date, documentNumber: suggestion.documentNumber || doc.documentNumber, identityConfirmed: false, completeConfirmed: false, versionConfirmed: false };
          if (metadata.type === 'citation') metadata.applicationNumber = suggestion.applicationNumber || '';
          else if (suggestion.applicationNumber && c.applicationNumber) metadata.applicationNumber = suggestion.applicationNumber;
          doc.suggestedApplicationNumber = suggestion.applicationNumber || '';
          if (!c.applicationNumber && metadata.type !== 'citation' && suggestion.applicationNumber && !$('manual-case-number').value.trim()) { $('manual-case-number').value = formatNo(suggestion.applicationNumber); setText('case-number-feedback', '문서에서 찾은 번호입니다. 원문과 대조한 뒤 번호 반영을 눌러 주세요.'); }
          if (c.applicationNumber && metadata.applicationNumber && metadata.type !== 'citation' && metadata.applicationNumber !== c.applicationNumber) throw new Error('현재 사건과 출원번호가 다릅니다. 인용할 문헌이라면 위 문서 종류를 ‘인용문헌’으로 선택해 다시 추가해 주세요. 다른 심사 사건은 별도 목록을 사용합니다.');
          doc.type = metadata.type; if (metadata.applicationNumber !== undefined) doc.applicationNumber = metadata.applicationNumber;
          doc.metadataSuggested = Boolean(suggestion.type && suggestion.type !== 'other' || suggestion.date || suggestion.applicationNumber);
          if (Engine.addDocument) Engine.addDocument(c, doc); else c.documents.push(doc);
          try { if (Engine.updateDocument) Engine.updateDocument(c, doc.id, metadata); else Object.assign(doc, metadata); }
          catch (error) { c.documents = c.documents.filter(d => d.id !== doc.id); throw error; }
          doc.metadataSuggested = Boolean(suggestion.type && suggestion.type !== 'other' || suggestion.date || suggestion.applicationNumber);
          doc.metadataSuggestions = array(suggestion.suggestions); doc.extraction = doc.extraction || { warnings:[] };
          doc.extraction.warnings = [...array(doc.extraction.warnings), ...array(suggestion.warnings)];
          added++;
          if (doc.extraction?.status === 'failed') { needsReview++; uploadReport.push(file.name + ' · 원문 보관됨 · 자동 판독 미완료: ' + array(doc.extraction.warnings).map(desc).filter(Boolean).join(' · ')); }
          else uploadReport.push(file.name + ' · 추가됨');
        } catch (e) {
          if (e.name === 'AbortError') break; failed++; uploadReport.push(file.name + ' · ' + safeError(e));
        }
      }
      if (added) { c.status = 'hold'; c.summary = '문서 종류와 날짜를 원문에서 확인한 뒤 큐리에게 진단을 요청해 주세요.'; markDirty(c); }
    } finally {
      setBusy(false); state.controller = null; renderAll(); showView('documents', false);
      let report = $('upload-feedback'); if (!report) { report = el('div', 'upload-feedback'); report.id = 'upload-feedback'; $('document-readiness').after(report); }
      report.replaceChildren(); report.append(el('strong', '', added + '개 추가' + (duplicates ? ' · 중복 ' + duplicates + '개 제외' : '') + (failed + needsReview ? ' · 확인 필요 ' + (failed + needsReview) + '개' : '')));
      const details = el('details'); if (failed + needsReview) details.open = true; details.append(el('summary', '', '파일별 처리 내역')); const rows = el('ul'); uploadReport.forEach(text => rows.append(el('li', '', text))); details.append(rows); report.append(details);
      toast(added + '개의 서류를 추가했습니다.' + (failed + needsReview ? ' 판독하지 못한 파일은 목록 위 안내를 확인해 주세요.' : duplicates ? ' 동일한 원문은 중복 추가하지 않았어요.' : ' 문서 종류와 날짜를 확인해 주세요.'));
      $('document-files').value = ''; $('home-document-files').value = '';
    }
  }
  async function addManual(event) {
    event.preventDefault(); if (state.busy) return; const form = event.currentTarget;
    try {
      const c = ensureManualCase(), fd = new FormData(form), text = String(fd.get('text') || '');
      if (c.documents.length >= (Engine.LIMIT?.documents || 150)) throw new Error('한 사건에는 최대 150개의 문서를 준비해 주세요.');
      if (text.trim().length < 20) throw new Error('검토할 원문을 20자 이상 입력해 주세요.');
      if (text.length > 2000000) throw new Error('문서가 너무 깁니다. 200만 자 이하로 나누어 주세요.');
      const metadata = { type: fd.get('type'), title: fd.get('title'), date: String(fd.get('date') || '').replace(/-/g, ''), documentNumber: fd.get('documentNumber'), applicationNumber: c.applicationNumber, identityConfirmed: fd.has('verified'), completeConfirmed: false, versionConfirmed: false };
      if (metadata.type === 'citation') metadata.applicationNumber = API.suggestDocumentMetadata ? API.suggestDocumentMetadata(text, '').applicationNumber || '' : '';
      const file = new File([text], 'manual-' + Date.now() + '.txt', { type: 'text/plain' });
      state.controller = new AbortController(); setBusy(true);
      const doc = await Engine.ingestFile(file, metadata, { settings: { ...state.settings, pdfInput: false }, signal: state.controller.signal });
      if (state.controller.signal.aborted) throw new DOMException('입력을 중단했습니다.', 'AbortError');
      if (Engine.addDocument) Engine.addDocument(c, doc); else { c.documents.push(doc); c.findings = []; c.coverage = []; } c.status = 'hold'; c.summary = '원문을 추가했습니다. 현재 서류로 검토를 실행해 주세요.'; markDirty(c); form.reset();
      setText('document-feedback', '원문이 추가되었습니다.'); renderAll(); toast('서류를 추가했습니다.');
    } catch (e) { setText('document-feedback', safeError(e)); } finally { setBusy(false); state.controller = null; renderAll(); }
  }

  async function runConnectionTest(resultId, pendingMessage, perform) {
    if (state.busy) return;
    try {
      applySettings(true); state.controller = new AbortController(); state.connectionTest = true; setBusy(true);
      setText(resultId, pendingMessage);
      const controller = state.controller;
      const message = await perform(controller.signal);
      if (controller.signal.aborted) throw new DOMException('연결 확인을 중단했습니다.', 'AbortError');
      setText(resultId, message);
    } catch (e) { setText(resultId, e.name === 'AbortError' ? '연결 확인을 중단했습니다. 설정을 확인하고 다시 시도할 수 있어요.' : safeError(e)); }
    finally { state.controller = null; state.connectionTest = false; setBusy(false); }
  }
  async function testLLM() {
    return runConnectionTest('llm-test-result', '설정한 제공자의 모델 목록을 확인하고 있습니다…', async signal => {
      const r = await API.testConnection(state.settings, { signal });
      if (signal.aborted) throw new DOMException('연결 확인을 중단했습니다.', 'AbortError');
      let dl = $('available-models');
      if (!dl) { dl = el('datalist'); dl.id = 'available-models'; $('llm-model').after(dl); $('llm-model').setAttribute('list', dl.id); }
      dl.replaceChildren();
      array(r.models).slice(0, 1000).forEach(id => { const o = el('option'); o.value = id; dl.append(o); });
      return r.note + (r.modelAvailable === false ? ' 입력한 모델 ID는 반환된 목록에서 확인되지 않았습니다.' : r.modelAvailable ? ' 입력한 모델을 목록에서 확인했습니다.' : ' 모델 ID를 선택하거나 입력해 주세요.');
    });
  }
  async function testKipris() {
    return runConnectionTest('kipris-test-result', '입력한 출원의 행정처리 이력으로 연결을 확인하고 있습니다…', async signal => {
      const raw = $('application-number').value || $('manual-case-number').value || current()?.applicationNumber;
      if (!raw) throw new Error('진단 시작 → 출원번호로 조회에서 13자리 출원번호를 먼저 입력해 주세요.');
      const no = API.normalizeApplicationNumber(raw);
      const r = await API.testKipris(no, state.settings, { signal });
      return r.note || '행정처리 이력 연결을 확인했습니다. 문서별 상품 이용 권한은 수집 단계에서 별도로 확인합니다.';
    });
  }
  async function testGeneration(pdf) {
    return runConnectionTest('capability-test-result', pdf ? '합성 1쪽 PDF로 입력 토큰 계산과 판독 응답을 확인합니다…' : '합성 문구로 실제 모델 호출을 확인합니다…', async signal => {
      const result = await API.testGeneration(state.settings, { pdf, signal });
      return result.note;
    });
  }

  function setInputMode(mode) {
    if (state.busy || !['manual','live'].includes(mode)) return;
    state.inputMode = mode;
    for (const key of ['manual','live']) { const active = key === mode, tab = $('mode-' + key); tab.classList.toggle('selected', active); tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; $(key + '-start-panel').hidden = !active; }
    setText('hero-caption', mode === 'manual' ? '심사관님, 준비하신 문서를 올려 주세요.' : '심사관님, 출원번호로 자료를 찾아볼게요.');
    window.QuriGuide?.setState(mode === 'manual' ? 'upload' : 'input');
  }
  function updateGuidance() {
    const host = $('quri-guidance'); if (!host) return;
    host.hidden = state.view === 'review';
    const docs = array(current()?.documents), needs = docs.filter(d => !d.identityVerified || !d.extraction?.complete || d.extraction?.visualPending).length;
    const info = {
      documents:['upload','심사관님, 자료부터 꼼꼼히 준비해요.', docs.length ? docs.length + '개 문서를 준비했어요. ' + (needs ? needs + '개 문서의 분류·날짜·판독 상태를 확인해 주세요.' : '통지 시점의 청구항과 인용문헌도 함께 확인해 주세요.') : '출원번호 없이도 괜찮아요. 통지서·결정서와 해당 시점 청구항을 올려 주세요.', '설정', 'settings'],
      results:[current()?.status === 'clear' ? 'complete' : current()?.status === 'issues' ? 'explain' : 'thoughtful','심사관님, 판단의 근거를 함께 살펴봐요.', '각 카드에서 규칙·진단코드·원문 인용과 보류 사유를 확인하세요. 추가 문서는 서류 준비에서 보완할 수 있어요.', '서류 보완', 'documents'],
      rules:['compare','어떤 기준으로 진단하나요?', '통지서 OA 17개, 거절결정 RD 6개, 등록청구항 RC 7개와 공식 진단코드 84개를 확인할 수 있어요.', '사용 안내', 'guide'],
      guide:['welcome','처음이어도 괜찮아요, 심사관님.', '자료 준비 → 원문·판본 확인 → 진단 → 근거 확인 순서로 큐리가 함께할게요.', '진단 시작', 'review'],
      settings:['thoughtful','심사관님이 사용할 모델을 연결해요.', '문서 업로드는 KIPRIS 키가 필요 없어요. AI 진단은 LLM 연결을 설정한 뒤 실행해 주세요.', '문서 준비', 'documents']
    }[state.view];
    if (!info) return;
    $('guide-sprite').className = 'quri-v2-sprite quri-pose-' + info[0] + ' guide-avatar'; setText('guide-heading',info[1]); setText('guide-message',info[2]); setText('guide-action',info[3]); $('guide-action').dataset.view = info[4];
  }
  function renderPreparation() {
    const host = $('preparation-checklist'); if (!host) return;
    const docs = array(current()?.documents), selected = $('preparation-kind').value;
    const kind = selected !== 'auto' ? selected : docs.some(d => d.type === 'rejection') ? 'rd' : docs.some(d => d.type === 'final-notice') ? 'final' : docs.some(d => ['registration-gazette','registration-decision'].includes(d.type)) ? 'rc' : 'oa';
    const items = {
      oa:[[['office-action','final-notice'],'통지서','문서별로 독립 진단'],[['claims','amendment'],'통지 당시 청구항','기준일·보정 반영 확인'],[['publication'],'명세서·도면','설명과 청구항 대조'],[['citation'],'인용문헌','식별자와 해당 부분 확인']],
      final:[[['final-notice'],'최후통지','각 거절이유 분리'],[['office-action'],'선행 통지','이미 존재한 이유 대조'],[['claims','amendment'],'보정 전후 청구항','전체 문언·인용관계 확인'],[['citation','publication'],'명세서·인용문헌','필요한 원문 보완']],
      rd:[[['rejection'],'거절결정서','결정의 이유별 대조'],[['office-action','final-notice'],'모든 선행 통지','미통지 새 이유 확인'],[['claims','amendment'],'당시 청구항·보정','통지·결정 시점 대조'],[['opinion','citation'],'의견서·인용문헌','주장 검토·실체 판단 보완']],
      rc:[[['registration-gazette'],'등록공보','최종 유효 청구항 확인'],[['claims'],'등록청구항 텍스트','공보와 판본 대조'],[['publication'],'발명의 설명·도면','명확성·뒷받침·실시가능성'],[['registration-decision'],'등록결정서','직권보정 여부 확인']]
    }[kind];
    host.replaceChildren();
    items.forEach(([types,title,hint]) => { const present = docs.filter(d => types.includes(d.type)); const row = el('div','preparation-item' + (present.length ? ' present' : '')); row.append(el('span','preparation-marker',present.length ? '✓' : '+')); const content = el('div'); content.append(el('strong','',title),el('small','',present.length ? present.length + '개 추가됨 · ' + hint : hint)); row.append(content); host.append(row); });
    const unready = docs.filter(d => !d.identityVerified || !d.extraction?.complete || d.extraction?.visualPending).length;
    setText('document-readiness', docs.length ? '문서 ' + docs.length + '개 준비 · ' + (unready ? unready + '개 원문 확인 필요. ' : '판본과 검토 범위를 확인해 주세요. ') + (state.settings.model ? '진단을 실행하면 설정한 LLM에 원문을 전달합니다.' : 'LLM 연결 전에는 로컬 예비 점검만 실행합니다.') : '아직 준비된 문서가 없어요. 파일을 추가하거나 아래에서 원문을 붙여넣어 주세요.');
    setText('review-documents', state.settings.model ? '큐리에게 진단받기' : '로컬 예비 점검');
    setText('open-prepared', docs.length ? '추가한 서류 ' + docs.length + '개 확인 →' : '서류 준비 화면 열기 →');
  }

  function renderAll() { renderResults(); renderDocuments(); renderStorage(); updateConnection(); updateGuidance(); window.QuriGuide?.refresh(); }
  document.addEventListener('click', event => {
    const mode = event.target.closest('[data-input-mode]'); if (mode) { setInputMode(mode.dataset.inputMode); return; }
    const nav = event.target.closest('[data-view]'); if (nav) { event.preventDefault(); showView(nav.dataset.view); return; }
    const close = event.target.closest('[data-close-dialog]'); if (close) { $(close.dataset.closeDialog)?.close(); return; }
    const b = event.target.closest('[data-action]'); if (!b) return;
    const action = b.dataset.action, value = b.dataset.value;
    if (action === 'finding') showFinding(value);
    if (action === 'document' || action === 'evidence') showDocument(value, b.dataset.page);
    if (action === 'rule') { $('finding-dialog').close(); $('rules-search').value = value; $('rules-filter').value = 'all'; showView('rules'); }
    if (action === 'demo') showDemo(value);
    if (action === 'remove-document' && !state.busy && current()?.mode !== 'demo') { if (Engine.removeDocument) Engine.removeDocument(current(), value); else { current().documents = current().documents.filter(x => x.id !== value); current().claimVersions = array(current().claimVersions).filter(x => x.sourceDocumentId !== value); current().status = 'hold'; current().summary = '문서가 변경되어 재검토가 필요합니다.'; current().findings = []; current().coverage = []; current().completeness.documents = false; } markDirty(); renderAll(); }
  });
  document.addEventListener('submit', event => {
    if (event.target.id === 'scope-confirmation-form') {
      event.preventDefault(); if (state.busy || !Engine.confirmScope) return;
      try { const fd = new FormData(event.target), flags = {}; Object.keys(scopeLabels).forEach(key => { flags[key] = fd.has(key); }); Engine.confirmScope(current(), flags); markDirty(); renderAll(); toast('검토자가 확인한 범위를 기록했습니다. 현재 서류로 검토를 실행해 주세요.'); } catch (e) { toast(safeError(e)); } return;
    }
    const documentForm = event.target.closest('[data-document-edit]');
    if (documentForm) {
      event.preventDefault(); if (state.busy || !Engine.updateDocument) return;
      try { const fd = new FormData(documentForm), metadata = {}; ['type','title','date','documentNumber','applicationNumber','versionDate','officialCorrection'].forEach(key => { metadata[key] = String(fd.get(key) || '').trim(); }); ['identityConfirmed','completeConfirmed','versionConfirmed','orderingConfirmed'].forEach(key => { metadata[key] = fd.has(key); }); metadata.appliesTo = fd.getAll('appliesTo'); metadata.metadataConfirmed = true; Engine.updateDocument(current(), documentForm.dataset.documentEdit, metadata); const edited = current().documents.find(d => d.id === documentForm.dataset.documentEdit); if (edited) edited.metadataSuggested = false; markDirty(); renderAll(); showDocument(documentForm.dataset.documentEdit); toast('문서 정보를 반영했습니다. 변경된 범위는 다시 검토해 주세요.'); } catch (e) { toast(safeError(e)); } return;
    }
    const exclusionForm = event.target.closest('[data-exclude-finding]');
    if (exclusionForm) { event.preventDefault(); if (state.busy || !Engine.excludeFinding) return; try { Engine.excludeFinding(current(),exclusionForm.dataset.excludeFinding,new FormData(exclusionForm).get('reason')); markDirty(); $('finding-dialog').close(); renderAll(); toast('제외 사유를 기록했습니다. 진단 결과의 검토 범위에서 기록을 확인할 수 있어요.'); } catch (e) { toast(safeError(e)); } return; }
    const form = event.target.closest('[data-confirm-finding]'); if (!form) return; event.preventDefault(); if (state.busy) return;
    try { const flags = {}; new FormData(form).forEach((_, key) => { flags[key] = !falseFlags.has(key); }); Engine.confirmFinding(current(), form.dataset.confirmFinding, flags); markDirty(); renderAll(); showFinding(form.dataset.confirmFinding); toast('검토자의 확인 조건으로 코드 적용 여부를 다시 검증했습니다.'); } catch (e) { toast(safeError(e)); }
  });
  $('review-form').addEventListener('submit', runLive);
  $('cancel-review').addEventListener('click', () => { state.controller?.abort(); setText('stage-message', '검토를 중단하고 현재까지 확보한 자료를 정리합니다.'); });
  $('cancel-connection').addEventListener('click', () => { if (state.connectionTest) state.controller?.abort(); });
  $('settings-form').addEventListener('submit', event => { event.preventDefault(); try { applySettings(); } catch (e) { setText('settings-feedback', safeError(e)); } });
  $('forget-keys').addEventListener('click', () => { $('kipris-key').value = ''; $('llm-key').value = ''; state.settings.kiprisKey = ''; state.settings.llmKey = ''; updateConnection(); setText('settings-feedback', '입력한 API 키를 지웠습니다.'); });
  $('test-llm').addEventListener('click', testLLM); $('test-kipris').addEventListener('click', testKipris);
  $('test-text-generation').addEventListener('click', () => testGeneration(false));
  $('test-pdf-generation').addEventListener('click', () => testGeneration(true));
  document.querySelectorAll('[data-token-profile]').forEach(b => b.addEventListener('click', () => {
    if (state.busy) return; $('output-tokens').value = b.dataset.tokenProfile; renderBudgetHint();
  }));
  $('output-tokens').addEventListener('input', renderBudgetHint); $('max-tokens').addEventListener('input', renderBudgetHint);
  $('demo-button').addEventListener('click', () => showDemo()); $('exit-demo').addEventListener('click', exitDemo);
  $('export-case').addEventListener('click', exportCase); $('export-report').addEventListener('click', exportReport);
  $('download-document').addEventListener('click', () => downloadDocument($('download-document').dataset.value));
  $('review-documents').addEventListener('click', runDocuments);
  $('clear-documents').addEventListener('click', newCase);
  $('storage-new-case').addEventListener('click', newCase);
  $('purge-case').addEventListener('click', () => { if (state.busy) return; clearWorkspace(); renderAll(); showView('review'); toast('현재 사건의 임시 원문과 결과를 비웠습니다. 컴퓨터에 직접 저장한 파일은 유지됩니다.'); });
  $('manual-document-form').addEventListener('submit', addManual);
  $('document-files').addEventListener('change', e => addFiles(e.target.files, $('upload-document-type').value));
  $('home-document-files').addEventListener('change', e => addFiles(e.target.files));
  $('home-upload-button').addEventListener('click', e => { e.stopPropagation(); if (!state.busy) $('home-document-files').click(); });
  $('start-paste').addEventListener('click', () => { if (state.busy) return; showView('documents'); $('manual-document-details').open = true; $('document-text').focus(); });
  $('preparation-kind').addEventListener('change', renderPreparation);
  $('manual-case-form').addEventListener('submit', e => { e.preventDefault(); if (state.busy) return; try { const c = ensureManualCase(); if (Engine.setApplicationNumber) Engine.setApplicationNumber(c, $('manual-case-number').value); else c.applicationNumber = API.normalizeApplicationNumber($('manual-case-number').value); $('manual-case-number').value = c.applicationNumber ? formatNo(c.applicationNumber) : ''; markDirty(c); renderAll(); setText('case-number-feedback', '출원번호를 반영했습니다.'); } catch (error) { setText('case-number-feedback', safeError(error)); } });
  document.querySelectorAll('[data-input-mode]').forEach(n => n.addEventListener('keydown', e => { if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key) || state.busy) return; e.preventDefault(); const mode = e.key === 'Home' ? 'manual' : e.key === 'End' ? 'live' : state.inputMode === 'manual' ? 'live' : 'manual'; setInputMode(mode); $('mode-' + mode).focus(); }));
  $('import-case-button').addEventListener('click', () => $('import-case-file').click());
  $('import-case-file').addEventListener('change', async e => { await importSaved(e.target.files[0]); e.target.value = ''; });
  $('rules-search').addEventListener('input', renderRules); $('rules-filter').addEventListener('change', renderRules);
  $('finding-filters').addEventListener('click', e => { const b = e.target.closest('[data-filter]'); if (!b) return; state.filter = b.dataset.filter; $('finding-filters').querySelectorAll('[data-filter]').forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); }); renderResults(); });
  const dz = $('drop-zone'); dz.addEventListener('click', e => { if (state.busy || e.target.closest('label,input,button')) return; $('document-files').click(); }); ['dragenter', 'dragover'].forEach(type => dz.addEventListener(type, e => { e.preventDefault(); if (!state.busy) dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(type => dz.addEventListener(type, e => { e.preventDefault(); dz.classList.remove('dragover'); })); dz.addEventListener('drop', e => addFiles(e.dataTransfer.files, $('upload-document-type').value));
  const homeDZ = $('home-drop-zone'); homeDZ.addEventListener('click', () => { if (!state.busy) $('home-document-files').click(); });
  homeDZ.addEventListener('keydown', e => { if (e.target !== homeDZ || !['Enter',' '].includes(e.key)) return; e.preventDefault(); if (!state.busy) $('home-document-files').click(); });
  dz.addEventListener('keydown', e => { if (e.target !== dz || !['Enter',' '].includes(e.key)) return; e.preventDefault(); if (!state.busy) $('document-files').click(); });
  ['dragenter','dragover'].forEach(type => homeDZ.addEventListener(type, e => { e.preventDefault(); if (!state.busy) homeDZ.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(type => homeDZ.addEventListener(type, e => { e.preventDefault(); homeDZ.classList.remove('dragover'); })); homeDZ.addEventListener('drop', e => { e.preventDefault(); if (!state.busy) addFiles(e.dataTransfer.files); });
  document.addEventListener('dragover', e => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault(); }); document.addEventListener('drop', e => { if (!dz.contains(e.target)) e.preventDefault(); });
  $('motion-toggle').addEventListener('click', () => { state.motion = !state.motion; document.body.classList.toggle('reduce-motion', !state.motion); $('motion-toggle').setAttribute('aria-pressed', String(!state.motion)); setText('motion-toggle', state.motion ? '모션 끄기' : '모션 켜기'); });
  window.addEventListener('online', updateConnection); window.addEventListener('offline', updateConnection);
  function followLocation() {
    const view = location.hash.slice(1);
    if (Object.hasOwn(names, view) && view !== state.view) showView(view, true, false);
  }
  window.addEventListener('popstate', followLocation);
  window.addEventListener('hashchange', followLocation);
  $('document-dialog').addEventListener('close', releasePreview);
  window.addEventListener('beforeunload', e => { if (state.busy || unsavedCases.size > 0) { e.preventDefault(); e.returnValue = ''; } });

  // Settings are never written to Web Storage, cookies, URLs or exported case files.
  Object.entries(state.settings).forEach(([key, value]) => { const field = $('settings-form').elements.namedItem(key); if (!field) return; if (field.type === 'checkbox') field.checked = Boolean(value); else field.value = String(value); });
  const demoChoices = el('div', 'demo-choices'); demoChoices.append(button('반려사유 예시', 'demo', 'finding'), button('발견 없음 예시', 'demo', 'clear'), button('자료 부족 예시', 'demo', 'missing')); $('demo-banner').append(demoChoices);
  renderAll(); renderRules(); showView(Object.hasOwn(names, location.hash.slice(1)) ? location.hash.slice(1) : 'review', false); setText('token-meter', '기본 요청 예산 ' + state.settings.maxTokens.toLocaleString() + ' tokens'); renderBudgetHint();
  window.ReviewApp = Object.freeze({ showView, showDemo, renderAll, getCase: () => current(), runLive, runDocuments, addFiles, importSaved, setInputMode, newCase, memoryStats, isBusy: () => state.busy });
})();
