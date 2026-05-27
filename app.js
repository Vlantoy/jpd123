'use strict';

// ── Config ──────────────────────────────────────────────────
const MAX_SESSION  = 50;
const SRS_KEY      = 'jpflash.srs';
const KNOWN_KEY    = 'jpflash.known';
const SESSION_KEY  = 'jpflash.session'; // persisted learning-step progress
const LEARN_STEPS  = [1, 5, 15, 30]; // session learning steps in minutes

// ── State ────────────────────────────────────────────────────
let allVocab = [];
let allKanji = [];
let grammarLessons = [];
let queue = [];
let current = null;
let flipped = false;
let isDrillMode = false;
let isFlashcardMode = false;
let flashDeck = [], flashIndex = 0;
let sessionSRS = JSON.parse(localStorage.getItem('jpflash.session') || '{}'); // {id:{step}} persisted
let cardShownAt = 0;
let retryQueue = [];   // [{item, dueAt}]
let retryTimer = null;
let retryPanelOpen = false;
let expandedListId = null;  // currently expanded list row detail
let dragMovedRow   = false; // true when drag actually crossed to another row
// list view state
let listItems = [];
let listFiltered = [];
let selectedIds = new Set();
// ── SRS (SM-2) ───────────────────────────────────────────────
function getSRS() { return JSON.parse(localStorage.getItem(SRS_KEY) || '{}'); }
function setSRS(s) { localStorage.setItem(SRS_KEY, JSON.stringify(s)); }
function saveSessionSRS() { localStorage.setItem(SESSION_KEY, JSON.stringify(sessionSRS)); }

function cardSRS(id) {
  return getSRS()[id] ?? { ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 0 };
}

function applyRating(id, q) {
  const all = getSRS();
  let s = all[id] ?? { ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 0 };
  if (q < 3) {
    s.reps = 0; s.interval = 1; s.lapses++;
  } else {
    s.reps++;
    s.interval = s.reps === 1 ? 1 : s.reps === 2 ? 6 : Math.round(s.interval * s.ease);
    s.ease = Math.max(1.3, s.ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  }
  s.due = Date.now() + s.interval * 864e5;
  all[id] = s;
  setSRS(all);
}

// ── Data loading ─────────────────────────────────────────────
async function loadVocab() {
  return VOCAB_DATA;
}

async function loadKanji() {
  const raw  = await (await fetch('Kanji.txt')).text();
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const items = [];
  blocks.forEach((block, i) => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return;
    const front = lines[0];
    const raw = lines[1];
    const m = raw.match(/^(.*?)[（(](.*?)[)）]/);
    const back = m ? m[1].trim() + ' — ' + m[2].trim() : raw;
    items.push({ id: 'k' + i, type: 'kanji', front, back });
  });
  return items;
}

async function loadGrammar() {
  const html = await (await fetch('Min Thep - Blog Ti\u1ebfng Nh\u1eadt JPD123.html')).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const LESSONS = [
    { id: 'bai4', title: 'B\u00e0i 4 \u2014 T\u00ednh t\u1eeb \u3044 v\u00e0 \u306a' },
    { id: 'bai5', title: 'B\u00e0i 5 \u2014 Mong mu\u1ed1n v\u00e0 M\u1ee5c \u0111\u00edch' },
    { id: 'bai6', title: 'B\u00e0i 6 \u2014 So s\u00e1nh' },
    { id: 'bai7', title: 'B\u00e0i 7 \u2014 \u0110\u1ed9ng t\u1eeb th\u1ec3 \u3066' },
  ];
  return LESSONS.map(l => {
    const sec = doc.getElementById(l.id);
    if (sec) {
      sec.querySelectorAll('h2, script, nav, header, .navbar').forEach(e => e.remove());
    }
    return { id: l.id, title: l.title, html: sec ? sec.innerHTML : '<p>Kh\u00f4ng t\u00ecm th\u1ea5y n\u1ed9i dung.</p>' };
  });
}

// ── UI helpers ────────────────────────────────────────────────
function $id(id) { return document.getElementById(id); }

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $id(id).classList.add('active');
}

// ── Home stats ─────────────────────────────────────────────────
function refreshStats() {
  const all = [...allVocab, ...allKanji];
  const srs = getSRS();
  const known = getKnownIds();
  const now = Date.now();
  const isDue = c => { const s = srs[c.id]; return !known.has(c.id) && s && s.reps > 0 && s.due <= now; };
  const due    = all.filter(isDue).length;
  const newC   = all.filter(c => !srs[c.id] || srs[c.id].reps === 0).length;
  const mature = all.filter(c => { const s = srs[c.id]; return s && s.interval >= 21; }).length;
  $id('s-due').textContent    = due;
  $id('s-new').textContent    = newC;
  $id('s-mature').textContent = mature;
  const vDue = allVocab.filter(isDue).length;
  const kDue = allKanji.filter(isDue).length;
  const vb = $id('due-vocab'); if (vb) vb.textContent = vDue > 0 ? vDue : '';
  const kb = $id('due-kanji'); if (kb) kb.textContent = kDue > 0 ? kDue : '';
}

