import { setStatus } from './ui_shared.js';

const providerEl = document.getElementById('provider');
const baseUrlEl = document.getElementById('baseUrl');
const modelEl = document.getElementById('model');
const apiKeyEl = document.getElementById('apiKey');
const maxCharsEl = document.getElementById('maxChars');
const fastModeEl = document.getElementById('fastMode');
const presetEl = document.getElementById('preset');

const PRESETS = {
  ollama: {
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'llama3.2:3b',
    apiKey: ''
  },
  groq: {
    provider: 'openai_compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.1-8b-instant',
    apiKey: ''
  },
  openai: {
    provider: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: ''
  },
  lmstudio: {
    provider: 'openai_compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    apiKey: ''
  }
};
const saveBtn = document.getElementById('save');
const testBtn = document.getElementById('test');
const statusEl = document.getElementById('status');

const DEFAULTS = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'llama3.2:3b',
  apiKey: '',
  maxChars: 24000,
  fastMode: true
};

function currentSettings() {
  return {
    provider: providerEl.value,
    baseUrl: baseUrlEl.value.trim(),
    model: modelEl.value.trim(),
    apiKey: apiKeyEl.value,
    maxChars: Number(maxCharsEl.value),
    fastMode: fastModeEl.checked
  };
}

async function load() {
  const stored = await chrome.storage.sync.get(['ta_settings']);
  const s = { ...DEFAULTS, ...(stored.ta_settings || {}) };

  providerEl.value = s.provider;
  baseUrlEl.value = s.baseUrl;
  modelEl.value = s.model;
  apiKeyEl.value = s.apiKey || '';
  maxCharsEl.value = String(s.maxChars ?? DEFAULTS.maxChars);
  fastModeEl.checked = s.fastMode !== false;
}

async function save() {
  const s = currentSettings();
  await chrome.storage.sync.set({ ta_settings: s });
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

presetEl.addEventListener('change', () => {
  const p = PRESETS[presetEl.value];
  if (!p) return;
  providerEl.value = p.provider;
  baseUrlEl.value = p.baseUrl;
  modelEl.value = p.model;
  if (p.apiKey !== undefined && !apiKeyEl.value) apiKeyEl.value = p.apiKey;
});

await load();

