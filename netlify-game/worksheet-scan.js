// ═══════════════════════════════════════════
//  WORKSHEET SCAN — child-facing scan & auto-grade feature
//
//  Talks only to /.netlify/functions/scan-worksheet-extract and
//  /.netlify/functions/scan-worksheet-grade. The image is held in memory
//  only for the duration of a scan and is never written to localStorage,
//  Firebase, or anywhere else. Only the structured grading result (no
//  image data) is persisted, via the same load()/save() mechanism the rest
//  of the app already uses for eg_sessions etc.
// ═══════════════════════════════════════════

const WS_EXTRACT_URL = '/.netlify/functions/scan-worksheet-extract';
const WS_GRADE_URL = '/.netlify/functions/scan-worksheet-grade';
const WS_FETCH_TIMEOUT_MS = 30000;

const WS_TYPE_LABELS = {
  fill_blank: '📝 השלמת מילים',
  multiple_choice: '🔘 בחירה מרובה',
  matching: '🔗 התאמה',
  true_false: '✅ נכון / לא נכון',
  vocabulary: '📖 אוצר מילים',
  grammar: '✏️ דקדוק',
  sentence_completion: '💬 השלמת משפטים',
};

const WS_ERROR_MESSAGES = {
  INVALID_REQUEST: 'הבקשה לא תקינה, נסי שוב',
  UNREADABLE_IMAGE: 'לא הצלחנו לקרוא את התמונה — נסי תאורה טובה יותר וזווית ישרה יותר',
  UNSUPPORTED_WORKSHEET: 'לא זיהינו דף עבודה בתמונה — נסי לצלם את כל הדף בבירור',
  VALIDATION_FAILED: 'לא הצלחנו לנתח את הדף הזה, נסי תמונה ברורה וישרה יותר',
  UPSTREAM_ERROR: 'שירות הזיהוי אינו זמין כרגע, נסי שוב בעוד רגע',
  TOKEN_EXPIRED: 'הסריקה הזו פגה, אפשר לסרוק את הדף מחדש',
  TOKEN_INVALID: 'אירעה שגיאה, אפשר לסרוק את הדף מחדש',
  METHOD_NOT_ALLOWED: 'שגיאת מערכת, נסי שוב',
  INTERNAL_ERROR: 'משהו השתבש, נסי שוב',
};

let wsState = {
  imageBase64: null,
  mimeType: null,
  worksheetId: null,
  token: null,
  title: null,
  blocks: null,
  answers: {},
};

class WSError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// ───── HTML escaping — worksheet text comes from a photographed image via
// a vision model, so it is untrusted input and must never be inserted into
// innerHTML unescaped. ─────
function wsEsc(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

function wsErrorMessage(err) {
  return (err && WS_ERROR_MESSAGES[err.code]) || 'משהו השתבש, נסי שוב';
}

// ───── DATA LAYER ─────

function getWorksheetScans() { return load(KEYS.WORKSHEET_SCANS, []); }
function saveWorksheetScans(scans) { save(KEYS.WORKSHEET_SCANS, scans); }

function wsSaveScanRecord(result) {
  const scans = getWorksheetScans();
  scans.unshift({
    id: 'ws_' + Date.now(),
    date: todayStr(),
    timestamp: Date.now(),
    title: result.title || '',
    score: result.score,
    blocks: result.blocks,
  });
  saveWorksheetScans(scans.slice(0, 200));
  incDailyAct('scan');
}

// ───── NETWORK ─────

async function wsFetchJson(url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WS_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new WSError('הבקשה ארכה זמן רב מדי', 'UPSTREAM_ERROR');
    throw new WSError('אין חיבור לאינטרנט, בדקי ונסי שוב', 'UPSTREAM_ERROR');
  }
  clearTimeout(timer);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new WSError('תגובה לא תקינה מהשרת', 'UPSTREAM_ERROR');
  }
  if (!data.ok) {
    throw new WSError(data.error && data.error.message, data.error && data.error.code);
  }
  return data;
}