// ── List view ─────────────────────────────────────────────────
function srsLevel(id) {
  if (getKnownIds().has(id)) return 'mature';
  const srs = getSRS();
  const s = srs[id];
  if (!s || s.reps === 0) return 'new';
  if (s.interval >= 21)   return 'mature';
  if (s.due > Date.now()) return 'review';
  return 'learning';
}

function formatRelTime(ms) {
  if (ms >= 864e5)    return Math.ceil(ms / 864e5)    + ' ngày nữa';
  if (ms >= 3600000)  return Math.ceil(ms / 3600000)  + ' giờ nữa';
  return Math.ceil(ms / 60000) + ' phút nữa';
}

function statusChipInfo(id) {
  if (getKnownIds().has(id)) return { text: '✓ Đã biết', cls: 'st-known' };
  const s = getSRS()[id];
  const step = sessionSRS[id]?.step;
  const now = Date.now();
  if (!s || s.reps === 0) {
    if (step !== undefined) return { text: '⚡ ' + (step + 1) + '/4', cls: 'st-learning' };
    return { text: 'Mới', cls: 'st-new' };
  }
  if (s.interval >= 21) return { text: '★ Thuộc', cls: 'st-mature' };
  if (s.due <= now)     return { text: '↻ Đến hạn', cls: 'st-due' };
  const ms = s.due - now;
  const t = ms >= 864e5 ? Math.ceil(ms / 864e5) + ' ngày'
           : ms >= 3600000 ? Math.ceil(ms / 3600000) + ' giờ'
           : Math.ceil(ms / 60000) + ' phút';
  return { text: '📅 ' + t, cls: 'st-scheduled' };
}

function buildExpandDetail(id) {
  const s = getSRS()[id];
  const step = sessionSRS[id]?.step;
  const now = Date.now();
  const r = (lbl, val) =>
    '<div class="li-expand-row"><span class="li-expand-label">' + lbl + '</span>' +
    '<span class="li-expand-value">' + val + '</span></div>';
  if (!s || s.reps === 0) {
    if (step !== undefined) {
      const nxt = LEARN_STEPS[step + 1];
      return r('Trạng thái', 'Đang học — Bước ' + (step + 1) + '/4')
           + r('Bước tiếp', nxt ? nxt + ' phút nữa' : 'Tốt nghiệp hôm nay');
    }
    return r('Trạng thái', 'Chưa học lần nào')
         + r('Gợi ý', '⚡ Xem thẻ để bắt đầu');
  }
  const dueStr = s.due <= now
    ? '<span style="color:#1a7a6e;font-weight:700">Đến hạn — ôn tập được ngay</span>'
    : formatRelTime(s.due - now);
  const note = s.due > now
    ? r('Lưu ý', '<span style="color:#999">Chỉ ⚡ Xem thẻ mới học được trước hạn</span>')
    : '';
  return r('Ôn tập tiếp theo', dueStr)
       + r('Khoảng cách', s.interval + ' ngày')
       + r('Số lần ôn tập', s.reps + ' lần')
       + note;
}

function toggleListExpand(id) {
  if (expandedListId) {
    const old = document.getElementById('li-expand-' + expandedListId);
    if (old) old.remove();
  }
  if (expandedListId === id) { expandedListId = null; return; }
  expandedListId = id;
  const row = document.querySelector('#list-items [data-id="' + id + '"]');
  if (!row) return;
  const panel = document.createElement('div');
  panel.className = 'li-expand';
  panel.id = 'li-expand-' + id;
  panel.innerHTML = buildExpandDetail(id);
  row.after(panel);
}

function sortPriority(id) {
  const s = getSRS()[id];
  const now = Date.now();
  if (!s || s.reps === 0) {
    return sessionSRS[id]?.step !== undefined ? [2, 0] : [1, 0]; // learning | new
  }
  if (s.due <= now) return [0, 0];   // due — most urgent
  return [3, s.due];                  // scheduled — sort by nearest date
}

