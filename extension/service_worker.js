const DEFAULT_SETTINGS = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'llama3.2:3b',
  apiKey: '',
  maxChars: 24000,
  cloudMaxChars: 4000,
  cloudChunkDelaySec: 0,
  fastMode: true
};

const MODEL_CACHE_TTL_MS = 60_000;
let modelCache = null;

function normalizeBaseUrl(url) {
  if (!url) return '';
  return url.replace(/\/+$/, '');
}

/** OpenAI-compatible URL — base may already end with /v1 (Groq, OpenAI). */
function openAIApiUrl(baseUrl, path) {
  const base = normalizeBaseUrl(baseUrl);
  const sub = path.replace(/^\//, '').replace(/^v1\//, '');
  if (base.endsWith('/v1')) return `${base}/${sub}`;
  return `${base}/v1/${sub}`;
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(['ta_settings']);
  const s = { ...DEFAULT_SETTINGS, ...(stored.ta_settings || {}) };
  return { ...s, baseUrl: normalizeBaseUrl(s.baseUrl) };
}

function levelInstruction(level) {
  switch (level) {
    case 'light':
      return (
        'Light: minimal edit only — fix awkward phrasing, split very long sentences. ' +
        'Keep terminology, facts, structure, and roughly the SAME length (do not summarize or shorten).'
      );
    case 'medium':
      return (
        'Medium: clearer wording, briefly explain 1-2 hardest terms if needed. ' +
        'Keep facts; length within ±15% of the original.'
      );
    case 'max':
      return (
        'Max: simplest words and short sentences (reading age 10-12), but be CONCISE — ' +
        'fewer words than the original where possible; no filler, no long analogies unless one short line saves many words. Keep facts.'
      );
    default:
      return 'Medium: simplify, explain key terms briefly, keep facts.';
  }
}

function buildPrompt({ title, text, level, fastMode }) {
  const instruction = levelInstruction(level);
  const preserveRule =
    'CRITICAL: Keep EVERY fact, date, name, number and event from the original — do not omit or skip paragraphs.';
  if (fastMode && text.length < 4000) {
    return [
      `Rewrite simpler (${instruction}). Same language. ${preserveRule} Output ONLY the rewrite:`,
      text
    ].join('\n\n');
  }
  return [
    'You are a careful assistant that rewrites text while preserving meaning and factual correctness.',
    `Task: adapt complexity. ${instruction}`,
    'Rules:',
    '- Do not invent facts.',
    preserveRule,
    '- Keep original language (if Russian, answer Russian; if English, answer English).',
    '- Output only the adapted text, no preamble.',
    '',
    title ? `Title: ${title}` : '',
    'Text:',
    text
  ]
    .filter(Boolean)
    .join('\n');
}

/** Cap generation — must fit full rewrite, not truncate tail paragraphs. */
function ollamaRunOptions(textLen, fastMode) {
  const estOutTokens = Math.ceil(textLen / 3) + 96;
  if (fastMode) {
    return {
      temperature: 0.15,
      num_predict: Math.min(4096, Math.max(256, Math.ceil(estOutTokens * 1.25))),
      num_ctx: Math.min(8192, Math.max(2048, Math.ceil((textLen + 500) / 3))),
      top_p: 0.9
    };
  }
  return {
    temperature: 0.2,
    num_predict: Math.min(8192, Math.max(512, Math.ceil(estOutTokens * 1.35))),
    num_ctx: Math.min(16384, Math.max(4096, Math.ceil((textLen + 800) / 3))),
    top_p: 0.9
  };
}

function estimateTokens(text) {
  return Math.ceil((text || '').length / 3);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Split by paragraphs so each chunk fits Groq ~6000 TPM per request. */
function splitTextIntoChunks(text, maxChunkChars) {
  if (!text || text.length <= maxChunkChars) return [text];

  const chunks = [];
  let current = '';
  const paragraphs = text.split(/\n\n+/);

  for (const raw of paragraphs) {
    const p = raw.trim();
    if (!p) continue;

    if (p.length > maxChunkChars) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < p.length; i += maxChunkChars) {
        chunks.push(p.slice(i, i + maxChunkChars));
      }
      continue;
    }

    const next = current ? `${current}\n\n${p}` : p;
    if (next.length <= maxChunkChars) {
      current = next;
    } else {
      chunks.push(current);
      current = p;
    }
  }

  if (current) chunks.push(current);
  return chunks.length ? chunks : [text.slice(0, maxChunkChars)];
}

function cloud413Hint() {
  return (
    'Groq отклонил запрос (слишком большой). Попробуйте снова или уменьшите Max chars в Options.'
  );
}

