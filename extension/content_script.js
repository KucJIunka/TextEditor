if (globalThis.__TA_CONTENT_SCRIPT__) {
  // Already registered (auto-inject + on-demand inject).
} else {
  globalThis.__TA_CONTENT_SCRIPT__ = true;

function normalizeText(s) {
  return (s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clipForMessaging(text, maxChars = 60000) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n\n[CLIPPED_FOR_EXTENSION]';
}

const BLOCK_SELECTOR =
  'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, dt, dd, figcaption';

function getElement(node) {
  if (!node) return null;
  return node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
}

function getBlock(node) {
  const el = getElement(node);
  if (!el) return null;
  if (el.matches?.(BLOCK_SELECTOR)) return el;
  return el.closest?.(BLOCK_SELECTOR) || null;
}

function isLeafBlock(el) {
  if (!el?.matches?.('div')) return true;
  const text = (el.innerText || '').trim();
  if (!text) return false;
  return !el.querySelector(
    'article, section, main, p, ul, ol, table, blockquote, pre, [class*="paragraph"]'
  );
}

function getScopeForRange(range) {
  const common = range.commonAncestorContainer;
  const el = getElement(common);
  return (
    el?.closest?.('article, main, [role="main"], section, .content, .post, .article') ||
    el ||
    document.body
  );
}

function listBlocksInScope(scope) {
  const nodes = scope.querySelectorAll(`${BLOCK_SELECTOR}, div`);
  const blocks = [];
  for (const node of nodes) {
    if (node.matches('div') && !isLeafBlock(node)) continue;
    if (!(node.innerText || '').trim()) continue;
    blocks.push(node);
  }
  return blocks;
}

/** All block elements from first touched paragraph through last (nothing skipped in between). */
function blocksSpanningRange(range) {
  const startBlock = getBlock(range.startContainer);
  const endBlock = getBlock(range.endContainer);
  if (!startBlock || !endBlock) return null;

  const scope = getScopeForRange(range);
  const blocks = listBlocksInScope(scope);
  const si = blocks.indexOf(startBlock);
  const ei = blocks.indexOf(endBlock);
  if (si === -1 || ei === -1) return null;

  const lo = Math.min(si, ei);
  const hi = Math.max(si, ei);
  return blocks.slice(lo, hi + 1);
}

function textFromBlocks(blocks) {
  return normalizeText(blocks.map((b) => normalizeText(b.innerText || '')).filter(Boolean).join('\n\n'));
}

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'PRE',
  'TD',
  'TH',
  'DT',
  'DD',
  'FIGCAPTION',
  'BR',
  'HR',
  'TR'
]);

function extractTextWithBlockBreaks(root) {
  let out = '';
  const pushBreak = () => {
    if (!out) return;
    if (!out.endsWith('\n\n')) out += '\n\n';
  };

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent || '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (BLOCK_TAGS.has(tag) && tag !== 'BR' && tag !== 'HR') pushBreak();
    if (tag === 'BR' || tag === 'HR') pushBreak();
    for (const child of node.childNodes) walk(child);
    if (BLOCK_TAGS.has(tag) && tag !== 'BR' && tag !== 'HR') pushBreak();
  }

  walk(root);
  return normalizeText(out);
}

function extractRangeClone(range) {
  const host = document.createElement('div');
  host.appendChild(range.cloneContents());
  return extractTextWithBlockBreaks(host);
}

function extractFromRange(range) {
  const spanBlocks = blocksSpanningRange(range);
  if (spanBlocks?.length) {
    const spanText = textFromBlocks(spanBlocks);
    const cloneText = extractRangeClone(range);
    return spanText.length >= cloneText.length ? spanText : cloneText;
  }
  return extractRangeClone(range);
}

function extractSelection() {
  const sel = window.getSelection?.();
  if (!sel || sel.rangeCount === 0) return '';

  const parts = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    const part = extractFromRange(sel.getRangeAt(i));
    if (part) parts.push(part);
  }

  const merged = normalizeText(parts.join('\n\n'));
  if (merged) return merged;

  return normalizeText(sel.toString?.() || '');
}

function extractFromArticleLike() {
  const meta = extractWithBlocks('page');
  return meta?.text || '';
}

/** --- In-page overlay (ТЗ: показ на странице + возврат к оригиналу) --- */

let activeSession = null;

const LEVEL_LABELS = {
  light: 'Light',
  medium: 'Medium',
  max: 'Max'
};

function formatBadge(level) {
  const label = LEVEL_LABELS[level] || level || 'Medium';
  return `Text Adapter · ${label}`;
}

function clearSession() {
  if (!activeSession) return;
  for (const block of activeSession.blocks) {
    const el = document.querySelector(`[data-ta-block="${block.id}"]`);
    if (!el) continue;
    el.innerHTML = block.html;
    el.classList.remove('ta-hidden-source');
    el.removeAttribute('data-ta-block');
  }
  document.getElementById('text-adapter-root')?.remove();
  activeSession = null;
}

function stampBlocks(blockEls) {
  return blockEls.map((el, i) => {
    const id = `ta-${Date.now()}-${i}`;
    el.setAttribute('data-ta-block', id);
    return { id, el, html: el.innerHTML, text: (el.innerText || '').trim() };
  });
}