function renderListRow(container, item, knownIds) {
  const isKnown = knownIds.has(item.id);
  const lvl = srsLevel(item.id);
  const isMature = lvl === 'mature';
  const row = document.createElement('div');
  const sel = selectedIds.has(item.id);
  row.className = 'li-row' + (sel ? ' selected' : '');
  row.dataset.id = item.id;
  let btnText, btnClass;
  if (isKnown)        { btnText = '\u2713 Bi\u1ebft'; btnClass = 'li-known-btn known'; }
  else if (isMature)  { btnText = 'Qu\u00ean r\u1ed3i'; btnClass = 'li-known-btn mature-forget'; }
  else                { btnText = 'Bi\u1ebft r\u1ed3i'; btnClass = 'li-known-btn'; }
  const chip = statusChipInfo(item.id);
  row.innerHTML =
    '<div class="li-badge ' + lvl + '"></div>' +
    '<div class="li-text">' +
      '<div class="li-front">' + item.front + '</div>' +
      '<div class="li-back">'  + item.back  + '</div>' +
      '<span class="li-status ' + chip.cls + '">' + chip.text + '</span>' +
    '</div>' +
    '<button class="' + btnClass + '">' + btnText + '</button>' +
    '<div class="li-check' + (sel ? ' checked' : '') + '">' + (sel ? '\u2713' : '') + '</div>';
  row.querySelector('.li-text').addEventListener('click', e => {
    e.stopPropagation();
    if (dragMovedRow) return; // was a cross-row drag, not a tap
    toggleListExpand(item.id);
  });
  row.querySelector('.li-known-btn').addEventListener('click', e => {
    e.stopPropagation();
    const curKnown = getKnownIds().has(item.id);
    const curLvl   = srsLevel(item.id);
    if (curKnown || curLvl === 'mature') {
      markKnown(item.id, false);
      // Remove from current view — word no longer belongs in mature list
      listItems = listItems.filter(i => i.id !== item.id);
    } else {
      markKnown(item.id, true);
    }
    // Re-apply current search so filter stays consistent
    const q = $id('list-search').value.toLowerCase().trim();
    renderList(q
      ? listItems.filter(i => i.front.toLowerCase().includes(q) || i.back.toLowerCase().includes(q))
      : listItems);
    refreshStats();
  });
  container.appendChild(row);
}

function renderList(items) {
  expandedListId = null;
  listFiltered = items;
  const container = $id('list-items');
  container.innerHTML = '';
  const knownIds = getKnownIds();
  const activeItems = items.filter(item => srsLevel(item.id) !== 'mature');
  const matureItems  = items.filter(item => srsLevel(item.id) === 'mature');
  activeItems.sort((a, b) => {
    const pa = sortPriority(a.id), pb = sortPriority(b.id);
    return pa[0] - pb[0] || pa[1] - pb[1];
  });
  activeItems.forEach(item => renderListRow(container, item, knownIds));
  if (matureItems.length > 0) {
    if (activeItems.length === 0) {
      // All items are mature — show directly (no collapsible)
      matureItems.forEach(item => renderListRow(container, item, knownIds));
    } else {
      const section = document.createElement('div');
      section.className = 'mature-section';
      const hdr = document.createElement('div');
      hdr.className = 'mature-header';
      hdr.textContent = 'Thu\u1ed9c l\u00f2ng (' + matureItems.length + ')';
      const body = document.createElement('div');
      body.className = 'mature-body hidden';
      hdr.addEventListener('click', () => {
        body.classList.toggle('hidden');
        hdr.classList.toggle('open');
      });
      matureItems.forEach(item => renderListRow(body, item, knownIds));
      section.appendChild(hdr);
      section.appendChild(body);
      container.appendChild(section);
    }
  }
}

function toggleSelect(id) {
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
  } else {
    selectedIds.add(id);
  }
  // re-render only this row
  const row = $id('list-items').querySelector('[data-id="' + id + '"]');
  if (row) {
    const sel = selectedIds.has(id);
    row.classList.toggle('selected', sel);
    const ck = row.querySelector('.li-check');
    ck.textContent = sel ? '✓' : '';
    ck.classList.toggle('checked', sel);
  }
  updateSelBar();
}

function updateSelBar() {
  const n = selectedIds.size;
  $id('sel-count-lbl').textContent = n + ' \u0111\u00e3 ch\u1ecdn';
  $id('list-study-bar').classList.toggle('hidden', n === 0);
  const cb = $id('select-all-cb');
  cb.indeterminate = n > 0 && n < listItems.length;
  cb.checked = n === listItems.length && n > 0;
  // Update SRS button: only new/due cards can be drilled
  const srsData = getSRS();
  const knownIds = getKnownIds();
  const now = Date.now();
  const srsCount = [...selectedIds].filter(id => {
    if (knownIds.has(id)) return false;
    const s = srsData[id];
    return !s || s.reps === 0 || s.due <= now;
  }).length;
  const srsBtn = $id('list-srs-btn');
  srsBtn.textContent = srsCount > 0 ? '\u21ba H\u1ecdc SRS (' + srsCount + ')' : '\u21ba H\u1ecdc SRS';
  srsBtn.disabled = srsCount === 0;
}

function showList(items, title) {
  listItems  = items;
  selectedIds = new Set();
  $id('list-title').textContent = title;
  const unit = title === 'Kanji' ? ' chữ' : ' từ';
  $id('list-cnt').textContent = items.length + unit;
  $id('list-search').value = '';
  renderList(items);
  updateSelBar();
  showView('view-list');
}

