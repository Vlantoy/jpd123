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
let cardTransitioning = false; // true during flip-back animation between cards
// list view state
let listItems = [];
let listFiltered = [];
let selectedIds = new Set();
let lastClickedId = null; // for shift+click range selection
let listGroupedMode = false; // true = show lesson-grouped picker
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
  if (q === 0) {
    // Again — lapse: reset reps, drop interval, due will be managed by learning step countdown
    s.reps = 0; s.interval = 0; s.lapses++;
    s.ease = Math.max(1.3, s.ease - 0.2);
    s.due = Date.now();
  } else if (q === 2) {
    // Hard — keep reps, slightly bump interval, reduce ease (Anki-style, NOT a lapse)
    s.reps++;
    s.interval = s.reps === 1 ? 1 : Math.max(1, Math.round(s.interval * 1.2));
    s.ease = Math.max(1.3, s.ease - 0.15);
    s.due = Date.now() + s.interval * 864e5;
  } else {
    // Good (3) / Easy (5)
    s.reps++;
    s.interval = s.reps === 1 ? 1 : s.reps === 2 ? 6 : Math.round(s.interval * s.ease);
    s.ease = Math.max(1.3, s.ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    s.due = Date.now() + s.interval * 864e5;
  }
  all[id] = s;
  setSRS(all);
}

// ── Data loading ─────────────────────────────────────────────
// Chỉ lấy vocab thuộc các bài đang học (4-7)
const ACTIVE_LESSONS = new Set(['Lesson_04','Lesson_05','Lesson_06','Lesson_07']);
async function loadVocab() {
  return VOCAB_DATA.filter(v => !v.lesson || ACTIVE_LESSONS.has(v.lesson));
}

async function loadKanji() {
  const data = await (await fetch('detailKanji.json')).json();
  return data.map((item, i) => ({
    id: 'k' + i,
    type: 'kanji',
    front: item.kanji,
    back: item.hiragana,
    meaning: item.meaning,
    romaji: item.romaji
  }));
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

function setCardBack(item) {
  const el = $id('c-back');
  if (item && item.type === 'kanji' && item.meaning) {
    el.innerHTML = '<span class="kanji-reading" data-meaning="' + item.meaning.replace(/"/g, '&quot;') + '">' + item.back + '</span>';
  } else {
    el.textContent = item ? item.back : '';
  }
}

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $id(id).classList.add('active');
}

// ── Sound effects (Web Audio, no external files) ──────────────
let _audioCtx = null;
function getAudioCtx() {
  if (_audioCtx) return _audioCtx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    _audioCtx = new AC();
  } catch { return null; }
  return _audioCtx;
}
// type: 'pass' (Ổn — bright two-note up), 'fail' (Chưa ổn — soft down), 'flip' (reveal click)
function playSound(type) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') { try { ctx.resume(); } catch {} }
  const now = ctx.currentTime;
  const play = (freq, start, dur, gain = 0.08, wave = 'sine') => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, now + start);
    g.gain.setValueAtTime(0, now + start);
    g.gain.linearRampToValueAtTime(gain, now + start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(now + start);
    osc.stop(now + start + dur + 0.02);
  };
  if (type === 'pass') {
    // E5 → A5 (bright, pleasant)
    play(659.25, 0,    0.12, 0.07, 'triangle');
    play(880.00, 0.08, 0.18, 0.07, 'triangle');
  } else if (type === 'fail') {
    // A4 → E4 (soft down, not punishing)
    play(440.00, 0,    0.10, 0.06, 'sine');
    play(329.63, 0.07, 0.18, 0.06, 'sine');
  } else if (type === 'flip') {
    // Short click — single tick
    play(720, 0, 0.05, 0.04, 'square');
  }
}

// ── Gemini API (key pool + cache) ─────────────────────────────
// Keys load từ gemini_keys.js (gitignored). Nếu thiếu file → mảng rỗng, Gemini features tắt.
const GEMINI_KEYS = (typeof window !== 'undefined' && Array.isArray(window.GEMINI_KEYS)) ? window.GEMINI_KEYS : [];
const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_CACHE_KEY = 'jpflash.geminiCache';
const GEMINI_KEY_IDX_KEY = 'jpflash.geminiKeyIdx';
const GEMINI_CACHE_MAX = 500;

function getGeminiKeyIdx() {
  const v = parseInt(localStorage.getItem(GEMINI_KEY_IDX_KEY) || '0', 10);
  return isNaN(v) ? 0 : v % GEMINI_KEYS.length;
}
function setGeminiKeyIdx(i) {
  localStorage.setItem(GEMINI_KEY_IDX_KEY, String(i % GEMINI_KEYS.length));
}

