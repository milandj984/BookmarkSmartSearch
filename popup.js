/**
 * popup.js  –  Smart Bookmark
 *
 * Flow
 * ────
 * 1. Connect a long-lived port to the background service worker
 * 2. Ask for current status (idle / scanning / complete)
 * 3. Render the right view
 * 4. While scanning: update progress bar in real-time from SW messages
 * 5. After scan complete: show summary + flip to search view
 * 6. Search: debounce input → send SEARCH message → render results
 */

'use strict';

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const views = {
  loading  : $('view-loading'),
  idle     : $('view-idle'),
  scan     : $('view-scan'),
  search   : $('view-search'),
  error    : $('view-error'),
};

// ── View switching ────────────────────────────────────────────────────────────
function showView(name) {
  Object.entries(views).forEach(([k, el]) => {
    el.classList.toggle('hidden', k !== name);
  });
  if (name === 'search') $('search-input').focus();
}

// ── Port to background SW ─────────────────────────────────────────────────────
let port = null;

function connectPort() {
  port = chrome.runtime.connect({ name: 'popup' });
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    // SW was killed – try to reconnect once
    setTimeout(() => {
      connectPort();
      askStatus();
    }, 300);
  });
}

function send(msg) {
  if (port) try { port.postMessage(msg); } catch { /* ignore */ }
}

function askStatus() {
  send({ type: 'GET_STATUS' });
  send({ type: 'GET_USER' });
}

// ── Message router ────────────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'STATUS':
    case 'SCAN_PROGRESS':
      handleStatus(msg);
      break;
    case 'SCAN_STARTED':
      showView('scan');
      break;
    case 'SEARCH_RESULTS':
      renderResults(msg.results, msg.query);
      break;
    case 'SEARCH_ERROR':
      showHint('results-empty', 'Search error: ' + msg.error);
      break;
    case 'RETRY_STARTED':
      $('btn-retry-failed').textContent = '↻ Retrying…';
      $('btn-retry-failed').disabled = true;
      $('btn-clear-failed').disabled = true;
      $('retry-progress-fill').style.width = '0%';
      $('retry-progress-label').textContent = `0 / ${msg.total}`;
      $('retry-progress-wrap').classList.remove('hidden');
      break;
    case 'RETRY_PROGRESS': {
      const pct = Math.round((msg.current / msg.total) * 100);
      $('retry-progress-fill').style.width = pct + '%';
      $('retry-progress-label').textContent = `${msg.current} / ${msg.total}`;
      break;
    }
    case 'RETRY_DONE':
      $('retry-progress-wrap').classList.add('hidden');
      $('btn-retry-failed').textContent = '↻ Retry all';
      $('btn-retry-failed').disabled = false;
      $('btn-clear-failed').disabled = false;
      if (msg.status) updateSearchStats(msg.status);
      break;
    case 'CLEAR_DONE':
      if (msg.status) updateSearchStats(msg.status);
      break;
    case 'USER':
      renderPlanBadge(msg.user);
      break;
    case 'PING':
      /* keep-alive – ignore */
      break;
  }
}

// ── Status / progress rendering ───────────────────────────────────────────────
function handleStatus(s) {
  switch (s.status) {
    case 'idle':
      showView('idle');
      break;

    case 'scanning':
      showView('scan');
      updateScanView(s);
      break;

    case 'complete':
      updateSearchStats(s);
      showView('search');
      break;

    case 'error':
      $('error-msg').textContent = s.error || 'Unknown error';
      showView('error');
      break;

    default:
      // Should not happen, but show idle
      showView('idle');
  }
}

function updateScanView(s) {
  const phase = s.phase === 'loading_model'
    ? '🧠 Loading AI model…'
    : '🔖 Indexing bookmarks…';
  $('scan-phase-label').textContent = phase;
  $('progress-fill').style.width   = (s.progress || 0) + '%';
  $('progress-count').textContent  = `${s.current || 0} / ${s.total || 0}`;
  $('progress-pct').textContent    = (s.progress || 0) + '%';

  const failed = s.failed?.length || 0;
  const counts = failed
    ? `✅ ${s.successful || 0} indexed  ·  ⚠️ ${failed} failed`
    : `✅ ${s.successful || 0} indexed so far`;
  const urlLine = s.currentUrl ? `\n${s.currentUrl}` : '';
  $('scan-live-status').textContent = counts + urlLine;
}