// ── Study session ──────────────────────────────────────────────
function buildQueue(items) {
  const now   = Date.now();
  const srs   = getSRS();
  const known = getKnownIds();
  const active = items.filter(c => !known.has(c.id));
  const due  = active.filter(c => { const s = srs[c.id]; return s && s.reps > 0 && s.due <= now; });
  return due.slice(0, MAX_SESSION);
}

// ── Session interval helpers ──────────────────────────────────
function intervalForRating(id, q) {
  const s = getSRS()[id];
  const isReview = s && s.reps > 0;  // already graduated — direct SRS, no learning steps
  if (isReview) {
    // Lapse (Again) → short countdown before re-entering learning
    return q === 0 ? LEARN_STEPS[0] : null;
  }
  // Learning card — track step progress
  const step = sessionSRS[id]?.step ?? 0;
  if (q === 0) return 0;                          // Again → immediate re-queue
  if (q === 2) return LEARN_STEPS[0];             // Hard → back to step 0 (1 min)
  if (q === 5) return null;                       // Easy → graduate now
  const next = step + 1;
  return next < LEARN_STEPS.length ? LEARN_STEPS[next] : null; // Good → next step or graduate
}
function formatInterval(mins) {
  if (mins === 0)    return '+1 th\u1ebb';
  if (mins < 60) return mins + ' ph\u00fat';
  return Math.round(mins / 60) + ' gi\u1edd';
}
function previewSRSInterval(id, q) {
  const all = getSRS();
  const s = all[id] ?? { ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 0 };
  if (q < 3) return 1;
  const nextReps = s.reps + 1;
  if (nextReps === 1) return 1;
  if (nextReps === 2) return 6;
  return Math.round(s.interval * s.ease);
}
function formatSRSInterval(days) {
  if (days >= 30) return Math.round(days / 30) + ' th\u00e1ng';
  if (days >= 7)  return Math.round(days / 7)  + ' tu\u1ea7n';
  return days + ' ng\u00e0y';
}
function updateRatingLabels(id) {
  [[0,0],[2,2],[3,3],[5,5]].forEach(([score, q]) => {
    const el = $id('ri-' + score);
    if (!el) return;
    const mins = intervalForRating(id, q);
    el.textContent = mins === null
      ? formatSRSInterval(previewSRSInterval(id, q))
      : formatInterval(mins);
  });
}

