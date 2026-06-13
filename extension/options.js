import { setStatus } from './ui_shared.js';

const apiKeyEl = document.getElementById('apiKey');
const saveBtn = document.getElementById('save');
const testBtn = document.getElementById('test');
const statusEl = document.getElementById('status');

const GROQ_DEFAULTS = {
  provider: 'openai_compatible',
  baseUrl: 'https://api.groq.com/openai/v1',
  model: 'llama-3.1-8b-instant',
  apiKey: '',
  maxChars: 24000,
  fastMode: true
};

function currentSettings() {
  return {
    ...GROQ_DEFAULTS,
    apiKey: apiKeyEl.value,
    fastMode: true
  };
}

async function load() {
  const stored = await chrome.storage.sync.get(['ta_settings']);
  const s = { ...GROQ_DEFAULTS, ...(stored.ta_settings || {}) };
  apiKeyEl.value = s.apiKey || '';
}

async function save() {
  await chrome.storage.sync.set({ ta_settings: currentSettings() });
}

saveBtn.addEventListener('click', async () => {
  setStatus(statusEl, 'Saving…');
  try {
    await save();
    setStatus(statusEl, 'Saved.');
  } catch (e) {
    setStatus(statusEl, e?.message || String(e));
  }
});

testBtn.addEventListener('click', async () => {
  setStatus(statusEl, 'Testing…');
  try {
    await save();
    const resp = await chrome.runtime.sendMessage({ type: 'TA_TEST_PROVIDER' });
    if (!resp?.ok) throw new Error(resp?.error || 'Test failed');
    setStatus(statusEl, resp.message || 'OK');
  } catch (e) {
    setStatus(statusEl, e?.message || String(e));
  }
});

await load();