// ───── SCAN ENTRY / IMAGE CAPTURE ─────

function wsOpenScan() {
  wsResetState();
  showScreen('screen-scan-worksheet');
}

function wsResetState() {
  wsState = { imageBase64: null, mimeType: null, worksheetId: null, token: null, title: null, blocks: null, answers: {} };
  const input = document.getElementById('ws-file-input');
  if (input) input.value = '';
  const img = document.getElementById('ws-preview-img');
  if (img) { img.src = ''; img.style.display = 'none'; }
  const btn = document.getElementById('ws-scan-btn');
  if (btn) btn.disabled = true;
  wsSetStatus('');
}

function wsQuitScan() {
  if (confirm('לצאת מהסריקה?')) {
    wsResetState();
    showScreen('screen-home');
  }
}

function wsSetStatus(message, kind) {
  const el = document.getElementById('ws-status');
  if (!el) return;
  if (!message) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = 'block';
  el.textContent = message;
  el.style.background = kind === 'error' ? '#fee2e2' : '#e0e7ff';
  el.style.color = kind === 'error' ? 'var(--danger)' : 'var(--primary)';
}

function wsSetInteractiveStatus(message, kind) {
  const el = document.getElementById('ws-interactive-status');
  if (!el) return;
  if (!message) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.textContent = message;
  el.style.background = kind === 'error' ? '#fee2e2' : '#e0e7ff';
  el.style.color = kind === 'error' ? 'var(--danger)' : 'var(--primary)';
}

function wsCompressImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!file.type || !file.type.startsWith('image/')) {
      reject(new Error('not-an-image'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read-failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('decode-failed'));
      img.onload = () => {
        const maxDim = 1600;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round((height * maxDim) / width); width = maxDim; }
          else { width = Math.round((width * maxDim) / height); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        const base64 = dataUrl.split(',')[1];
        resolve({ base64, mimeType: 'image/jpeg', previewUrl: dataUrl });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function wsOnFileSelected(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  wsSetStatus('');
  document.getElementById('ws-scan-btn').disabled = true;
  try {
    const { base64, mimeType, previewUrl } = await wsCompressImageFile(file);
    wsState.imageBase64 = base64;
    wsState.mimeType = mimeType;
    const img = document.getElementById('ws-preview-img');
    img.src = previewUrl;
    img.style.display = 'block';
    document.getElementById('ws-scan-btn').disabled = false;
  } catch {
    wsSetStatus('לא הצלחנו לקרוא את התמונה הזו, נסי לבחור תמונה אחרת', 'error');
  }
}

async function wsStartScan() {
  if (!wsState.imageBase64) return;
  showScreen('screen-scan-processing');
  try {
    const res = await wsFetchJson(WS_EXTRACT_URL, {
      imageBase64: wsState.imageBase64,
      mimeType: wsState.mimeType,
    });
    // The image has done its job -- drop it from memory now.
    wsState.imageBase64 = null;

    if (res.mode === 'interactive') {
      wsState.worksheetId = res.worksheetId;
      wsState.token = res.token;
      wsState.title = res.title;
      wsState.blocks = res.blocks;
      wsRenderReview();
      showScreen('screen-scan-review');
    } else {
      wsSaveScanRecord(res);
      wsRenderResults(res);
      showScreen('screen-scan-results');
    }
  } catch (err) {
    showScreen('screen-scan-worksheet');
    wsSetStatus('⚠️ ' + wsErrorMessage(err), 'error');
  }
}

// ───── REVIEW (confirm-or-rescan safety step before grading/answering) ─────

function wsRenderReview() {
  document.getElementById('ws-review-title').textContent = wsState.title || 'דף עבודה';
  const list = document.getElementById('ws-review-list');
  list.innerHTML = wsState.blocks.map((block) => `
    <div class="card" style="gap:8px;display:flex;flex-direction:column">
      <div style="font-weight:700;color:var(--primary)">${wsEsc(WS_TYPE_LABELS[block.type] || block.type)}</div>
      ${block.instructions ? `<div style="font-size:13px;color:var(--muted)">${wsEsc(block.instructions)}</div>` : ''}
      <div style="font-size:13px;direction:ltr;text-align:left;line-height:1.7">
        ${block.items.map((item) => `• ${wsEsc(item.prompt)}`).join('<br>')}
      </div>
    </div>
  `).join('');
}

function wsConfirmReview() {
  wsRenderInteractive();
  showScreen('screen-scan-interactive');
}

function wsRescan() {
  wsResetState();
  showScreen('screen-scan-worksheet');
}

// ───── INTERACTIVE ANSWERING (blank worksheets) ─────

function wsRenderInteractive() {
  wsState.answers = {};
  wsSetInteractiveStatus('');
  const container = document.getElementById('ws-interactive-blocks');
  container.innerHTML = wsState.blocks.map((block) => {
    const itemsHtml = block.items.map((item) => wsRenderInteractiveItem(block, item)).join('');
    return `<div class="card" style="gap:4px;display:flex;flex-direction:column;margin-bottom:12px">
      <div style="font-weight:700;color:var(--primary)">${wsEsc(WS_TYPE_LABELS[block.type] || block.type)}</div>
      ${block.instructions ? `<div style="font-size:13px;color:var(--muted);margin-bottom:6px">${wsEsc(block.instructions)}</div>` : ''}
      ${itemsHtml}
    </div>`;
  }).join('');
}

function wsRenderInteractiveItem(block, item) {
  const promptHtml = `<div style="direction:ltr;text-align:left;font-weight:600;margin-bottom:8px">${wsEsc(item.prompt)}</div>`;
  const itemIdAttr = wsEsc(item.id);

  if (block.type === 'multiple_choice' || block.type === 'true_false') {
    const opts = block.type === 'true_false' ? ['True', 'False'] : (item.options || []);
    return `<div style="margin-bottom:16px" role="group" aria-label="${wsEsc(item.prompt)}">
      ${promptHtml}
      <div class="choices" style="grid-template-columns:1fr 1fr">
        ${opts.map((opt) => `<button type="button" class="choice-btn" data-item="${itemIdAttr}" data-value="${wsEsc(opt)}" onclick="wsSelectChoice(this)">${wsEsc(opt)}</button>`).join('')}
      </div>
    </div>`;
  }

  if (block.type === 'matching' || (block.type === 'vocabulary' && (item.options || []).length > 0)) {
    const opts = item.options || [];
    return `<div style="margin-bottom:16px">
      ${promptHtml}
      <select data-item="${itemIdAttr}" onchange="wsSelectMatch(this)" aria-label="${wsEsc(item.prompt)}"
        style="width:100%;padding:10px;border:2px solid var(--border);border-radius:10px;direction:ltr;font-size:15px;background:white;color:#1e1b4b">
        <option value="">-- בחרי --</option>
        ${opts.map((opt) => `<option value="${wsEsc(opt)}">${wsEsc(opt)}</option>`).join('')}
      </select>
    </div>`;
  }

  // fill_blank / grammar / sentence_completion / plain vocabulary
  return `<div style="margin-bottom:16px">
    ${promptHtml}
    <input type="text" data-item="${itemIdAttr}" oninput="wsSelectText(this)" dir="ltr" aria-label="${wsEsc(item.prompt)}"
      style="width:100%;padding:10px;border:2px solid var(--border);border-radius:10px;direction:ltr;text-align:left;font-size:16px;background:white;color:#1e1b4b">
  </div>`;
}

function wsSelectChoice(btn) {
  const itemId = btn.dataset.item;
  document.querySelectorAll('.choice-btn[data-item]').forEach((b) => {
    if (b.dataset.item === itemId) {
      b.style.background = '';
      b.style.color = '';
      b.style.borderColor = '';
    }
  });
  btn.style.background = 'var(--primary)';
  btn.style.color = 'white';
  btn.style.borderColor = 'var(--primary)';
  wsState.answers[itemId] = btn.dataset.value;
}

function wsSelectMatch(sel) {
  wsState.answers[sel.dataset.item] = sel.value;
}

function wsSelectText(input) {
  wsState.answers[input.dataset.item] = input.value;
}

function wsQuitInteractive() {
  if (confirm('לצאת בלי לשלוח את התשובות?')) {
    wsResetState();
    showScreen('screen-home');
  }
}

async function wsSubmitAnswers() {
  const hasAnyAnswer = Object.values(wsState.answers).some((v) => v && String(v).trim() !== '');
  if (!hasAnyAnswer) {
    wsSetInteractiveStatus('כדאי לענות על לפחות שאלה אחת לפני הבדיקה', 'error');
    return;
  }
  showScreen('screen-scan-processing');
  try {
    const res = await wsFetchJson(WS_GRADE_URL, {
      worksheetId: wsState.worksheetId,
      token: wsState.token,
      answers: wsState.answers,
    });
    wsState.token = null;
    wsSaveScanRecord(res);
    wsRenderResults(res);
    showScreen('screen-scan-results');
  } catch (err) {
    showScreen('screen-scan-interactive');
    wsSetInteractiveStatus('⚠️ ' + wsErrorMessage(err), 'error');
  }
}

// ───── RESULTS ─────

function wsRenderResults(result) {
  const pct = result.score.percent;
  document.getElementById('ws-result-pct').textContent = pct + '%';
  document.getElementById('ws-result-stars').textContent = pct >= 90 ? '⭐⭐⭐' : pct >= 70 ? '⭐⭐' : '⭐';
  document.getElementById('ws-result-msg').textContent =
    pct >= 90 ? 'מדהים! שליטה מלאה בדף! 🎉' :
    pct >= 70 ? 'עבודה טובה! 👏' :
    pct >= 50 ? 'לא רע, כדאי לתרגל עוד קצת 💪' :
    'בואי ננסה שוב — כל טעות היא הזדמנות ללמוד 💡';
  document.getElementById('ws-result-sub').textContent = `${result.score.correct} נכון מתוך ${result.score.total} — ${result.title || ''}`;

  const container = document.getElementById('ws-result-breakdown');
  container.innerHTML = result.blocks.map((block) => `
    <div class="card" style="gap:6px;display:flex;flex-direction:column;margin-bottom:10px">
      <div style="font-weight:700;color:var(--primary);font-size:14px">${wsEsc(WS_TYPE_LABELS[block.type] || block.type)}</div>
      ${block.items.map((item) => `
        <div class="word-row ${item.isCorrect ? 'ok' : 'fail'}" style="flex-direction:column;align-items:stretch;gap:4px;padding:10px 12px">
          <div style="display:flex;justify-content:space-between;gap:8px">
            <span style="direction:ltr;text-align:left;flex:1">${wsEsc(item.prompt)}</span>
            <span>${item.isCorrect ? '✅' : '❌'}</span>
          </div>
          <div style="font-size:12px;direction:ltr;text-align:left;color:var(--muted)">
            ${item.studentAnswer ? `your answer: ${wsEsc(item.studentAnswer)}` : 'לא נענה'}
            ${!item.isCorrect ? ` — correct: ${wsEsc(item.correctAnswer)}` : ''}
          </div>
          ${item.explanation ? `<div style="font-size:12px;color:var(--text);background:var(--bg);border-radius:8px;padding:6px 8px;direction:ltr;text-align:left">${wsEsc(item.explanation)}</div>` : ''}
        </div>
      `).join('')}
    </div>
  `).join('');
}