// ── Known words ─────────────────────────────────────────────────
function getKnownIds() { return new Set(JSON.parse(localStorage.getItem(KNOWN_KEY) || '[]')); }
function setKnownIds(s) { localStorage.setItem(KNOWN_KEY, JSON.stringify([...s])); }
function markKnown(id, known) {
  const knownSet = getKnownIds();
  if (known) {
    knownSet.add(id);
    const all = getSRS();
    all[id] = { ease: 2.5, interval: 365, reps: 10, lapses: 0, due: Date.now() + 365 * 864e5 };
    setSRS(all);
  } else {
    knownSet.delete(id);
    const all = getSRS();
    delete all[id];
    setSRS(all);
  }
  setKnownIds(knownSet);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function startStudy(items, title) {
  isDrillMode = false;
  isFlashcardMode = false;
  clearRetryState();
  queue = buildQueue(items);
  loadRetryQueue(); // restore saved countdown items from previous drill session
  $id('study-title').textContent = title;
  showView('view-study');
  nextCard();
}

function startDrill(items, title) {
  isDrillMode = true;
  isFlashcardMode = false;
  clearRetryState();
  const known = getKnownIds();
  const srs = getSRS();
  const now = Date.now();
  // Only new cards (reps=0) or due cards — future-scheduled SRS cards are off-limits
  const studyable = items.filter(c => {
    if (known.has(c.id)) return false;
    const s = srs[c.id];
    return !s || s.reps === 0 || s.due <= now;
  });
  queue = shuffle(studyable);
  loadRetryQueue(); // restore saved countdown items (expired ones go to front of queue)
  $id('study-title').textContent = title + ' • Drill';
  showView('view-study');
  nextCard();
}

function startFlashcard(items, title) {
  isDrillMode = false;
  isFlashcardMode = true;
  clearRetryState();
  const known = getKnownIds();
  flashDeck = shuffle(items.filter(c => !known.has(c.id)));
  flashIndex = 0;
  $id('study-title').textContent = title;
  $id('study-progress').textContent = '';
  showView('view-study');
  showFlashCard();
}

function showFlashCard() {
  flipped = false;
  $id('cf-inner').classList.remove('flipped');
  $id('rating-bar').classList.remove('visible');
  $id('flash-bar').classList.add('visible');
  $id('tap-hint').classList.remove('hidden');
  $id('c-level-badge').textContent = '';
  $id('c-level-badge').className = 'c-level-badge';
  if (flashDeck.length === 0) {
    current = null;
    $id('c-front').textContent = '— không có thẻ —';
    $id('c-back').textContent = '';
    $id('flash-pos').textContent = '0 / 0';
    $id('flash-prev-btn').disabled = true;
    $id('flash-next-btn').disabled = true;
    return;
  }
  current = flashDeck[flashIndex];
  $id('c-front').textContent = current.front;
  $id('c-back').textContent  = current.back;
  $id('flash-pos').textContent = (flashIndex + 1) + ' / ' + flashDeck.length;
  $id('flash-prev-btn').disabled = flashIndex === 0;
  $id('flash-next-btn').disabled = flashIndex === flashDeck.length - 1;
}

function clearRetryState() {
  retryQueue = [];
  retryPanelOpen = false;
  if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
  const panel = $id('retry-panel');
  if (panel) { panel.classList.add('hidden'); panel.classList.remove('open'); }
}

function saveRetryQueue() {
  if (retryQueue.length === 0) {
    localStorage.removeItem('jpflash.retry');
  } else {
    localStorage.setItem('jpflash.retry', JSON.stringify(
      retryQueue.map(r => ({ item: r.item, dueAt: r.dueAt }))
    ));
  }
}

function loadRetryQueue() {
  const saved = JSON.parse(localStorage.getItem('jpflash.retry') || '[]');
  if (!saved.length) return;
  localStorage.removeItem('jpflash.retry');
  const now = Date.now();
  saved.forEach(r => {
    if (r.dueAt <= now) {
      queue.unshift(r.item); // already expired → jump to front of queue
    } else {
      retryQueue.push(r);
    }
  });
  if (retryQueue.length > 0) {
    retryPanelOpen = true;
    startRetryTimer();
    renderRetryTray();
  }
}

function startRetryTimer() {
  if (retryTimer) return;
  retryTimer = setInterval(tickRetry, 250);
}

function tickRetry() {
  const now = Date.now();
  const expired = retryQueue.filter(r => r.dueAt <= now);
  retryQueue = retryQueue.filter(r => r.dueAt > now);
  const wasIdle = !current && expired.length > 0; // were we on "Xong rồi!" screen?
  expired.forEach(r => queue.unshift(r.item));
  if (expired.length > 0) saveRetryQueue(); // update persisted state when items expire
  if (retryQueue.length === 0) {
    clearInterval(retryTimer); retryTimer = null;
    const panel = $id('retry-panel');
    panel.classList.add('hidden'); panel.classList.remove('open');
    retryPanelOpen = false;
  } else {
    renderRetryTray();
  }
  // If we were idle ("Xong rồi!") and cards just came back, resume studying
  if (wasIdle) nextCard();
}

function renderRetryTray() {
  const panel = $id('retry-panel');
  if (!panel) return;
  const now = Date.now();
  panel.classList.remove('hidden');
  panel.classList.toggle('open', retryPanelOpen); // respect user's collapsed state
  $id('retry-panel-count').textContent = '⏳ ' + retryQueue.length + ' từ';
  const body = $id('retry-panel-body');
  body.innerHTML = retryQueue.map(r => {
    const secs = Math.ceil((r.dueAt - now) / 1000);
    const timeStr = secs >= 60
      ? Math.ceil(secs / 60) + ' phút'
      : secs + 's';
    return '<div class="retry-item">'
      + '<span class="retry-item-word">' + r.item.front + '</span>'
      + '<span class="retry-item-time">' + timeStr + '</span>'
      + '</div>';
  }).join('');
}

function nextCard() {
  cardShownAt = Date.now();
  flipped = false;
  $id('cf-inner').classList.remove('flipped');
  $id('rating-bar').classList.remove('visible');
  $id('flash-bar').classList.remove('visible');
  $id('tap-hint').classList.remove('hidden');
  $id('c-level-badge').textContent = '';
  $id('c-level-badge').className = 'c-level-badge';

  current = queue.shift() ?? null;

  if (!current) {
    $id('c-front').textContent = '✓ Xong rồi!';
    $id('study-progress').textContent = retryQueue.length > 0
      ? retryQueue.length + ' thẻ đang đếm ngược...'
      : '';
    $id('tap-hint').classList.add('hidden');
    return;
  }

  $id('c-front').textContent = current.front;
  $id('c-back').textContent  = current.back;
  $id('study-progress').textContent =
    queue.length > 0 ? queue.length + ' còn lại' : 'cuối cùng';
}

function reveal() {
  if (!current) return;
  if (!flipped) {
    flipped = true;
    $id('cf-inner').classList.add('flipped');
    $id('tap-hint').classList.add('hidden');
    if (!isFlashcardMode) {
      const lvl = srsLevel(current.id);
      const labels = { new: 'M\u1edbi', learning: '\u0110ang h\u1ecdc', review: '\u00d4n t\u1eadp', mature: 'Thu\u1ed9c l\u00f2ng' };
      const badge = $id('c-level-badge');
      badge.textContent = labels[lvl] || '';
      badge.className = 'c-level-badge lvl-' + lvl;
      updateRatingLabels(current.id);
      $id('rating-bar').classList.add('visible');
    }
  } else {
    flipped = false;
    $id('cf-inner').classList.remove('flipped');
    $id('rating-bar').classList.remove('visible');
    $id('tap-hint').classList.remove('hidden');
  }
}

function flashNext() {
  if (flashIndex < flashDeck.length - 1) {
    flashIndex++;
    showFlashCard();
  }
}

function flashPrev() {
  if (flashIndex > 0) {
    flashIndex--;
    showFlashCard();
  }
}

function rate(q) {
  if (!current) return;
  const s = getSRS()[current.id];
  const isReview = s && s.reps > 0;
  const mins = intervalForRating(current.id, q);
  const step = sessionSRS[current.id]?.step ?? 0;

  if (isReview) {
    // Review card: apply SRS rating immediately
    applyRating(current.id, q);
    if (q === 0) {
      // Lapse — card is now reps=0 again, re-enters learning from step 0
      sessionSRS[current.id] = { step: 0 };
    } else {
      delete sessionSRS[current.id];
    }
  } else {
    // Learning card: only commit to SRS on graduation
    if (mins === null) {
      applyRating(current.id, q); // graduate → save long-term interval
      delete sessionSRS[current.id];
    } else {
      // Still in learning steps — update step only, no SRS write
      sessionSRS[current.id] = { step: q < 3 ? 0 : step + 1 };
    }
  }
  saveSessionSRS(); // persist step progress across sessions

  if (mins === 0) {
    // Again on learning card: insert right after next
    queue.splice(1, 0, current);
  } else if (mins !== null) {
    retryQueue.push({ item: current, dueAt: Date.now() + mins * 60000 });
    retryPanelOpen = true; // auto-expand so user sees the queue immediately
    startRetryTimer();
    renderRetryTray();
    saveRetryQueue(); // persist so countdown survives if user exits
  }
  refreshStats();
  nextCard();
}

function speakCard() {
  if (!current) return;
  const raw = current.front.replace(/[（(].*?[）)]/g, '').trim();
  const btn = $id('speak-btn');

  // Visual feedback
  btn.textContent = '⏳';
  const resetBtn = () => { btn.textContent = '🔊'; };

  const voices = speechSynthesis.getVoices();
  const jp = voices.find(v => v.lang && v.lang.startsWith('ja'));

  if (jp) {
    // Native Japanese voice available
    const utt = new SpeechSynthesisUtterance(raw);
    utt.voice = jp;
    utt.lang = 'ja-JP';
    utt.onstart = () => { btn.textContent = '🔈'; };
    utt.onend   = resetBtn;
    utt.onerror = e => { console.warn('[TTS] error:', e.error); resetBtn(); speakViaAudio(raw, resetBtn); };
    speechSynthesis.cancel();
    speechSynthesis.speak(utt);
  } else {
    // No Japanese voice — fall back to Google TTS audio
    console.info('[TTS] No ja voice found, using Google TTS fallback');
    speakViaAudio(raw, resetBtn);
  }
}

function speakViaAudio(text, onDone) {
  const btn = $id('speak-btn');
  const url = 'https://translate.google.com/translate_tts?ie=UTF-8&q='
    + encodeURIComponent(text) + '&tl=ja&client=tw-ob';
  const audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.oncanplaythrough = () => {
    btn.textContent = '🔈';
    audio.play().catch(e => { console.warn('[TTS] play blocked:', e); if (onDone) onDone(); });
  };
  audio.onended  = () => { if (onDone) onDone(); };
  audio.onerror  = e => {
    console.warn('[TTS] Audio fallback failed:', e);
    if (onDone) onDone();
    // Last resort: speak with any available voice
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = 'ja-JP';
    speechSynthesis.cancel();
    speechSynthesis.speak(utt);
  };
  audio.src = url;
}

// ── Grammar ────────────────────────────────────────────────────
function renderGrammar() {
  const c = $id('grammar-content');
  c.innerHTML = '';
  grammarLessons.forEach(lesson => {
    const det = document.createElement('details');
    det.className = 'g-lesson';

    const sum = document.createElement('summary');
    sum.className = 'g-lesson-head';
    sum.textContent = lesson.title;

    const body = document.createElement('div');
    body.className = 'g-lesson-body';
    body.innerHTML = lesson.html;
    body.querySelectorAll('script').forEach(s => s.remove());

    det.append(sum, body);
    c.appendChild(det);
  });
}

// ── Init ───────────────────────────────────────────────────────
async function init() {
  try {
    const [vocab, kanji, grammar] = await Promise.all([
      loadVocab(), loadKanji(), loadGrammar()
    ]);
    allVocab       = vocab;
    allKanji       = kanji;
    grammarLessons = grammar;

    $id('count-vocab').textContent   = vocab.length + ' t\u1eeb';
    $id('count-kanji').textContent   = kanji.length + ' ch\u1eef';
    $id('count-grammar').textContent = grammar.length + ' b\u00e0i';

    refreshStats();
    renderGrammar();
  } catch (e) {
    console.error('Load error:', e);
  }

  // ── Home mode buttons
  $id('mode-vocab-review').addEventListener('click',  () => startStudy(allVocab, 'T\u1eeb v\u1ef1ng'));
  $id('mode-vocab-select').addEventListener('click',  () => showList(allVocab, 'T\u1eeb v\u1ef1ng'));
  $id('stat-mature').addEventListener('click', () => {
    const all = [...allVocab, ...allKanji].filter(i => srsLevel(i.id) === 'mature');
    if (all.length > 0) showList(all, 'Thu\u1ed9c l\u00f2ng');
  });
  $id('mode-kanji-review').addEventListener('click',  () => startStudy(allKanji, 'Kanji'));
  $id('mode-kanji-select').addEventListener('click',  () => showList(allKanji, 'Kanji'));
  $id('mode-grammar-open').addEventListener('click',  () => showView('view-grammar'));

  // ── List view
  $id('list-back').addEventListener('click', () => showView('view-home'));
  $id('list-flash-btn').addEventListener('click', () => {
    const sel = listItems.filter(i => selectedIds.has(i.id));
    if (sel.length) startFlashcard(sel, $id('list-title').textContent);
  });
  $id('list-srs-btn').addEventListener('click', () => {
    const sel = listItems.filter(i => selectedIds.has(i.id));
    if (sel.length) startDrill(sel, $id('list-title').textContent);
  });
  $id('list-search').addEventListener('input', () => {
    const q = $id('list-search').value.toLowerCase().trim();
    const result = q
      ? listItems.filter(i => i.front.toLowerCase().includes(q) || i.back.toLowerCase().includes(q))
      : listItems;
    renderList(result);
  });
  $id('select-all-cb').addEventListener('change', e => {
    if (e.target.checked) {
      listItems.forEach(i => selectedIds.add(i.id));
    } else {
      selectedIds.clear();
    }
    renderList(listFiltered.length ? listFiltered : listItems);
    updateSelBar();
  });

  // ── Drag-to-select in list
  let dragActive = false, dragValue = true, dragLastId = null;
  let pointerDown = false, pointerStartX = 0, pointerStartY = 0, pointerStartId = null;
  const DRAG_PX = 6;
  const listEl = $id('list-items');

  function activateDrag() {
    if (dragActive) return;
    dragActive = true;
    if (pointerStartId && selectedIds.has(pointerStartId) !== dragValue) toggleSelect(pointerStartId);
  }

  listEl.addEventListener('mousedown', e => {
    const row = e.target.closest('.li-row');
    if (!row || e.target.closest('.li-known-btn, .li-check')) return;
    pointerDown = true; dragActive = false; dragLastId = null; dragMovedRow = false;
    const id = row.dataset.id;
    pointerStartId = id; dragLastId = id;
    dragValue = !selectedIds.has(id);
    pointerStartX = e.clientX; pointerStartY = e.clientY;
    if (!e.target.closest('.li-text')) activateDrag(); // non-text: select immediately
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!pointerDown || dragActive) return;
    if (Math.hypot(e.clientX - pointerStartX, e.clientY - pointerStartY) > DRAG_PX) activateDrag();
  });
  listEl.addEventListener('mouseover', e => {
    if (!dragActive) return;
    const row = e.target.closest('.li-row');
    if (!row) return;
    const id = row.dataset.id;
    if (id === dragLastId) return;
    dragMovedRow = true;
    if (selectedIds.has(id) !== dragValue) toggleSelect(id);
    dragLastId = id;
  });
  document.addEventListener('mouseup', () => { pointerDown = false; dragActive = false; });

  listEl.addEventListener('touchstart', e => {
    const row = e.target.closest('.li-row');
    if (!row || e.target.closest('.li-known-btn, .li-check')) return;
    pointerDown = true; dragActive = false; dragLastId = null; dragMovedRow = false;
    const id = row.dataset.id;
    pointerStartId = id; dragLastId = id;
    dragValue = !selectedIds.has(id);
    const t = e.touches[0]; pointerStartX = t.clientX; pointerStartY = t.clientY;
    if (!e.target.closest('.li-text')) activateDrag();
  }, { passive: true });
  listEl.addEventListener('touchmove', e => {
    if (!pointerDown) return;
    const t = e.touches[0];
    if (!dragActive && Math.hypot(t.clientX - pointerStartX, t.clientY - pointerStartY) > DRAG_PX) activateDrag();
    if (!dragActive) return;
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const row = el?.closest?.('.li-row');
    if (!row) return;
    const id = row.dataset.id;
    if (id === dragLastId) return;
    dragMovedRow = true;
    if (selectedIds.has(id) !== dragValue) toggleSelect(id);
    dragLastId = id;
  }, { passive: true });
  document.addEventListener('touchend', () => { pointerDown = false; dragActive = false; });

  // ── Study
  $id('study-back').addEventListener('click', () => { saveRetryQueue(); clearRetryState(); showView('view-list'); });
  $id('card-area').addEventListener('click', reveal);
  $id('speak-btn').addEventListener('click', e => { e.stopPropagation(); speakCard(); });
  $id('flash-prev-btn').addEventListener('click', e => { e.stopPropagation(); flashPrev(); });
  $id('flash-next-btn').addEventListener('click', e => { e.stopPropagation(); flashNext(); });
  $id('retry-panel-header').addEventListener('click', e => {
    e.stopPropagation();
    retryPanelOpen = !retryPanelOpen;
    document.getElementById('retry-panel').classList.toggle('open', retryPanelOpen);
  });
  document.querySelectorAll('.rate-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); rate(Number(btn.dataset.score)); });
  });

  // ── Keyboard
  document.addEventListener('keydown', e => {
    const inStudy = $id('view-study').classList.contains('active');
    if (inStudy && (e.code === 'Space' || e.key === ' ')) {
      e.preventDefault();
      reveal();
    }
    if (inStudy && isFlashcardMode) {
      if (e.key === 'ArrowRight') { e.preventDefault(); flashNext(); }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); flashPrev(); }
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      toggleDebug();
    }
  });

  // ── Grammar
  $id('grammar-back').addEventListener('click', () => showView('view-home'));
}