function loadGeminiCache() {
  try { return JSON.parse(localStorage.getItem(GEMINI_CACHE_KEY) || '{}'); }
  catch { return {}; }
}
function saveGeminiCache(c) {
  // LRU prune if too big
  const entries = Object.entries(c);
  if (entries.length > GEMINI_CACHE_MAX) {
    entries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    const trimmed = Object.fromEntries(entries.slice(-GEMINI_CACHE_MAX));
    localStorage.setItem(GEMINI_CACHE_KEY, JSON.stringify(trimmed));
  } else {
    localStorage.setItem(GEMINI_CACHE_KEY, JSON.stringify(c));
  }
}
function normalizeText(s) {
  return (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Call Gemini with auto key rotation on rate limit / quota errors.
// Returns parsed text on success, throws on hard failure.
const GEMINI_MODELS_FALLBACK = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.5-flash-lite', 'gemini-flash-latest'];

async function callGemini(prompt, sysInstruction) {
  if (!GEMINI_KEYS.length) throw new Error('Không có Gemini API key — kiểm tra file gemini_keys.js');
  const startIdx = getGeminiKeyIdx();
  let lastErr = null;
  const errLog = [];
  for (const model of GEMINI_MODELS_FALLBACK) {
    for (let attempt = 0; attempt < GEMINI_KEYS.length; attempt++) {
      const idx = (startIdx + attempt) % GEMINI_KEYS.length;
      const key = GEMINI_KEYS[idx];
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      try {
        const body = {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 512, responseMimeType: 'text/plain' },
        };
        if (sysInstruction) {
          body.systemInstruction = { parts: [{ text: sysInstruction }] };
        }
        if (window.dbg && window.dbg.geminiTrace) {
          console.log('[Gemini→] model=', model, 'key=', idx, '\nSYSTEM:\n', sysInstruction || '(none)', '\nUSER:\n', prompt);
        }
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const txt = await res.text();
          const msg = `[${model}] key${idx} HTTP ${res.status}: ${txt.slice(0, 150)}`;
          errLog.push(msg);
          lastErr = new Error(msg);
          if (res.status === 429 || res.status === 403) {
            setGeminiKeyIdx(idx + 1);
          }
          continue;
        }
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          errLog.push(`[${model}] key${idx} empty response`);
          lastErr = new Error('Empty response');
          continue;
        }
        if (window.dbg && window.dbg.geminiTrace) {
          console.log('[Gemini←] raw response:\n', text);
        }
        // Success — remember this key
        setGeminiKeyIdx(idx);
        return text;
      } catch (err) {
        const msg = `[${model}] key${idx} ${err.message || err}`;
        errLog.push(msg);
        lastErr = err;
      }
    }
  }
  console.warn('[Gemini] all attempts failed:', errLog);
  throw lastErr || new Error('All Gemini keys/models failed');
}

// Pick a small vocab pool (~25 items) — prioritize items whose kana/kanji appear
// in the selected text, then fill with random words from allVocab + allKanji.
function pickVocabPool(text) {
  const POOL_SIZE = 25;
  const must = []; // matched in selected text — Gemini PHẢI dùng
  const may = [];  // random fill — Gemini có thể tham khảo
  const seen = new Set();
  const pushTo = (arr, it) => {
    const k = (it.front || '') + '|' + (it.kanji || '');
    if (seen.has(k)) return;
    seen.add(k);
    arr.push(it);
  };
  // 1) MUST: vocab/kanji whose front/kanji appears in selected text
  for (const v of allVocab) {
    if ((v.front && text.includes(v.front)) || (v.kanji && text.includes(v.kanji))) pushTo(must, v);
  }
  for (const k of allKanji) {
    if (k.front && text.includes(k.front)) pushTo(must, { front: k.back || '', kanji: k.front, back: k.meaning });
  }
  // 2) MAY: random vocab to fill up to POOL_SIZE
  const remaining = POOL_SIZE - must.length;
  if (remaining > 0 && allVocab.length) {
    const shuffled = allVocab.slice().sort(() => Math.random() - 0.5);
    for (const v of shuffled) {
      if (may.length >= remaining) break;
      pushTo(may, v);
    }
  }
  return { must, may };
}