function simpleHash(str) {
  // Not cryptographic, only for caching key.
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function truncateByChars(text, maxChars) {
  if (!text) return '';
  if (!maxChars || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n\n[TRUNCATED]';
}

function ollama403Hint() {
  return [
    'Ollama blocked the request (HTTP 403 — CORS).',
    'Fix on Mac: quit Ollama (menu bar), then in Terminal run:',
    '  launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"',
    '  ollama serve',
    'Or one-shot: OLLAMA_ORIGINS="chrome-extension://*" ollama serve',
    'Then reload the extension and try Test connection again.'
  ].join(' ');
}

function networkErrorHint(e, baseUrl) {
  const msg = e?.message || String(e);
  if (e?.name === 'AbortError') return 'Ollama timeout (120s). Try Selection or a smaller page.';
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('ERR_CONNECTION_REFUSED')) {
    return `Cannot reach Ollama at ${baseUrl}. Start it: \`ollama serve\` then \`ollama pull llama3.1\` (or set model in Options).`;
  }
  return msg;
}

async function resolveOllamaModel(baseUrl, model) {
  try {
    const resp = await fetch(`${baseUrl}/api/tags`);
    if (!resp.ok) return model;
    const data = await resp.json();
    const names = (data?.models || []).map((m) => m.name).filter(Boolean);
    if (!names.length) return model;
    if (names.includes(model)) return model;
    const match =
      names.find((n) => n === model) ||
      names.find((n) => n.startsWith(`${model}:`)) ||
      names.find((n) => n.split(':')[0] === model);
    return match || model;
  } catch {
    return model;
  }
}

async function resolveOllamaModelCached(baseUrl, model) {
  const now = Date.now();
  if (
    modelCache?.baseUrl === baseUrl &&
    modelCache?.model === model &&
    now - modelCache.at < MODEL_CACHE_TTL_MS
  ) {
    return modelCache.resolved;
  }
  const resolved = await resolveOllamaModel(baseUrl, model);
  modelCache = { baseUrl, model, resolved, at: now };
  return resolved;
}

async function ollamaGenerate({ baseUrl, model, prompt, textLen, fastMode }) {
  const resolvedModel = await resolveOllamaModelCached(baseUrl, model);
  const url = `${baseUrl}/api/generate`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: resolvedModel,
        prompt,
        stream: false,
        keep_alive: '15m',
        options: ollamaRunOptions(textLen, fastMode)
      }),
      signal: controller.signal
    });
  } catch (e) {
    throw new Error(networkErrorHint(e, baseUrl));
  } finally {
    clearTimeout(timeout);
  }
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const err = await resp.json();
      detail = err?.error || detail;
    } catch {
      /* ignore */
    }
    if (resp.status === 403) throw new Error(ollama403Hint());
    if (resp.status === 404) {
      throw new Error(
        `Ollama model "${resolvedModel}" not found. Run: ollama pull ${model} (Options → Test connection lists models).`
      );
    }
    throw new Error(`Ollama HTTP ${resp.status}: ${detail}`);
  }
  const data = await resp.json();
  const out = (data?.response || '').trim();
  if (!out) throw new Error('Empty response from Ollama');
  return out;
}

function parseGroqWaitSeconds(detail) {
  const m = String(detail || '').match(/try again in ([\d.]+)s/i);
  if (m) return Math.ceil(parseFloat(m[1])) + 2;
  return 30;
}

function notifyProgress(payload) {
  chrome.runtime.sendMessage({ type: 'TA_PROGRESS', ...payload }).catch(() => {});
}

async function openAICompatibleGenerate({ baseUrl, apiKey, model, prompt, textLen }) {
  if (!apiKey) throw new Error('API key required for this provider (Options → API key).');
  const url = openAIApiUrl(baseUrl, 'chat/completions');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };

  const estOut = Math.min(800, Math.max(200, Math.ceil(textLen / 4) + 48));
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: estOut
  });

  for (let attempt = 0; attempt < 8; attempt++) {
    const resp = await fetch(url, { method: 'POST', headers, body });

    if (resp.status === 429) {
      let detail = resp.statusText;
      try {
        const err = await resp.json();
        detail = err?.error?.message || err?.error || detail;
      } catch {
        /* ignore */
      }
      const waitSec = parseGroqWaitSeconds(detail);
      notifyProgress({ wait: true, seconds: waitSec, attempt: attempt + 1 });
      await sleep(waitSec * 1000);
      continue;
    }

    if (!resp.ok) {
      let detail = resp.statusText;
      try {
        const err = await resp.json();
        detail = err?.error?.message || err?.error || detail;
      } catch {
        /* ignore */
      }
      throw new Error(
        resp.status === 413 ? cloud413Hint() : `Provider HTTP ${resp.status}: ${detail}`
      );
    }

    const data = await resp.json();
    const out = (data?.choices?.[0]?.message?.content || '').trim();
    if (!out) throw new Error('Empty response from provider');
    return out;
  }

  throw new Error(
    'Groq: слишком много запросов (лимит 6000 ток/мин). Подождите минуту или выделите меньший фрагмент.'
  );
}