function updateSearchStats(s) {
  $('search-stat-success').textContent = s.successful || 0;
  $('search-stats').classList.remove('hidden');

  const limitNotice = $('stats-limit-notice');
  if (s.limitReached) {
    limitNotice.textContent = `⚠️ Free plan: ${s.indexCap} bookmark limit reached`;
    limitNotice.classList.remove('hidden');
  } else {
    limitNotice.classList.add('hidden');
  }

  const failedList = s.failed || [];
  const failedBtn  = $('btn-show-failed');
  $('search-stat-failed').textContent = failedList.length;

  if (failedList.length) {
    failedBtn.classList.remove('hidden');
    // Rebuild failed panel list
    const ul = $('failed-panel-list');
    ul.innerHTML = '';
    failedList.forEach(f => {
      const li  = document.createElement('li');
      const a   = document.createElement('a');
      a.href        = f.url || '#';
      a.target      = '_blank';
      a.rel         = 'noopener noreferrer';
      a.textContent = f.title || f.url || '(unknown)';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (f.url) chrome.tabs.create({ url: f.url });
      });
      const reason = document.createElement('span');
      reason.className   = 'failed-reason';
      reason.textContent = f.reason ? `HTTP ${f.reason}` : 'network error';
      const delBtn = document.createElement('button');
      delBtn.className   = 'btn-delete-failed';
      delBtn.title       = 'Delete bookmark';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', () => {
        delBtn.disabled = true;
        send({ type: 'DELETE_BOOKMARK', id: f.id });
      });
      li.appendChild(a);
      li.appendChild(reason);
      li.appendChild(delBtn);
      ul.appendChild(li);
    });
  } else {
    failedBtn.classList.add('hidden');
    $('failed-panel').classList.add('hidden');
  }
}

// ── Search ────────────────────────────────────────────────────────────────────
let searchTimer = null;

function handleSearchInput() {
  const raw = $('search-input').value.trim();
  const q   = raw.slice(0, 512);
  $('btn-clear-search').classList.toggle('hidden', !q);

  clearTimeout(searchTimer);

  if (!q) {
    showHint('results-hint');
    return;
  }

  $('results-hint').classList.add('hidden');
  $('results-empty').classList.add('hidden');
  $('results-list').classList.add('hidden');
  $('results-searching').classList.remove('hidden');

  searchTimer = setTimeout(() => {
    send({ type: 'SEARCH', query: q });
  }, 500);
}

function showHint(id, text) {
  ['results-hint', 'results-searching', 'results-empty', 'results-list']
    .forEach(n => $(n).classList.add('hidden'));
  const el = $(id);
  if (text) el.textContent = text;
  el.classList.remove('hidden');
}

function renderResults(results, _query) {
  $('results-searching').classList.add('hidden');

  if (!results || results.length === 0) {
    showHint('results-empty');
    return;
  }

  const list = $('results-list');
  list.innerHTML = '';

  results.forEach(r => {
    const li   = document.createElement('li');
    const a    = document.createElement('a');
    a.className = 'result-item';
    a.href      = r.url;
    a.target    = '_blank';
    a.rel       = 'noopener noreferrer';

    // Prevent default and use chrome.tabs.create for clean popup close behaviour
    a.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: r.url });
      window.close();
    });

    // Favicon
    const faviconWrap = document.createElement('div');
    faviconWrap.className = 'result-favicon-placeholder';
    faviconWrap.textContent = '🔖';

    const favicon = document.createElement('img');
    favicon.className = 'result-favicon';
    const host = (() => {
      try { return new URL(r.url).origin; } catch { return ''; }
    })();
    if (host) {
      favicon.src = `${host}/favicon.ico`;
      favicon.onerror = () => {
        favicon.remove();
        faviconWrap.textContent = '🔖';
      };
      favicon.onload = () => {
        faviconWrap.textContent = '';
        faviconWrap.appendChild(favicon);
      };
    }
    a.appendChild(faviconWrap);

    // Text body
    const body  = document.createElement('div');
    body.className = 'result-body';

    const titleEl = document.createElement('div');
    titleEl.className   = 'result-title';
    titleEl.textContent = r.title || r.url;

    const urlEl = document.createElement('div');
    urlEl.className   = 'result-url';
    urlEl.textContent = prettifyUrl(r.url);

    body.appendChild(titleEl);
    body.appendChild(urlEl);
    a.appendChild(body);

    // Match-type badges
    const badgeWrap = document.createElement('div');
    badgeWrap.className = 'result-badges';
    if (r.kwHit) {
      const b = document.createElement('span');
      b.className   = 'badge badge-kw';
      b.textContent = 'KW';
      b.title       = 'Keyword match';
      badgeWrap.appendChild(b);
    }
    if (r.semHit) {
      const b = document.createElement('span');
      b.className   = 'badge badge-sem';
      b.textContent = 'AI';
      b.title       = 'Semantic match';
      badgeWrap.appendChild(b);
    }
    if (badgeWrap.hasChildNodes()) a.appendChild(badgeWrap);

    li.appendChild(a);
    list.appendChild(li);
  });

  list.classList.remove('hidden');
}