// Extract the first balanced JSON object from a noisy string (handles trailing
// garbage, markdown fences, escaped quotes). Returns parsed object or null.
function extractFirstJsonObject(s) {
  if (!s) return null;
  let t = String(s).replace(/```(?:json)?/gi, '').trim();
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = t.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}

function formatVocabPool(pool) {
  return pool.map(v => {
    const jp = v.kanji ? `${v.kanji}(${v.front})` : v.front;
    return `- ${jp}: ${v.back}`;
  }).join('\n');
}

// System instruction cho Gemini — đặt ở đây để model ƯU TIÊN tuân thủ format.
const GRAMMAR_SYS_INSTRUCTION = `Bạn là trợ lý đặt câu tiếng Nhật cho người học sơ-trung cấp (trình độ N5-N4, giáo trình Minna no Nihongo).

=== QUY TẮC NỘI DUNG (QUAN TRỌNG HƠN FORMAT) ===
- Câu PHẢI có Ý NGHĨA THỰC TẾ, mô tả một tình huống đời sống hợp lý mà người Nhật có thể nói/viết hằng ngày (ở nhà, ở trường, công ty, đi chơi, mua sắm, ăn uống...).
- Câu PHẢI minh hoạ ĐÚNG cấu trúc ngữ pháp trong đoạn được bôi chọn — đó là MỤC TIÊU chính. Nếu đoạn được chọn là một mẫu câu (ví dụ ～てください, ～たいです, ～から), câu ví dụ phải dùng đúng mẫu đó ở vị trí then chốt.
- CẤM TUYỆT ĐỐI câu vô nghĩa, phi lý, siêu thực, hoặc ghép từ vựng gượng ép chỉ để chèn đủ từ trong danh sách. Ví dụ KHÔNG hợp lệ: "Con mèo học tiếng Nhật ở ngân hàng", "Cái bàn ăn cơm với cuốn sách", "Hôm qua tôi sẽ đi chợ ngày mai".
- Chủ ngữ, động từ, tân ngữ phải khớp nhau về logic (người làm việc của người, vật vô tri không tự hành động, thời gian nhất quán...).
- Văn phong tự nhiên như người Nhật bản xứ nói — không dịch word-for-word từ tiếng Việt.
- Độ dài 8-18 từ. Ưu tiên ngắn gọn, rõ ý hơn là dài dòng.
- Nếu phải chọn giữa "dùng thêm 1 từ trong danh sách" và "câu tự nhiên có nghĩa", LUÔN chọn câu tự nhiên có nghĩa.

=== QUY TẮC FORMAT (BẮT BUỘC) ===
- Trả về CHÍNH XÁC 3 dòng plain text, không hơn không kém.
- Dòng 1 bắt đầu bằng "JP: " rồi đến câu tiếng Nhật (có kanji + kana, kết thúc bằng 。 hoặc ？ hoặc ！).
- Dòng 2 bắt đầu bằng "Romaji: " rồi đến phiên âm romaji thường (chữ thường, có khoảng trắng giữa các từ).
- Dòng 3 bắt đầu bằng "VN: " rồi đến bản dịch tiếng Việt tự nhiên.
- TUYỆT ĐỐI KHÔNG dùng JSON, array, markdown (**, *, \`, -, #), HTML, dấu nháy bao quanh câu, hay bất kỳ ký tự trang trí nào.
- KHÔNG thêm dòng giải thích, tiêu đề, lời chào, ghi chú, ví dụ phụ.
- KHÔNG xuống dòng giữa câu — mỗi dòng JP/Romaji/VN nằm trọn trên 1 dòng.

=== VÍ DỤ OUTPUT HỢP LỆ ===
JP: 毎朝コーヒーを飲んでから会社へ行きます。
Romaji: maiasa koohii o nonde kara kaisha e ikimasu.
VN: Mỗi sáng tôi uống cà phê rồi mới đi làm.`;

// Lookup a Japanese grammar structure / phrase — returns { sentence: {jp, romaji, vn}, fromCache }.
// force=true bypasses cache (and writes fresh result back).
async function lookupGrammar(text, force = false) {
  const key = normalizeText(text);
  if (!key) throw new Error('Empty text');
  const cache = loadGeminiCache();
  if (!force && cache[key]) {
    return { sentence: cache[key].sentence, fromCache: true };
  }
  const { must, may } = pickVocabPool(text);
  const mustStr = must.length ? formatVocabPool(must) : '(không có)';
  const maxMay = Math.max(0, 20 - must.length);
  const maySubset = may.slice(0, maxMay);
  const mayStr = maySubset.length ? formatVocabPool(maySubset) : '(không có)';
  // Số từ MUST yêu cầu dùng: tối thiểu 1, tối đa 3 (tránh nhồi nhét gượng ép)
  const mustQuota = must.length === 0 ? 0 : Math.min(3, Math.max(1, Math.ceil(must.length / 3)));
  const mustRule = must.length === 0
    ? '- Không có từ bắt buộc — hãy chọn 1-2 từ trong DANH SÁCH B nếu phù hợp ngữ cảnh tự nhiên. Nếu không từ nào hợp, KHÔNG ép — ưu tiên câu có nghĩa hơn.'
    : `- Ưu tiên dùng ${mustQuota} từ/kanji từ DANH SÁCH A NẾU chúng hợp ngữ cảnh tự nhiên. NHƯNG nếu ép vào sẽ làm câu vô nghĩa/gượng ép, hãy dùng ít hơn (1 từ cũng được) — câu CÓ NGHĨA quan trọng hơn việc chèn đủ từ.\n- Có thể dùng thêm từ trong DANH SÁCH B nếu phù hợp.\n- Tránh dùng từ Hán-Nhật xa lạ ngoài 2 danh sách trên trừ khi thật sự cần.`;
  const variantHint = force ? `\n\nLƯU Ý: hãy đặt câu KHÁC hẳn lần trước, ngữ cảnh mới lạ — NHƯNG vẫn phải tuân thủ ràng buộc từ vựng ở trên VÀ trả về đúng 3 dòng format JP/Romaji/VN, KHÔNG markdown, KHÔNG giải thích.` : '';
  const prompt = `Bạn là trợ lý tiếng Nhật. Người học vừa bôi chọn đoạn sau từ tài liệu ngữ pháp:

"${text}"

=== DANH SÁCH A — TỪ/KANJI BẮT BUỘC ƯU TIÊN (xuất hiện trong đoạn được chọn) ===
${mustStr}

=== DANH SÁCH B — TỪ VỰNG THAM KHẢO (học viên đang học) ===
${mayStr}

=== RÀNG BUỘC TỪ VỰNG ===
${mustRule}

Hãy đặt ĐÚNG 1 câu ví dụ ngắn gọn (10-20 từ), tự nhiên, đúng ngữ pháp, dùng đúng cấu trúc trong đoạn được chọn.${variantHint}

=== OUTPUT RULES (BẮT BUỘC) ===
- Trả về CHÍNH XÁC 3 dòng, không hơn không kém.
- Mỗi dòng bắt đầu bằng đúng nhãn: "JP:", "Romaji:", "VN:" (theo đúng thứ tự này).
- KHÔNG dùng markdown (không **bold**, không *italic*, không backtick, không bullet, không số thứ tự).
- KHÔNG thêm dòng giải thích, ghi chú, tiêu đề, lời chào.
- KHÔNG bọc câu trong dấu nháy hay dấu ngoặc.

Ví dụ output hợp lệ:
JP: 私は毎日日本語を勉強します。
Romaji: watashi wa mainichi nihongo o benkyou shimasu.
VN: Tôi học tiếng Nhật mỗi ngày.

Bây giờ hãy trả lời theo đúng format trên:`;
  const raw = await callGemini(prompt);
  const sentence = parsePlainSentence(raw);
  if (!sentence || !sentence.jp) {
    throw new Error('Gemini trả về sai format: ' + String(raw).slice(0, 120));
  }
  cache[key] = { sentence, ts: Date.now() };
  saveGeminiCache(cache);
  return { sentence, fromCache: false };
}

// Parse Gemini's 3-line plain-text response into {jp, romaji, vn}.
// Tolerant: strips markdown (** __ * ` ), bullet/number prefixes, code fences,
// and accepts label variants (JP/Jap/Japanese/日本語/Nhật, Romaji/ローマ/Âm, VN/Việt/Viet).
function parsePlainSentence(raw) {
  if (!raw) return null;
  // Remove fenced code blocks entirely.
  let text = String(raw).replace(/```[\s\S]*?```/g, '').trim();
  // Strip markdown bold/italic markers globally (keep the inner text).
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1');
  const out = { jp: '', romaji: '', vn: '' };
  const lines = text.split(/\r?\n/)
    .map(l => l.trim())
    // Strip leading bullets/numbers: "- ", "* ", "1. ", "1) ", "• "
    .map(l => l.replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, ''))
    // Strip stray leading/trailing * or ` from a single line
    .map(l => l.replace(/^[*`_~]+|[*`_~]+$/g, '').trim())
    .filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^([^:：]{1,25})\s*[:：]\s*(.+)$/);
    if (!m) continue;
    const label = m[1].toLowerCase().trim();
    const val = m[2].trim().replace(/^["'`<\[(（]+|["'`>\])）]+$/g, '').trim();
    if (!val) continue;
    if (!out.jp && (label.startsWith('jp') || label.startsWith('jap') || label.includes('日本') || label.includes('nhật') || label === 'câu')) out.jp = val;
    else if (!out.romaji && (label.startsWith('rom') || label.includes('ローマ') || label.includes('âm') || label.includes('phiên'))) out.romaji = val;
    else if (!out.vn && (label.startsWith('vn') || label.startsWith('vie') || label.startsWith('việt') || label.startsWith('viet') || label.startsWith('ngh') || label.startsWith('dịch') || label.startsWith('dich'))) out.vn = val;
  }
  // Fallback A: no JP label — pick first line containing kanji/kana.
  if (!out.jp) {
    for (const line of lines) {
      if (/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/.test(line)) {
        out.jp = line.replace(/^[^:：]{1,25}[:：]\s*/, '').replace(/^["'`<\[(（]+|["'`>\])）]+$/g, '').trim();
        break;
      }
    }
  }
  // Fallback B: no romaji — pick a line that is mostly ASCII letters but is NOT the VN line.
  if (!out.romaji) {
    for (const line of lines) {
      const stripped = line.replace(/^[^:：]{1,25}[:：]\s*/, '').trim();
      if (!stripped || stripped === out.jp || stripped === out.vn) continue;
      // ASCII-ish + no Vietnamese diacritics + no kanji/kana → likely romaji.
      if (/^[A-Za-z0-9\s.,!?'"-]+$/.test(stripped)) { out.romaji = stripped; break; }
    }
  }
  return out;
}

// Flip card back to front with a quick animation, then run callback.
// Important: animation finishes BEFORE swapping content, otherwise the new
// card's back text would flash through during the flip.
function doFlipBack(onDone) {
  const inner = $id('cf-inner');
  if (!inner.classList.contains('flipped')) {
    cardTransitioning = false;
    if (onDone) onDone();
    return;
  }
  const FAST = 180; // ms — quick but visible flip
  inner.style.transitionDuration = FAST + 'ms';
  inner.classList.remove('flipped');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    inner.removeEventListener('transitionend', finish);
    inner.style.transitionDuration = '';
    cardTransitioning = false;
    if (onDone) onDone();
  };
  inner.addEventListener('transitionend', finish);
  // Safety fallback in case transitionend never fires
  setTimeout(finish, FAST + 80);
}

// Flip card back to front, calling cb when done
function flipBackThen(cb) { doFlipBack(cb); }

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
  const peek = (item.back || '').replace(/"/g, '&quot;');
  row.setAttribute('data-peek', peek);
  row.innerHTML =
    '<div class="li-badge ' + lvl + '"></div>' +
    '<div class="li-front">' + item.front + '</div>' +
    '<button class="' + btnClass + '">' + btnText + '</button>';
  row.addEventListener('click', e => {
    if (e.target.closest('.li-known-btn')) return;
    if (dragMovedRow) return;
    toggleSelect(item.id, e.shiftKey);
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

// ── Lesson-grouped helpers ──────────────────────────────────
function lessonLabel(key) {
  const m = key.match(/Lesson_(\d+)/);
  return m ? 'B\u00e0i ' + parseInt(m[1], 10) : key;
}
function subLabel(key) {
  // Sub_01_Noi_Chon_Huong_Vi -> Noi Chon Huong Vi
  return key.replace(/^Sub_\d+_/, '').replace(/_/g, ' ');
}

function toggleSelectLesson(lessonKey) {
  const items = listFiltered.filter(i => i.lesson === lessonKey);
  const allSel = items.every(i => selectedIds.has(i.id));
  items.forEach(i => {
    if (allSel) selectedIds.delete(i.id);
    else selectedIds.add(i.id);
  });
  items.forEach(i => {
    const row = $id('list-items').querySelector('[data-id="' + i.id + '"]');
    if (row) row.classList.toggle('selected', selectedIds.has(i.id));
  });
  const lgrp = $id('list-items').querySelector('[data-lesson="' + lessonKey + '"]');
  if (lgrp) {
    const cb = lgrp.querySelector('.lg-cb');
    const newAllSel = items.every(i => selectedIds.has(i.id));
    cb.checked = newAllSel;
    cb.indeterminate = !newAllSel && items.some(i => selectedIds.has(i.id));
  }
  updateSelBar();
}

function toggleSelectSub(lessonKey, subKey) {
  const items = listFiltered.filter(i => i.lesson === lessonKey && i.sub === subKey);
  const allSel = items.every(i => selectedIds.has(i.id));
  items.forEach(i => {
    if (allSel) selectedIds.delete(i.id);
    else selectedIds.add(i.id);
  });
  items.forEach(i => {
    const row = $id('list-items').querySelector('[data-id="' + i.id + '"]');
    if (row) row.classList.toggle('selected', selectedIds.has(i.id));
  });
  updateSelBar();
}

function updateGroupCheckboxes() {
  if (!listGroupedMode) return;
  const byLesson = {};
  listFiltered.forEach(item => { (byLesson[item.lesson] = byLesson[item.lesson] || []).push(item); });
  Object.entries(byLesson).forEach(([lessonKey, lessonItems]) => {
    const lgrp = $id('list-items').querySelector('.lesson-group[data-lesson="' + lessonKey + '"]');
    if (!lgrp) return;
    const lgCb = lgrp.querySelector(':scope > .lesson-group-header .lg-cb');
    if (lgCb) {
      const la = lessonItems.every(i => selectedIds.has(i.id));
      const ls = lessonItems.some(i => selectedIds.has(i.id));
      lgCb.checked = la; lgCb.indeterminate = !la && ls;
    }
    const bySub = {};
    lessonItems.forEach(item => { (bySub[item.sub] = bySub[item.sub] || []).push(item); });
    Object.entries(bySub).forEach(([subKey, subItems]) => {
      const sg = lgrp.querySelector('.sub-group[data-sub="' + CSS.escape(subKey) + '"]');
      if (!sg) return;
      const sgCb = sg.querySelector('.sg-cb');
      if (sgCb) {
        const sa = subItems.every(i => selectedIds.has(i.id));
        const ss = subItems.some(i => selectedIds.has(i.id));
        sgCb.checked = sa; sgCb.indeterminate = !sa && ss;
      }
    });
  });
}

function renderListGrouped(items) {
  const container = $id('list-items');
  container.classList.add('grouped');
  const knownIds = getKnownIds();
  // Group by lesson
  const byLesson = {};
  items.forEach(item => {
    (byLesson[item.lesson] = byLesson[item.lesson] || []).push(item);
  });
  Object.entries(byLesson).forEach(([lessonKey, lessonItems]) => {
    const allSel = lessonItems.every(i => selectedIds.has(i.id));
    const someSel = lessonItems.some(i => selectedIds.has(i.id));
    const grp = document.createElement('div');
    grp.className = 'lesson-group';
    grp.dataset.lesson = lessonKey;

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'lesson-group-header';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'lg-cb';
    cb.checked = allSel;
    cb.indeterminate = !allSel && someSel;
    cb.addEventListener('change', e => {
      e.stopPropagation();
      toggleSelectLesson(lessonKey);
    });
    const title = document.createElement('span');
    title.className = 'lesson-group-title';
    title.textContent = lessonLabel(lessonKey);
    const cnt = document.createElement('span');
    cnt.className = 'lesson-group-count';
    cnt.textContent = lessonItems.length + ' t\u1eeb';
    const arrow = document.createElement('span');
    arrow.className = 'lesson-group-arrow';
    arrow.textContent = '\u25b6';
    hdr.appendChild(cb);
    hdr.appendChild(title);
    hdr.appendChild(cnt);
    hdr.appendChild(arrow);

    const body = document.createElement('div');
    body.className = 'lesson-group-body hidden';

    hdr.addEventListener('click', e => {
      if (e.target === cb) return;
      body.classList.toggle('hidden');
      hdr.classList.toggle('open');
    });

    // Group by sub within lesson
    const bySub = {};
    lessonItems.forEach(item => {
      (bySub[item.sub] = bySub[item.sub] || []).push(item);
    });
    Object.entries(bySub).forEach(([subKey, subItems]) => {
      const sg = document.createElement('div');
      sg.className = 'sub-group';
      sg.dataset.sub = subKey;

      const allSubSel = subItems.every(i => selectedIds.has(i.id));
      const someSubSel = subItems.some(i => selectedIds.has(i.id));

      const sh = document.createElement('div');
      sh.className = 'sub-group-header';

      const sgCb = document.createElement('input');
      sgCb.type = 'checkbox';
      sgCb.className = 'sg-cb';
      sgCb.checked = allSubSel;
      sgCb.indeterminate = !allSubSel && someSubSel;
      sgCb.addEventListener('change', e => {
        e.stopPropagation();
        toggleSelectSub(lessonKey, subKey);
      });

      const sgTitle = document.createElement('span');
      sgTitle.className = 'sg-title';
      sgTitle.textContent = subLabel(subKey);

      const sgCnt = document.createElement('span');
      sgCnt.className = 'sg-count';
      sgCnt.textContent = subItems.length + ' từ';

      const sgArrow = document.createElement('span');
      sgArrow.className = 'sg-arrow';
      sgArrow.textContent = '▶';

      sh.appendChild(sgCb);
      sh.appendChild(sgTitle);
      sh.appendChild(sgCnt);
      sh.appendChild(sgArrow);

      const si = document.createElement('div');
      si.className = 'sub-group-items hidden';

      sh.addEventListener('click', e => {
        if (e.target === sgCb) return;
        si.classList.toggle('hidden');
        sh.classList.toggle('open');
      });

      subItems.forEach(item => renderListRow(si, item, knownIds));
      sg.appendChild(sh);
      sg.appendChild(si);
      body.appendChild(sg);
    });

    grp.appendChild(hdr);
    grp.appendChild(body);
    container.appendChild(grp);
  });
}

function renderList(items) {
  expandedListId = null;
  listFiltered = items;
  const container = $id('list-items');
  container.innerHTML = '';
  container.classList.remove('grouped');
  if (listGroupedMode) {
    renderListGrouped(items);
    return;
  }
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

function toggleSelect(id, shiftKey) {
  if (shiftKey && lastClickedId && lastClickedId !== id) {
    const allRows = [...document.querySelectorAll('#list-items .li-row')];
    const ids = allRows.map(r => r.dataset.id);
    const lastIdx = ids.indexOf(lastClickedId);
    const currIdx = ids.indexOf(id);
    if (lastIdx !== -1 && currIdx !== -1) {
      const start = Math.min(lastIdx, currIdx);
      const end   = Math.max(lastIdx, currIdx);
      const targetState = !selectedIds.has(id);
      for (let i = start; i <= end; i++) {
        const rid = ids[i];
        if (targetState) selectedIds.add(rid);
        else selectedIds.delete(rid);
        allRows[i].classList.toggle('selected', selectedIds.has(rid));
      }
      lastClickedId = id;
      updateSelBar();
      return;
    }
  }
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
  } else {
    selectedIds.add(id);
  }
  const row = $id('list-items').querySelector('[data-id="' + id + '"]');
  if (row) {
    row.classList.toggle('selected', selectedIds.has(id));
  }
  lastClickedId = id;
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
  updateGroupCheckboxes();
}

function showList(items, title, grouped = false) {
  listGroupedMode = grouped;
  listItems  = items;
  selectedIds = new Set();
  lastClickedId = null;
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
  if (q === 0) return LEARN_STEPS[0];             // Chưa ổn → countdown 1 phút (không xuất hiện ngay)
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
  [[0,0],[4,4]].forEach(([score, q]) => {
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
  $id('rating-bar').classList.remove('visible');
  flipped = false;
  $id('c-level-badge').textContent = '';
  $id('c-level-badge').className = 'c-level-badge';
  $id('tap-hint').classList.remove('hidden');

  // Update content first (while back is showing, front update is invisible)
  if (flashDeck.length === 0) {
    current = null;
    $id('c-front').textContent = '— không có thẻ —';
    $id('c-back').textContent = '';
    $id('flash-pos').textContent = '0 / 0';
    $id('flash-prev-btn').disabled = true;
    $id('flash-next-btn').disabled = true;
  } else {
    current = flashDeck[flashIndex];
    $id('c-front').textContent = current.front;
    setCardBack(current);
    $id('flash-pos').textContent = (flashIndex + 1) + ' / ' + flashDeck.length;
    $id('flash-prev-btn').disabled = flashIndex === 0;
    $id('flash-next-btn').disabled = flashIndex === flashDeck.length - 1;
  }

  // Then flip back (reveals new front content)
  doFlipBack(() => { $id('flash-bar').classList.add('visible'); });
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

// Swap card content (front/back/progress) without any animation.
function swapToNextContent() {
  cardShownAt = Date.now();
  current = queue.shift() ?? null;
  if (!current) {
    $id('c-front').textContent = '✓ Xong rồi!';
    $id('study-progress').textContent = '';
    $id('tap-hint').classList.add('hidden');
  } else {
    $id('c-front').textContent = current.front;
    setCardBack(current);
    $id('study-progress').textContent =
      queue.length > 0 ? queue.length + ' còn lại' : 'cuối cùng';
    $id('tap-hint').classList.remove('hidden');
  }
}

// Animate the current card OUT in `dir` ('left'|'right'|'up'), then swap
// content, then animate the new card IN. If dir is null, fall back to
// the quick flip-back behavior (used when card hasn't been flipped yet).
function nextCard(dir) {
  $id('rating-bar').classList.remove('visible');
  $id('flash-bar').classList.remove('visible');
  $id('c-level-badge').textContent = '';
  $id('c-level-badge').className = 'c-level-badge';

  const cf = $id('card-flip');
  const inner = $id('cf-inner');

  // No exit direction OR card not flipped → quick flip-back fallback
  if (!dir || !inner.classList.contains('flipped')) {
    doFlipBack(() => {
      swapToNextContent();
      flipped = false;
      // Subtle enter animation for the new card
      cf.classList.remove('card-enter');
      void cf.offsetWidth;
      cf.classList.add('card-enter');
      setTimeout(() => cf.classList.remove('card-enter'), 280);
    });
    return;
  }

  // Swipe exit: add class, wait for animation end, then swap + enter
  cardTransitioning = true;
  const swipeClass = 'swipe-' + dir;
  cf.classList.add(swipeClass);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    inner.removeEventListener('animationend', finish);
    // Swap content while card is off-screen / invisible
    cf.classList.remove(swipeClass);
    // Reset flip state silently (no transition) so new card shows front
    inner.style.transitionDuration = '0s';
    inner.classList.remove('flipped');
    flipped = false;
    void inner.offsetWidth;
    inner.style.transitionDuration = '';
    swapToNextContent();
    // Enter animation for new card
    cf.classList.remove('card-enter');
    void cf.offsetWidth;
    cf.classList.add('card-enter');
    setTimeout(() => cf.classList.remove('card-enter'), 280);
    cardTransitioning = false;
  };
  inner.addEventListener('animationend', finish);
  // Safety fallback (CSS anim is .28s)
  setTimeout(finish, 360);
}

function reveal() {
  if (!current || cardTransitioning) return;
  if (!flipped) {
    flipped = true;
    playSound('flip');
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
  if (!current || cardTransitioning) return;
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

  if (mins !== null) {
    retryQueue.push({ item: current, dueAt: Date.now() + mins * 60000 });
    retryPanelOpen = true; // auto-expand so user sees the queue immediately
    startRetryTimer();
    renderRetryTray();
    saveRetryQueue(); // persist so countdown survives if user exits
  }
  refreshStats();
  playSound(q === 0 ? 'fail' : 'pass');
  const dir = q === 0 ? 'left' : 'right';
  nextCard(dir);
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

    // Wrap each .grammar-point into a collapsible sub-section
    body.querySelectorAll('.grammar-point').forEach(gp => {
      const titleEl = gp.querySelector(':scope > h3') || gp.querySelector(':scope > h4');
      if (!titleEl) return;
      const secDet = document.createElement('details');
      secDet.className = 'g-section';
      const secSum = document.createElement('summary');
      secSum.className = 'g-section-head';
      secSum.innerHTML = titleEl.innerHTML;
      secDet.appendChild(secSum);
      titleEl.remove();
      const secBody = document.createElement('div');
      secBody.className = 'g-section-body';
      while (gp.firstChild) secBody.appendChild(gp.firstChild);
      secDet.appendChild(secBody);
      gp.replaceWith(secDet);
    });

    det.append(sum, body);
    c.appendChild(det);
  });
}

// ── Grammar selection → Gemini lookup ─────────────────────────
let _grammarSelectionTimer = null;
let _lastLookupKey = '';

function bindGrammarSelection() {
  const c = $id('grammar-content');
  if (!c) return;
  const handler = () => {
    clearTimeout(_grammarSelectionTimer);
    _grammarSelectionTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString().trim();
      if (text.length < 2 || text.length > 200) return;
      // Only trigger if selection contains Japanese chars
      if (!/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/.test(text)) return;
      // Must be within grammar-content
      const anchor = sel.anchorNode;
      if (!anchor || !c.contains(anchor.nodeType === 1 ? anchor : anchor.parentNode)) return;
      // Open panel in IDLE state — do NOT call API until user clicks the button.
      openGeminiPanelIdle(text);
    }, 250);
  };
  c.addEventListener('mouseup', handler);
  c.addEventListener('touchend', handler);
}

// Open the Gemini panel with the selected text but DO NOT call the API yet.
// User must click the "Sinh câu ví dụ" button to actually generate.
function openGeminiPanelIdle(text) {
  const panel = $id('gemini-panel');
  const selEl = $id('gp-selected');
  const bodyEl = $id('gp-body');
  const titleEl = $id('gp-title');
  panel.classList.remove('hidden');
  selEl.textContent = text;
  titleEl.innerHTML = 'Ví dụ';
  // Check cache so we can show a hint that this text is already cached.
  const cache = loadGeminiCache();
  const cached = cache[normalizeText(text)];
  const btnLabel = cached ? '⚡ Xem câu đã lưu' : '✨ Sinh câu ví dụ';
  bodyEl.innerHTML =
    '<div class="gp-idle">' +
      '<button id="gp-go" class="gp-regen-btn" type="button">' + btnLabel + '</button>' +
      (cached ? '' : '<div class="gp-hint">Bấm nút trên để gọi Gemini đặt 1 câu ví dụ dùng đoạn đã chọn.</div>') +
    '</div>';
  const btn = $id('gp-go');
  if (btn) btn.addEventListener('click', () => showGeminiPanel(text, false));
}

async function showGeminiPanel(text, force = false) {
  const panel = $id('gemini-panel');
  const selEl = $id('gp-selected');
  const bodyEl = $id('gp-body');
  const titleEl = $id('gp-title');
  panel.classList.remove('hidden');
  selEl.textContent = text;
  titleEl.innerHTML = 'Ví dụ';
  bodyEl.innerHTML = '<div class="gp-loading"><div class="gp-spinner"></div><span>Đang sinh ví dụ...</span></div>';
  try {
    const { sentence, fromCache } = await lookupGrammar(text, force);
    titleEl.innerHTML = fromCache ? 'Ví dụ <span class="gp-cache-tag">CACHE</span>' : 'Ví dụ';
    bodyEl.innerHTML =
      '<div class="gp-sentence">' +
        '<div class="gp-jp">' + escapeHtml(sentence.jp) + '</div>' +
        (sentence.romaji ? '<div class="gp-romaji">' + escapeHtml(sentence.romaji) + '</div>' : '') +
        '<div class="gp-vn">' + escapeHtml(sentence.vn || '') + '</div>' +
      '</div>' +
      '<button id="gp-regen" class="gp-regen-btn" type="button">🔄 Đặt câu khác</button>';
    const btn = $id('gp-regen');
    if (btn) btn.addEventListener('click', () => showGeminiPanel(text, true));
  } catch (err) {
    bodyEl.innerHTML = '<div class="gp-error">Lỗi: ' + escapeHtml(err.message || String(err)) + '</div>' +
      '<button id="gp-regen" class="gp-regen-btn" type="button">🔄 Thử lại</button>';
    const btn = $id('gp-regen');
    if (btn) btn.addEventListener('click', () => showGeminiPanel(text, true));
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

// ── Card swipe gesture (study view) ────────────────────────────
// Tap (small move) → reveal. Horizontal drag past threshold → rate.
// Left swipe = "Chưa ổn" (0), Right swipe = "Ổn" (4).
// Only triggers rate when card is already flipped (user has seen the answer).
function bindCardSwipe() {
  const cf = $id('card-flip');
  const inner = $id('cf-inner');
  const SWIPE_PX = 80;        // distance to commit a swipe
  const TAP_PX = 6;           // movement under this = tap
  let startX = 0, startY = 0;
  let dragging = false;
  let pointerId = null;
  let dx = 0;

  const onDown = e => {
    if (cardTransitioning) return;
    // Ignore touches on inner controls (speak/flash nav/rate buttons)
    if (e.target.closest('button')) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    dragging = false;
    try { cf.setPointerCapture(pointerId); } catch {}
  };

  const onMove = e => {
    if (pointerId === null || e.pointerId !== pointerId) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    if (!dragging) {
      if (Math.abs(mx) > TAP_PX && Math.abs(mx) > Math.abs(my)) {
        dragging = true;
      } else if (Math.abs(my) > TAP_PX * 2) {
        // Vertical scroll wins — cancel gesture
        pointerId = null;
        return;
      } else {
        return;
      }
    }
    // Only allow horizontal drag when card is flipped (answer visible)
    if (!flipped) return;
    dx = mx;
    const rot = mx / 20; // subtle tilt
    const opacity = Math.max(0.3, 1 - Math.abs(mx) / 400);
    inner.style.transition = 'none';
    inner.style.transform = `rotateY(180deg) translateX(${-mx}px) rotate(${-rot}deg)`;
    inner.style.opacity = String(opacity);
  };

  const onUp = e => {
    if (pointerId === null || e.pointerId !== pointerId) return;
    const myPid = pointerId;
    pointerId = null;
    try { cf.releasePointerCapture(myPid); } catch {}

    if (!dragging) {
      // Treat as tap → reveal
      reveal();
      return;
    }

    // Reset inline styles before any class-based animation kicks in
    inner.style.transition = '';
    inner.style.transform = '';
    inner.style.opacity = '';

    if (!flipped) return; // safety

    if (Math.abs(dx) >= SWIPE_PX) {
      // Commit rate based on direction
      const q = dx < 0 ? 0 : 4;
      rate(q);
    }
    // else: styles already cleared above → card snaps back
    dx = 0;
    dragging = false;
  };

  cf.addEventListener('pointerdown', onDown);
  cf.addEventListener('pointermove', onMove);
  cf.addEventListener('pointerup', onUp);
  cf.addEventListener('pointercancel', onUp);
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
  $id('mode-vocab-select').addEventListener('click',  () => showList(allVocab, 'T\u1eeb v\u1ef1ng', true));
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
      ? listItems.filter(i => i.front.toLowerCase().includes(q) || i.back.toLowerCase().includes(q) || (i.meaning && i.meaning.toLowerCase().includes(q)))
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
    if (!row || e.target.closest('.li-known-btn')) return;
    pointerDown = true; dragActive = false; dragLastId = null; dragMovedRow = false;
    const id = row.dataset.id;
    pointerStartId = id; dragLastId = id;
    dragValue = !selectedIds.has(id);
    pointerStartX = e.clientX; pointerStartY = e.clientY;
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
    if (!row || e.target.closest('.li-known-btn')) return;
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
  bindCardSwipe();
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
    if (inStudy && !isFlashcardMode) {
      const ratingVisible = $id('rating-bar').classList.contains('visible');
      if (ratingVisible) {
        if (e.key === '1') { e.preventDefault(); rate(0); }
        if (e.key === '2') { e.preventDefault(); rate(4); }
      }
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      toggleDebug();
    }
  });

  // ── Grammar
  $id('grammar-back').addEventListener('click', () => showView('view-home'));
  bindGrammarSelection();
  $id('gp-close').addEventListener('click', () => $id('gemini-panel').classList.add('hidden'));

  // ── Help modal
  const helpModal = $id('help-modal');
  $id('help-btn').addEventListener('click', () => helpModal.classList.remove('hidden'));
  $id('help-close').addEventListener('click', () => helpModal.classList.add('hidden'));
  helpModal.addEventListener('click', e => { if (e.target === helpModal) helpModal.classList.add('hidden'); });
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
