/**
 * background.js  –  Bookmark Smart Search  –  MV3 Service Worker
 *
 * NOTE: MV3 service workers ONLY support static top-level imports.
 *       dynamic import() is forbidden by spec – do not use it here.
 *
 * Embedding engine: lib/embedder.js (all-MiniLM-L6-v2 via transformers.js).
 * The model is downloaded once on first scan and cached by the browser.
 */

// ── Static imports (only allowed form in MV3 service workers) ────────────────
import { initEmbedder, generateEmbedding, SEMANTIC_MODE } from './lib/embedder.js';

// ── Constants ────────────────────────────────────────────────────────────────
const DB_NAME         = 'bookmark_ai_db';
const DB_VERSION      = 1;
const STORE           = 'bookmarks';
const FETCH_TIMEOUT   = 10_000;   // ms
const MAX_HTML_BYTES  = 60_000;   // bytes read per page
const SKIP_SCHEMES    = /^(javascript:|chrome:|chrome-extension:|about:|data:|blob:)/i;
// Hosts that reliably block cross-origin fetches from extensions (CORS / auth walls)
const SKIP_HOSTS      = /^(chrome\.google\.com|chromewebstore\.google\.com|accounts\.google\.com|mail\.google\.com|drive\.google\.com|docs\.google\.com|login\.microsoftonline\.com|appleid\.apple\.com)$/i;
const BOT_TITLES      = /^(just a moment|attention required|access denied|checking your browser|enable javascript|ddos protection|security check)/i;
const DEBUG           = false;

// Matches loopback, link-local, and RFC-1918 private hostnames/IPs.
const PRIVATE_HOST = /^(localhost|.*\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})$/i;

function isPrivateUrl(url) {
  try {
    const host = new URL(url).hostname;
    return PRIVATE_HOST.test(host);
  } catch {
    return false;
  }
}

// ── IndexedDB ────────────────────────────────────────────────────────────────
let db = null;

// In-memory cache of all bookmark records — avoids a full IndexedDB read on
// every search. Invalidated by any write (txPut / txDelete / RESCAN).
let bookmarkCache = null;

function invalidateCache() { bookmarkCache = null; }

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE)) {
        const store = d.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('url',   'url',   { unique: true  });
        store.createIndex('title', 'title', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function getDB() {
  if (!db) db = await openDB();
  return db;
}

function txGet(id) {
  return getDB().then(d => new Promise((res, rej) => {
    const r = d.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  }));
}

function txPut(record) {
  invalidateCache();
  return getDB().then(d => new Promise((res, rej) => {
    const r = d.transaction(STORE, 'readwrite').objectStore(STORE).put(record);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  }));
}

function txDelete(id) {
  invalidateCache();
  return getDB().then(d => new Promise((res, rej) => {
    const r = d.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error);
  }));
}

function txGetAll() {
  return getDB().then(d => new Promise((res, rej) => {
    const r = d.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  }));
}

/** URL-index duplicate check */
async function existsByUrl(url) {
  const d = await getDB();
  return new Promise((res, rej) => {
    const idx = d.transaction(STORE, 'readonly').objectStore(STORE).index('url');
    const r   = idx.getKey(url);
    r.onsuccess = () => res(r.result != null);
    r.onerror   = () => rej(r.error);
  });
}

// ── Page metadata fetching ───────────────────────────────────────────────────
async function fetchMeta(url) {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);

    const resp  = await fetch(url, {
      signal     : ctrl.signal,
      headers    : {
        Accept          : 'text/html,application/xhtml+xml',
        'User-Agent'    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      credentials: 'omit',
    });
    clearTimeout(timer);

    if (!resp.ok) return { fetchError: resp.status };
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('text/html') && !ct.includes('xhtml')) return null;

    // Read only the first MAX_HTML_BYTES to save memory
    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let   html    = '';
    let   total   = 0;

    while (total < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html  += decoder.decode(value, { stream: true });
      total += value.byteLength;
    }
    reader.cancel().catch(() => {});

    return parseMeta(html);
  } catch {
    clearTimeout(timer);
    return { fetchError: 'network' };
  }
}