function prettifyUrl(url) {
  try {
    const u = new URL(url);
    let s = u.hostname.replace(/^www\./, '');
    if (u.pathname && u.pathname !== '/') s += u.pathname;
    return s;
  } catch {
    return url;
  }
}

// ── Plan badge ───────────────────────────────────────────────────────────────
function renderPlanBadge(user) {
  const badge = $('plan-badge');
  if (!user) { badge.classList.add('hidden'); return; }

  const plan = user.subscription_plan || 'free';
  const isPaid = plan !== 'free';

  // Check expiry for paid plans
  const expired = isPaid && user.valid_until && new Date(user.valid_until) < new Date();
  const label   = expired ? 'Expired' : plan.charAt(0).toUpperCase() + plan.slice(1);

  badge.textContent = label;
  badge.className   = 'plan-badge' + (isPaid && !expired ? ' plan-badge--paid' : '');
  if (expired) badge.classList.add('plan-badge--expired');
  badge.title = isPaid && user.valid_until
    ? `Valid until ${new Date(user.valid_until).toLocaleDateString()}`
    : '';
}


document.addEventListener('DOMContentLoaded', () => {
  // Connect to background
  connectPort();

  // Ask for current state
  setTimeout(askStatus, 50);

  // Idle view: start scan button
  $('btn-start-scan').addEventListener('click', () => {
    showView('scan');
    updateScanView({ phase: 'loading_model', progress: 0, current: 0, total: 0, successful: 0 });
    send({ type: 'START_SCAN' });
  });

  // Header rescan button
  $('btn-rescan').addEventListener('click', () => {
    if (!confirm('Re-index all bookmarks? This will clear the existing index.')) return;
    showView('scan');
    updateScanView({ phase: 'loading_model', progress: 0, current: 0, total: 0, successful: 0 });
    send({ type: 'RESCAN' });
    // After rescan also reset search UI
    $('search-input').value = '';
    $('results-list').innerHTML = '';
    showHint('results-hint');
  });

  // Failed panel toggle
  $('btn-show-failed').addEventListener('click', () => {
    const panel = $('failed-panel');
    const open  = panel.classList.toggle('hidden');
    $('btn-show-failed').innerHTML =
      `⚠️ <strong id="search-stat-failed">${$('search-stat-failed').textContent}</strong> failed ${open ? '▾' : '▴'}`;
  });

  // Retry failed bookmarks
  $('btn-retry-failed').addEventListener('click', () => {
    send({ type: 'RETRY_FAILED' });
  });

  // Clear failed list
  $('btn-clear-failed').addEventListener('click', () => {
    send({ type: 'CLEAR_FAILED' });
  });

  // Search input
  $('search-input').addEventListener('input', handleSearchInput);
  $('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('search-input').value = '';
      handleSearchInput();
    }
  });

  // Clear button
  $('btn-clear-search').addEventListener('click', () => {
    $('search-input').value = '';
    $('btn-clear-search').classList.add('hidden');
    showHint('results-hint');
    $('search-input').focus();
  });

  // Retry button (error view)
  $('btn-retry').addEventListener('click', () => {
    showView('loading');
    askStatus();
  });
});