function getSelectionBlockEls() {
  const sel = window.getSelection?.();
  if (!sel?.rangeCount) return [];
  const range = sel.getRangeAt(0);
  const blocks = blocksSpanningRange(range);
  if (blocks?.length) return blocks;
  const one = getBlock(range.startContainer);
  return one ? [one] : [];
}

function getPageRoot() {
  return (
    document.querySelector('article') ||
    document.querySelector('main') ||
    document.querySelector('[role="main"]')
  );
}

function extractWithBlocks(mode) {
  if (mode === 'page') {
    const root = getPageRoot() || document.body;
    const stamped = stampBlocks([root]);
    const text = normalizeText(stamped[0].text);
    return { text, blocks: stamped.map(({ id, text: t }) => ({ id, text: t })) };
  }
  const blockEls = getSelectionBlockEls();
  if (!blockEls.length) return null;
  const stamped = stampBlocks(blockEls);
  const text = normalizeText(stamped.map((b) => b.text).filter(Boolean).join('\n\n'));
  return { text, blocks: stamped.map(({ id, text: t }) => ({ id, text: t })) };
}

function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderParagraphs(text) {
  return text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p class="ta-paragraph">${escapeHtml(p)}</p>`)
    .join('');
}

function setView(view) {
  if (!activeSession) return;
  activeSession.view = view;
  renderOverlayBody();
  updateToolbarActive();
}

function updateToolbarActive() {
  const root = document.getElementById('text-adapter-root');
  if (!root || !activeSession) return;
  root.querySelectorAll('[data-ta-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.taView === activeSession.view);
  });
}

function renderOverlayBody() {
  const root = document.getElementById('text-adapter-root');
  if (!root || !activeSession) return;
  const body = root.querySelector('.ta-body');
  const { view, originalText, adaptedText } = activeSession;

  if (view === 'compare') {
    body.innerHTML = `
      <div class="ta-compare">
        <div class="ta-col">
          <h4>Оригинал</h4>
          <div class="ta-text">${renderParagraphs(originalText)}</div>
        </div>
        <div class="ta-col">
          <h4>Адаптировано</h4>
          <div class="ta-text">${renderParagraphs(adaptedText)}</div>
        </div>
      </div>`;
    return;
  }

  const text = view === 'original' ? originalText : adaptedText;
  body.innerHTML = renderParagraphs(text);
}

function applyOnPage(payload) {
  clearSession();

  const { adaptedText, originalText, level, blocks } = payload;
  if (!adaptedText || !blocks?.length) throw new Error('Nothing to show on page');

  const resolvedBlocks = blocks
    .map((b) => {
      const el = document.querySelector(`[data-ta-block="${b.id}"]`);
      if (!el) return null;
      return { id: b.id, el, html: el.innerHTML, text: b.text };
    })
    .filter(Boolean);

  if (!resolvedBlocks.length) throw new Error('Could not find selected blocks on page');

  resolvedBlocks.forEach((b) => b.el.classList.add('ta-hidden-source'));

  const anchor = resolvedBlocks[0].el;
  const host = document.createElement('div');
  host.id = 'text-adapter-root';
  host.innerHTML = `
    <div class="ta-toolbar">
      <span class="ta-badge">${escapeHtml(formatBadge(level))}</span>
      <button type="button" class="ta-btn" data-ta-view="original">Оригинал</button>
      <button type="button" class="ta-btn active" data-ta-view="adapted">Адаптировано</button>
      <button type="button" class="ta-btn" data-ta-view="compare">Сравнение</button>
      <button type="button" class="ta-btn ta-close" data-ta-action="close">Вернуть как было</button>
    </div>
    <div class="ta-body"></div>`;

  anchor.parentNode?.insertBefore(host, anchor);

  host.querySelectorAll('[data-ta-view]').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.taView));
  });
  host.querySelector('[data-ta-action="close"]')?.addEventListener('click', clearSession);

  activeSession = {
    blocks: resolvedBlocks,
    originalText: originalText || resolvedBlocks.map((b) => b.text).join('\n\n'),
    adaptedText,
    level,
    view: 'adapted',
    truncated: payload.truncated
  };

  renderOverlayBody();
  host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'TA_EXTRACT_TEXT') {
    try {
      const mode = msg.mode;
      const title = document.title || '';
      const url = location.href;
      const meta = extractWithBlocks(mode);
      const text = clipForMessaging(meta?.text || '');
      if (!text || text.length < 30) {
        sendResponse({
          ok: false,
          error:
            mode === 'selection'
              ? 'Selection is empty (or too short). Try Whole page.'
              : 'Could not extract enough text from this page.'
        });
        return;
      }
      sendResponse({ ok: true, text, title, url, blocks: meta.blocks });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
    return;
  }

  if (msg?.type === 'TA_APPLY') {
    try {
      applyOnPage(msg.payload || {});
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
    return;
  }

  if (msg?.type === 'TA_RESTORE') {
    clearSession();
    sendResponse({ ok: true });
    return;
  }

  return true;
});

} // __TA_CONTENT_SCRIPT__