function parseMeta(html) {
  const tm    = html.match(/<title[^>]*>([\s\S]{0,500}?)<\/title>/i);
  const title = tm ? htmlDecode(tm[1].trim()) : '';

  // Discard bot-challenge pages (Cloudflare, etc.)
  if (title && BOT_TITLES.test(title)) return { title: '', metadata: '' };

  const parts  = [];
  const metaRe = /<meta\s([^>]{0,1000})>/gi;
  let   m;

  while ((m = metaRe.exec(html)) !== null) {
    const a      = m[1];
    const isName = /\bname\s*=\s*["']?(description|keywords|author)["']?(?:\s|>|\/)/i.test(a);
    const isProp = /\bproperty\s*=\s*["']?(og:(?:title|description|site_name)|twitter:(?:title|description))["']?(?:\s|>|\/)/i.test(a);
    if (isName || isProp) {
      // Match quoted or unquoted content attribute values
      const dq  = a.match(/\bcontent\s*=\s*"([^"]*)"/i);
      const sq  = a.match(/\bcontent\s*=\s*'([^']*)'/i);
      const uq  = a.match(/\bcontent\s*=\s*([^"'\s>][^\s>]*)/i);
      const val = dq?.[1] ?? sq?.[1] ?? uq?.[1];
      if (val) parts.push(htmlDecode(val));
    }
  }

  // Fallback: extract visible body text for SPAs where meta tags are JS-injected
  if (!parts.length) {
    const bodyM = html.match(/<body[^>]*>([\s\S]{0,4000})/i);
    if (bodyM) {
      const bodyText = bodyM[1]
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
      if (bodyText) parts.push(bodyText);
    }
  }

  return { title, metadata: parts.join('. ') };
}

function htmlDecode(s) {
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g,    (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// ── Process one bookmark ─────────────────────────────────────────────────────
async function processBookmark(bm) {
  const { id, url, title, dateAdded } = bm;

  if (!url || SKIP_SCHEMES.test(url) || isPrivateUrl(url)) {
    return { ok: false, reason: 'invalid_url' };
  }

  // Skip hosts known to block extension fetches with CORS errors
  try {
    const host = new URL(url).hostname;
    if (SKIP_HOSTS.test(host)) return { ok: false, reason: 'cors_skip' };
  } catch { return { ok: false, reason: 'invalid_url' }; }

  // Duplicate by bookmark-id
  if (await txGet(id)) return { ok: true, duplicate: true };

  // Duplicate by URL (same page bookmarked under different ids)
  if (await existsByUrl(url)) return { ok: true, duplicate: true };

  const meta      = await fetchMeta(url);

  // fetchMeta signals a fetch error (404, network, etc.)
  if (meta?.fetchError) {
    return { ok: false, reason: meta.fetchError === 404 ? '404' : String(meta.fetchError) };
  }

  const pageTitle = meta?.title    || title || '';
  const metadata  = meta?.metadata || '';

  const embText = [pageTitle || title, metadata, url]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  let embedding = [];
  try {
    embedding = await generateEmbedding(embText);
  } catch (e) {
    if (DEBUG) console.warn('[BSS] embedding failed', url, e.message);
  }

  await txPut({
    id,
    url,
    title    : pageTitle || title || url,
    metadata,
    embedding,
    createdAt: dateAdded || Date.now(),
  });

  return { ok: true, hadMeta: !!meta };
}

// ── Flatten Chrome bookmark tree ─────────────────────────────────────────────
function flattenTree(nodes) {
  const list = [];
  const walk = (n) => {
    if (n.url) list.push(n);
    if (n.children) n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return list;
}

// ── Popup port (keep SW alive + stream progress) ─────────────────────────────
let popupPort = null;

function broadcast(msg) {
  if (!popupPort) return;
  try { popupPort.postMessage(msg); } catch { popupPort = null; }
}

function saveStatus(data) {
  chrome.storage.local.set({ scanStatus: data });
  broadcast({ type: 'SCAN_PROGRESS', ...data });
}

// ── Full scan ────────────────────────────────────────────────────────────────
async function runInitialScan() {
  const { scanStatus } = await chrome.storage.local.get('scanStatus');
  if (scanStatus?.status === 'scanning') return;

  const tree  = await chrome.bookmarks.getTree();
  const all   = flattenTree(tree);
  const total = all.length;

  // Phase 1: init embedder (may download model if semantic mode)
  saveStatus({
    status: 'scanning', phase: 'loading_model',
    progress: 0, current: 0, total,
    successful: 0, failed: [],
    semanticMode: SEMANTIC_MODE,
  });

  try {
    await initEmbedder();
  } catch (e) {
    saveStatus({ status: 'error', error: 'Failed to load embedding model: ' + e.message });
    return;
  }

  // Phase 2: process bookmarks
  let successful = 0;
  const failed   = [];

  for (let i = 0; i < all.length; i++) {
    const bm = all[i];
    try {
      const res = await processBookmark(bm);
      if (res.ok && !res.duplicate) successful++;
      else if (!res.ok && res.reason !== 'invalid_url' && res.reason !== 'cors_skip')
        failed.push({ id: bm.id, url: bm.url, title: bm.title || bm.url, reason: res.reason });
    } catch (e) {
      failed.push({ id: bm.id, url: bm.url, title: bm.title || bm.url, reason: e.message });
    }

    const progress = Math.round(((i + 1) / total) * 100);
    saveStatus({
      status: 'scanning', phase: 'scanning',
      progress, current: i + 1, total,
      successful, failed,
      currentUrl: bm.url,
      semanticMode: SEMANTIC_MODE,
    });

    // Small yield every 5 bookmarks to avoid watchdog timeouts
    if (i % 5 === 4) await new Promise(r => setTimeout(r, 15));
  }

  saveStatus({
    status: 'complete', progress: 100,
    total, successful, failed,
    semanticMode: SEMANTIC_MODE,
  });
}

// ── Search ───────────────────────────────────────────────────────────────────
function cosineSim(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, mA = 0, mB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    mA  += a[i] * a[i];
    mB  += b[i] * b[i];
  }
  const d = Math.sqrt(mA) * Math.sqrt(mB);
  return d === 0 ? 0 : dot / d;
}

async function searchBookmarks(query) {
  const queryL = query.toLowerCase().trim();
  const words  = queryL.split(/\s+/).filter(Boolean);

  let qVec = null;
  try { qVec = await generateEmbedding(queryL); } catch { /* keyword-only fallback */ }

  if (!bookmarkCache) bookmarkCache = await txGetAll();
  const results = [];

  for (const bm of bookmarkCache) {
    const titleL = (bm.title    || '').toLowerCase();
    const urlL   = (bm.url      || '').toLowerCase();
    const metaL  = (bm.metadata || '').toLowerCase();

    // Full-text: ALL query words must appear somewhere in the field
    const titleHit = words.every(w => titleL.includes(w));
    const urlHit   = words.every(w => urlL.includes(w));
    const metaHit  = words.every(w => metaL.includes(w));

    const sem     = (qVec && bm.embedding?.length) ? cosineSim(qVec, bm.embedding) : 0;
    const kwScore = (titleHit ? 0.45 : 0) + (urlHit ? 0.2 : 0) + (metaHit ? 0.1 : 0);
    const combined = Math.max(sem, kwScore);
    const kwHit   = titleHit || urlHit || metaHit;

    if (sem >= 0.35 || kwHit) {
      results.push({
        id: bm.id, url: bm.url, title: bm.title,
        score: combined, semScore: sem, titleHit,
        kwHit, semHit: sem >= 0.35,
      });
    }
  }

  return results
    .sort((a, b) => {
      if (a.titleHit && !b.titleHit) return -1;
      if (!a.titleHit && b.titleHit) return  1;
      return b.score - a.score;
    })
    .slice(0, 25);
}

// ── Port / message handler ───────────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  popupPort = port;

  // Heartbeat keeps the SW alive while popup is open
  const beat = setInterval(() => {
    try { port.postMessage({ type: 'PING' }); }
    catch { clearInterval(beat); }
  }, 20_000);

  port.onDisconnect.addListener(() => {
    popupPort = null;
    clearInterval(beat);
  });

  port.onMessage.addListener(async (msg) => {
    switch (msg.type) {

      case 'GET_STATUS': {
        const { scanStatus } = await chrome.storage.local.get('scanStatus');
        port.postMessage({ type: 'STATUS', ...(scanStatus || { status: 'idle' }) });
        break;
      }

      case 'START_SCAN':
        runInitialScan().catch(e => { if (DEBUG) console.error(e); });
        port.postMessage({ type: 'SCAN_STARTED' });
        break;

      case 'SEARCH': {
        try {
          const results = await searchBookmarks(msg.query);
          port.postMessage({ type: 'SEARCH_RESULTS', results, query: msg.query });
        } catch (e) {
          port.postMessage({ type: 'SEARCH_ERROR', error: e.message });
        }
        break;
      }

      case 'RETRY_FAILED': {
        const { scanStatus } = await chrome.storage.local.get('scanStatus');
        const failed = scanStatus?.failed || [];
        if (!failed.length) { port.postMessage({ type: 'RETRY_DONE', resolved: 0 }); break; }

        port.postMessage({ type: 'RETRY_STARTED', total: failed.length });
        await initEmbedder();

        const stillFailed = [];
        let resolved = 0;

        for (let i = 0; i < failed.length; i++) {
          const f = failed[i];
          port.postMessage({ type: 'RETRY_PROGRESS', current: i + 1, total: failed.length, resolved });

          // Re-fetch the bookmark from Chrome to get current state
          let bm = null;
          try { [bm] = await chrome.bookmarks.get(f.id); } catch { /* deleted */ }

          if (!bm?.url) { stillFailed.push(f); continue; }

          const meta = await fetchMeta(bm.url);
          if (meta?.fetchError) {
            stillFailed.push({ ...f, reason: String(meta.fetchError) });
            continue;
          }

          const pageTitle = meta?.title    || bm.title || '';
          const metadata  = meta?.metadata || '';
          const embText   = [pageTitle, metadata, bm.url].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

          let embedding = [];
          try { embedding = await generateEmbedding(embText); } catch { /* keep empty */ }

          await txPut({
            id       : bm.id,
            url      : bm.url,
            title    : pageTitle || bm.title || bm.url,
            metadata,
            embedding,
            createdAt: bm.dateAdded || Date.now(),
          });
          resolved++;
        }

        const updated = {
          ...scanStatus,
          successful: (scanStatus.successful || 0) + resolved,
          failed    : stillFailed,
        };
        chrome.storage.local.set({ scanStatus: updated });
        port.postMessage({ type: 'RETRY_DONE', resolved, remaining: stillFailed.length, status: updated });
        break;
      }

      case 'CLEAR_FAILED': {
        const { scanStatus } = await chrome.storage.local.get('scanStatus');
        const updated = { ...scanStatus, failed: [] };
        chrome.storage.local.set({ scanStatus: updated });
        port.postMessage({ type: 'CLEAR_DONE', status: updated });
        break;
      }

      case 'RESCAN': {
        // Close open connection before wiping IndexedDB
        if (db) { db.close(); db = null; }
        await new Promise((res, rej) => {
          const r = indexedDB.deleteDatabase(DB_NAME);
          r.onsuccess = res; r.onerror = rej;
          r.onblocked = () => res();  // proceed even if blocked
        });
        await chrome.storage.local.remove('scanStatus');
        invalidateCache();
        runInitialScan().catch(e => { if (DEBUG) console.error(e); });
        port.postMessage({ type: 'SCAN_STARTED' });
        break;
      }
    }
  });
});

// ── Bookmark event listeners ─────────────────────────────────────────────────
chrome.bookmarks.onCreated.addListener(async (_id, bookmark) => {
  if (!bookmark.url) return;
  try {
    await initEmbedder();
    await getDB();
    const res = await processBookmark(bookmark);
    if (res.ok && !res.duplicate) {
      const { scanStatus } = await chrome.storage.local.get('scanStatus');
      if (scanStatus?.status === 'complete') {
        const updated = { ...scanStatus, successful: (scanStatus.successful || 0) + 1 };
        chrome.storage.local.set({ scanStatus: updated });
        broadcast({ type: 'SCAN_PROGRESS', ...updated });
      }
    }
  } catch (e) {
    if (DEBUG) console.error('[BSS] onCreated:', e);
  }
});

chrome.bookmarks.onChanged.addListener(async (id, changeInfo) => {
  try {
    const [bm] = await chrome.bookmarks.get(id);
    if (!bm?.url) return;
    await initEmbedder();

    const existing = await txGet(id);
    if (existing) {
      const newTitle = bm.title || existing.title || bm.url;
      const newUrl   = bm.url  || existing.url;
      const embText = [newTitle, existing.metadata || '', newUrl]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

      let embedding = existing.embedding || [];
      try {
        embedding = await generateEmbedding(embText);
      } catch (e) {
        if (DEBUG) console.warn('[BSS] embedding failed', newUrl, e.message);
      }

      await txPut({ ...existing, title: newTitle, url: newUrl, embedding });
    } else {
      await processBookmark(bm);
    }
  } catch (e) {
    if (DEBUG) console.error('[BSS] onChanged:', e);
  }
});

chrome.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  try {
    // Collect all bookmark IDs in the removed subtree (handles folder deletion)
    const ids = [];
    const walk = (node) => {
      if (node.url) ids.push(node.id);
      if (node.children) node.children.forEach(walk);
    };
    walk(removeInfo.node);
    // Also try the top-level id in case node has no url (plain folder)
    if (!ids.length) ids.push(id);

    await getDB();
    let removed = 0;
    for (const rid of ids) {
      const exists = await txGet(rid);
      if (exists) { await txDelete(rid); removed++; }
    }

    if (removed > 0) {
      const { scanStatus } = await chrome.storage.local.get('scanStatus');
      if (scanStatus?.status === 'complete') {
        const updated = { ...scanStatus, successful: Math.max(0, (scanStatus.successful || 0) - removed) };
        chrome.storage.local.set({ scanStatus: updated });
        broadcast({ type: 'SCAN_PROGRESS', ...updated });
      }
    }
  } catch (e) {
    if (DEBUG) console.error('[BSS] onRemoved:', e);
  }
});

// ── Install hook ─────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    getDB().then(() => runInitialScan()).catch(e => { if (DEBUG) console.error(e); });
  }
});

// Warm up DB every time the SW starts
getDB().catch(e => { if (DEBUG) console.error(e); });
