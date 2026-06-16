import { sendToActiveTab, setStatus } from './ui_shared.js';

const modeEl = document.getElementById('mode');
const levelEl = document.getElementById('level');
const adaptBtn = document.getElementById('adapt');
const statusEl = document.getElementById('status');

const WAIT_MSG = 'Пожалуйста, подождите';
const DONE_MSG = 'Готово';

function clipForMessaging(text, maxChars = 60000) {     
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n\n[CLIPPED_FOR_EXTENSION]';
}

adaptBtn.addEventListener('click', async () => {
  adaptBtn.disabled = true;
  setStatus(statusEl, WAIT_MSG);

  const onProgress = (msg) => {
    if (msg?.type === 'TA_PROGRESS') setStatus(statusEl, WAIT_MSG);
  };
  chrome.runtime.onMessage.addListener(onProgress);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab?.id;
    if (!tabId) throw new Error('Нет активной вкладки');

    const mode = modeEl.value;
    const level = levelEl.value;

    const extract = await sendToActiveTab(tabId, { type: 'TA_EXTRACT_TEXT', mode });
    if (!extract?.ok) throw new Error(extract?.error || 'Failed to extract text');

    setStatus(statusEl, WAIT_MSG);

    const resp = await chrome.runtime.sendMessage({
      type: 'TA_ADAPT_TEXT',
      payload: {
        url: extract.url,
        title: extract.title,
        text: clipForMessaging(extract.text),
        level,
        mode
      }
    });
    if (!resp?.ok) throw new Error(resp?.error || 'AI request failed');

    const apply = await sendToActiveTab(tabId, {
      type: 'TA_APPLY',
      payload: {
        adaptedText: resp.result.adaptedText,
        originalText: extract.text,
        level,
        mode,
        blocks: extract.blocks,
        truncated: resp.result.truncated,
        chunked: resp.result.chunked
      }
    });
    if (!apply?.ok) throw new Error(apply?.error || 'Could not show on page');

    setStatus(statusEl, DONE_MSG);
  } catch (e) {
    setStatus(statusEl, e?.message || String(e));
  } finally {
    chrome.runtime.onMessage.removeListener(onProgress);
    adaptBtn.disabled = false;
  }
});