// ── Debug ────────────────────────────────────────────────
let debugMode = false;
let debugTimer = null;

function renderDebugPanel() {
  const p = $id('debug-panel');
  if (!p || !debugMode) return;
  const now = Date.now();
  const modeLbl = isFlashcardMode ? 'flashcard' : isDrillMode ? 'drill' : 'SRS';
  const queueStr = queue.length
    ? queue.map((c, i) => '  ' + (i + 1) + '. [' + c.id + '] ' + c.front + ' → ' + c.back).join('\n')
    : '  (trống)';
  const retryStr = retryQueue.length
    ? retryQueue.map(r => '  [' + r.item.id + '] ' + r.item.front + '  ⏳ ' + Math.ceil((r.dueAt - now) / 1000) + 's').join('\n')
    : '  (trống)';
  const sesStr = Object.keys(sessionSRS).length
    ? Object.entries(sessionSRS).map(([id, v]) => '  ' + id + ': step=' + v.step).join('\n')
    : '  (trống)';
  p.textContent = [
    '━━━ DEBUG  Ctrl+Shift+D để ẩn  ━━━  mode: ' + modeLbl + '  |  flip: ' + flipped,
    '▶ Current: ' + (current ? '[' + current.id + '] ' + current.front + ' → ' + current.back : '— none —'),
    '',
    '▤ Queue (' + queue.length + '):',
    queueStr,
    '',
    '⏳ Countdown (' + retryQueue.length + '):',
    retryStr,
    '',
    '📌 Session SRS (' + Object.keys(sessionSRS).length + '):',
    sesStr,
  ].join('\n');
}