async function adaptCloudInChunks({ settings, title, text, level, fastMode }) {
  const chunkSize = settings.cloudMaxChars ?? 4000;
  const chunks = splitTextIntoChunks(text, chunkSize);
  const parts = [];
  const pauseSec = settings.cloudChunkDelaySec ?? 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunkTitle =
      chunks.length > 1 && title ? `${title} (часть ${i + 1}/${chunks.length})` : title;
    const prompt = buildPrompt({ title: chunkTitle, text: chunks[i], level, fastMode });

    notifyProgress({ current: i + 1, total: chunks.length });

    const part = await openAICompatibleGenerate({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      prompt,
      textLen: chunks[i].length
    });
    parts.push(part);

    if (i < chunks.length - 1 && pauseSec > 0) {
      notifyProgress({ wait: true, seconds: pauseSec, between: true, current: i + 1, total: chunks.length });
      await sleep(pauseSec * 1000);
    }
  }

  return {
    adaptedText: parts.join('\n\n'),
    chunked: chunks.length > 1,
    chunkCount: chunks.length
  };
}

async function adaptText({ url, title, text, level, mode }) {
  const settings = await getSettings();
  const fastMode = settings.fastMode !== false;
  const clipped = truncateByChars(text, settings.maxChars);
  const truncated = clipped.length < text.length;

  const prompt = buildPrompt({ title, text: clipped, level, fastMode });
  const cacheKey = `ta_cache:${settings.provider}:${settings.baseUrl}:${settings.model}:${level}:${simpleHash(
    prompt
  )}`;

  const cached = await chrome.storage.session.get([cacheKey]);
  if (cached?.[cacheKey]) {
    return { ...cached[cacheKey], cached: true };
  }

  let adaptedText = '';
  let chunked = false;
  let chunkCount = 1;

  if (settings.provider === 'ollama') {
    adaptedText = await ollamaGenerate({
      baseUrl: settings.baseUrl,
      model: settings.model,
      prompt,
      textLen: clipped.length,
      fastMode
    });
  } else {
    const cloud = await adaptCloudInChunks({
      settings,
      title,
      text: clipped,
      level,
      fastMode
    });
    adaptedText = cloud.adaptedText;
    chunked = cloud.chunked;
    chunkCount = cloud.chunkCount;
  }

  const result = {
    url,
    title,
    level,
    provider: settings.provider,
    model: settings.model,
    adaptedText,
    truncated,
    chunked,
    chunkCount,
    createdAt: Date.now()
  };

  await chrome.storage.session.set({ [cacheKey]: result, ta_lastResult: result });
  return result;
}

async function testProvider() {
  const settings = await getSettings();
  if (settings.provider === 'ollama') {
    let resp;
    try {
      resp = await fetch(`${settings.baseUrl}/api/tags`);
    } catch (e) {
      throw new Error(networkErrorHint(e, settings.baseUrl));
    }
    if (resp.status === 403) throw new Error(ollama403Hint());
    if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
    const data = await resp.json();
    const models = Array.isArray(data?.models) ? data.models.map((m) => m.name).slice(0, 8) : [];
    const resolved = await resolveOllamaModelCached(settings.baseUrl, settings.model);
    const modelNote =
      resolved !== settings.model ? ` (resolved "${settings.model}" → "${resolved}")` : '';
    return `Ollama OK. Configured model: ${settings.model}${modelNote}. Available: ${
      models.join(', ') || '(none — run: ollama pull llama3.1)'
    }`;
  }

  // OpenAI-compatible: /v1/models or minimal chat ping
  if (!settings.apiKey) {
    throw new Error('Введите API key (для Groq: console.groq.com → API Keys).');
  }
  const headers = { authorization: `Bearer ${settings.apiKey}` };
  const resp = await fetch(openAIApiUrl(settings.baseUrl, 'models'), { headers });
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const err = await resp.json();
      detail = err?.error?.message || err?.error || detail;
    } catch {
      /* ignore */
    }
    throw new Error(`Provider HTTP ${resp.status}: ${detail}`);
  }
  const data = await resp.json();
  const models = (data?.data || []).map((m) => m.id).filter(Boolean).slice(0, 6);
  return `Provider OK. Model "${settings.model}". Available: ${models.join(', ') || '(see provider docs)'}`;
}

chrome.runtime.onInstalled.addListener(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'TA_ADAPT_TEXT') {
        const { url, title, text, level, mode } = msg.payload || {};
        if (!text) throw new Error('No text provided');
        const result = await adaptText({ url, title, text, level, mode });
        sendResponse({ ok: true, result });
        return;
      }

      if (msg?.type === 'TA_PUSH_RESULT') {
        const payload = msg.payload;
        await chrome.storage.session.set({ ta_lastResult: payload });
        chrome.runtime.sendMessage({ type: 'TA_SIDE_PANEL_RESULT', payload });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'TA_TEST_PROVIDER') {
        const message = await testProvider();
        sendResponse({ ok: true, message });
        return;
      }

      sendResponse({ ok: false, error: 'Unknown message type' });
    } catch (e) {
      const error = e?.message || String(e);
      chrome.runtime.sendMessage({ type: 'TA_SIDE_PANEL_ERROR', error });
      sendResponse({ ok: false, error });
    }
  })();
  return true;
});

