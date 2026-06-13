const emptyEl = document.getElementById('empty');
const contentEl = document.getElementById('content');
const adaptedEl = document.getElementById('adapted');
const adaptedEl2 = document.getElementById('adapted2');
const originalEl = document.getElementById('original');
const compareEl = document.getElementById('compare');
const singleEl = document.getElementById('single');
const metaEl = document.getElementById('meta');
const levelEl = document.getElementById('level');
const providerEl = document.getElementById('provider');
const errorEl = document.getElementById('error');
const toggleViewBtn = document.getElementById('toggleView');
const copyBtn = document.getElementById('copy');

let state = {
  view: 'single',
  last: null,
  loading: null
};

function setError(msg) {
  errorEl.textContent = msg || '';
}

function render() {
  if (state.loading) {
    emptyEl.classList.remove('hidden');
    emptyEl.textContent = state.loading;
    contentEl.classList.add('hidden');
    toggleViewBtn.disabled = true;
    copyBtn.disabled = true;
    metaEl.textContent = '';
    return;
  }

  const r = state.last;
  if (!r) {
    emptyEl.classList.remove('hidden');
    emptyEl.textContent =
      'Select text on a page (or choose Whole page), then click Adapt in the popup.';
    contentEl.classList.add('hidden');
    toggleViewBtn.disabled = true;
    copyBtn.disabled = true;
    metaEl.textContent = '';
    return;
  }

  emptyEl.classList.add('hidden');
  contentEl.classList.remove('hidden');
  toggleViewBtn.disabled = false;
  copyBtn.disabled = false;

  metaEl.textContent = r.title ? `${r.title}${r.url ? ` · ${r.url}` : ''}` : (r.url || '');
  levelEl.textContent = r.level;
  providerEl.textContent = r.provider;

  adaptedEl.textContent = r.adaptedText || '';
  adaptedEl2.textContent = r.adaptedText || '';
  originalEl.textContent = r.originalText || '';

  if (state.view === 'compare') {
    compareEl.classList.remove('hidden');
    singleEl.classList.add('hidden');
    toggleViewBtn.textContent = 'Single';
  } else {
    compareEl.classList.add('hidden');
    singleEl.classList.remove('hidden');
    toggleViewBtn.textContent = 'Compare';
  }
}

toggleViewBtn.addEventListener('click', () => {
  state.view = state.view === 'single' ? 'compare' : 'single';
  render();
});

copyBtn.addEventListener('click', async () => {
  const r = state.last;
  if (!r?.adaptedText) return;
  try {
    await navigator.clipboard.writeText(r.adaptedText);
  } catch (e) {
    setError(e?.message || String(e));
  }
});

function applyResult(payload) {
  if (!payload) return;
  setError('');
  state.loading = null;
  state.last = payload;
  render();
}

function applyPanelStatus(status) {
  if (!status?.message) {
    state.loading = null;
  } else {
    state.loading = status.message;
  }
  render();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'TA_SIDE_PANEL_RESULT') applyResult(msg.payload);
  if (msg?.type === 'TA_SIDE_PANEL_ERROR') setError(msg.error || 'Unknown error');
});

chrome.storage.session.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes.ta_lastResult?.newValue) applyResult(changes.ta_lastResult.newValue);
  if (changes.ta_panelStatus) {
    applyPanelStatus(changes.ta_panelStatus.newValue);
  }
});

(async () => {
  const { ta_lastResult, ta_panelStatus } = await chrome.storage.session.get([
    'ta_lastResult',
    'ta_panelStatus'
  ]);
  if (ta_panelStatus) applyPanelStatus(ta_panelStatus);
  if (ta_lastResult) applyResult(ta_lastResult);
})();