function toggleDebug() {
  debugMode = !debugMode;
  const p = $id('debug-panel');
  if (debugMode) {
    p.classList.remove('hidden');
    renderDebugPanel();
    debugTimer = setInterval(renderDebugPanel, 400);
    console.log('%c📚 JPD123 Debug ON — dbg.dump() cho full state', 'color:#7effa0;font-weight:bold');
  } else {
    p.classList.add('hidden');
    if (debugTimer) { clearInterval(debugTimer); debugTimer = null; }
  }
}

window.dbg = {
  get queue()      { return queue; },
  get retry()      { return retryQueue; },
  get current()    { return current; },
  get session()    { return sessionSRS; },
  get srs()        { return getSRS(); },
  get known()      { return [...getKnownIds()]; },
  get mode()       { return isFlashcardMode ? 'flashcard' : isDrillMode ? 'drill' : 'SRS'; },
  toggle:          toggleDebug,
  dump() {
    const now = Date.now();
    console.group('%c📚 JPD123 State', 'color:#4a90d9;font-size:13px;font-weight:bold');
    console.log('Mode:', this.mode, '| Flipped:', flipped);
    console.log('Current:', current ? current.id + ' [' + current.front + ' → ' + current.back + ']' : null);
    console.table(queue.map((c, i) => ({ pos: i + 1, id: c.id, front: c.front, back: c.back })));
    console.log('Countdown:', retryQueue.map(r => r.item.front + ' in ' + Math.ceil((r.dueAt - now) / 1000) + 's'));
    console.log('SessionSRS:', sessionSRS);
    console.log('SRS entries:', Object.keys(getSRS()).length);
    console.log('Known:', [...getKnownIds()]);
    console.groupEnd();
  }
};

console.log('%c📚 JPD123 — Ctrl+Shift+D để bật debug | dbg.dump() cho state', 'color:#888;font-size:11px');

init();
