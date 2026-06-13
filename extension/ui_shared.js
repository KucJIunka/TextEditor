const RESTRICTED_PREFIXES = ['chrome:', 'chrome-extension:', 'edge:', 'about:', 'devtools:', 'view-source:'];

export function isInjectableUrl(url) {
  if (!url) return false;
  return !RESTRICTED_PREFIXES.some((p) => url.startsWith(p));
}

export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  return tab;
}

export async function getActiveTabId() {
  return (await getActiveTab()).id;
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content_script.js']
  });
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content_script.css']
    });
  } catch {
    /* css may already be present from manifest */
  }
}

export async function sendToActiveTab(tabId, message) {
  const tab = await chrome.tabs.get(tabId);
  if (!isInjectableUrl(tab.url)) {
    throw new Error(
      'This page cannot be read (browser internal page, PDF viewer, etc.). Open a normal website.'
    );
  }

  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await injectContentScript(tabId);
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

export function setStatus(el, text) {
  el.textContent = text || '';
}
