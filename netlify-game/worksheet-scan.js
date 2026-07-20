// ═══════════════════════════════════════════
//  WORKSHEET SCAN — child-facing scan & (best-effort) grading flow.
//
//  100% client-side: OCR runs in the browser via WSOcrProvider (Tesseract.js,
//  see worksheet-ocr-provider.js), and structure/grading logic is pure JS
//  (see worksheet-parser.js). No image, and no extracted text, is ever sent
//  to a server -- there is no server involved in this feature at all. The
//  image is held in memory only long enough to run OCR on it and is then
//  discarded; only the final structured result (no image data) is persisted,
//  via the same load()/save() mechanism the rest of the app already uses.
//
//  Because there is no AI/semantic model here, this file never claims an
//  answer is "correct" unless a deterministic rule applies (an answer-key
//  section detected on the worksheet, or an explicit inline fill-in). See
//  worksheet-parser.js for exactly what is and isn't inferred.
// ═══════════════════════════════════════════

const WS_TYPE_LABELS = {
  fill_blank: '📝 השלמת מילים',
  multiple_choice: '🔘 בחירה מרובה',
  true_false: '✅ נכון / לא נכון',
  vocabulary: '📖 אוצר מילים',
  unknown: '❓ לא זוהה',
};

let wsState = {
  imageBitmap: null, // canvas holding the (downscaled) photo, discarded after OCR
  ocrText: '',
  parseResult: null, // { recognized, hasAnswerKey, items }
  answers: {}, // itemNumber -> typed/selected answer, interactive mode only
};

// ───── DATA LAYER (persists only the structured result, never the image) ─────

function getWorksheetScans() { return load(KEYS.WORKSHEET_SCANS, []); }
function saveWorksheetScans(scans) { save(KEYS.WORKSHEET_SCANS, scans); }

function wsSaveScanRecord(gradedItems, score, hasAnswerKey) {
  const scans = getWorksheetScans();
  scans.unshift({
    id: 'ws_' + Date.now(),
    date: todayStr(),
    timestamp: Date.now(),
    hasAnswerKey,
    score,
    items: gradedItems,
  });
  saveWorksheetScans(scans.slice(0, 200));
  incDailyAct('scan');
}

// ───── HTML escaping — extracted text is untrusted input (OCR of a photo,
// possibly user-edited) and must never be inserted into innerHTML raw. ─────
function wsEsc(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

// ───── SCAN ENTRY / IMAGE CAPTURE ─────

function wsOpenScan() {
  wsResetState();
  showScreen('screen-scan-worksheet');
}

function wsResetState() {
  wsState = { imageBitmap: null, ocrText: '', parseResult: null, answers: {} };
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

// Downscales the photo onto a canvas (kept only in memory) -- this both
// speeds up OCR and means we never hold a huge original image in memory.
function wsLoadImageToCanvas(file) {
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
        const maxDim = 2000; // a bit larger than the old server flow -- OCR benefits from resolution
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
        resolve({ canvas, previewUrl: canvas.toDataURL('image/jpeg', 0.85) });
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
    const { canvas, previewUrl } = await wsLoadImageToCanvas(file);
    wsState.imageBitmap = canvas;
    const img = document.getElementById('ws-preview-img');
    img.src = previewUrl;
    img.style.display = 'block';
    document.getElementById('ws-scan-btn').disabled = false;
  } catch {
    wsSetStatus('לא הצלחנו לקרוא את התמונה הזו, נסי לבחור תמונה אחרת', 'error');
  }
}

async function wsStartScan() {
  if (!wsState.imageBitmap) return;
  showScreen('screen-scan-processing');
  wsSetOcrProgress(0);
  try {
    const text = await WSOcrProvider.recognize(wsState.imageBitmap, wsSetOcrProgress);
    // The image has done its job -- drop it from memory now. Nothing about
    // it (pixels or a reference) is kept anywhere from this point on.
    wsState.imageBitmap = null;
    wsState.ocrText = text;

    if (!text || !text.trim()) {
      showScreen('screen-scan-worksheet');
      wsSetStatus('⚠️ לא זוהה טקסט בתמונה -- נסי תאורה טובה יותר וזווית ישרה יותר', 'error');
      return;
    }

    document.getElementById('ws-ocr-textarea').value = text.trim();
    showScreen('screen-scan-review');
  } catch (err) {
    showScreen('screen-scan-worksheet');
    wsSetStatus('⚠️ ' + (err && err.message ? err.message : 'קריאת הטקסט נכשלה, נסי שוב'), 'error');
  }
}

function wsSetOcrProgress(fraction) {
  const fill = document.getElementById('ws-ocr-progress-fill');
  const text = document.getElementById('ws-ocr-progress-text');
  const pct = Math.round((fraction || 0) * 100);
  if (fill) fill.style.width = pct + '%';
  if (text) text.textContent = pct + '%';
}

// ───── REVIEW (mandatory manual-correction step before any parsing) ─────

function wsConfirmReview() {
  const correctedText = document.getElementById('ws-ocr-textarea').value;
  wsState.ocrText = correctedText;
  wsState.parseResult = WSParser.parseWorksheetText(correctedText);

  if (!wsState.parseResult.recognized) {
    wsRenderUnrecognizedResults(correctedText);
    showScreen('screen-scan-results');
    return;
  }

  const needsInteractive = wsState.parseResult.items.some((i) => i.recognized && (i.studentAnswer === null || i.studentAnswer === undefined));
  if (needsInteractive) {
    wsRenderInteractive();
    showScreen('screen-scan-interactive');
  } else {
    wsFinishAndShowResults();
  }
}

function wsRescan() {
  wsResetState();
  showScreen('screen-scan-worksheet');
}

// ───── INTERACTIVE ANSWERING (items with no detected answer yet) ─────

function wsRenderInteractive() {
  wsState.answers = {};
  wsSetInteractiveStatus('');
  const container = document.getElementById('ws-interactive-blocks');
  const items = wsState.parseResult.items.filter((i) => i.recognized);

  container.innerHTML = `<div class="card" style="gap:4px;display:flex;flex-direction:column">
    ${items.map((item) => wsRenderInteractiveItem(item)).join('')}
  </div>`;
}

function wsRenderInteractiveItem(item) {
  const promptHtml = `<div style="direction:ltr;text-align:left;font-weight:600;margin-bottom:8px">${wsEsc(item.prompt)}</div>`;
  const numAttr = item.number;

  if (item.studentAnswer !== null && item.studentAnswer !== undefined) {
    // Already has a detected answer (e.g. inline fill-in) -- show read-only.
    return `<div style="margin-bottom:16px">
      ${promptHtml}
      <div style="direction:ltr;text-align:left;font-size:13px;color:var(--muted)">✔ זוהתה תשובה: ${wsEsc(item.studentAnswer)}</div>
    </div>`;
  }

  if (item.type === 'multiple_choice' || item.type === 'true_false') {
    const opts = item.type === 'true_false' ? ['True', 'False'] : (item.options || []);
    return `<div style="margin-bottom:16px" role="group" aria-label="${wsEsc(item.prompt)}">
      ${promptHtml}
      <div class="choices" style="grid-template-columns:1fr 1fr">
        ${opts.map((opt) => `<button type="button" class="choice-btn" data-item="${numAttr}" data-value="${wsEsc(opt)}" onclick="wsSelectChoice(this)">${wsEsc(opt)}</button>`).join('')}
      </div>
    </div>`;
  }

  // fill_blank / vocabulary
  return `<div style="margin-bottom:16px">
    ${promptHtml}
    <input type="text" data-item="${numAttr}" oninput="wsSelectText(this)" dir="ltr" aria-label="${wsEsc(item.prompt)}"
      style="width:100%;padding:10px;border:2px solid var(--border);border-radius:10px;direction:ltr;text-align:left;font-size:16px;background:white;color:#1e1b4b">
  </div>`;
}

function wsSelectChoice(btn) {
  const itemNum = btn.dataset.item;
  document.querySelectorAll('.choice-btn[data-item="' + itemNum + '"]').forEach((b) => {
    b.style.background = '';
    b.style.color = '';
    b.style.borderColor = '';
  });
  btn.style.background = 'var(--primary)';
  btn.style.color = 'white';
  btn.style.borderColor = 'var(--primary)';
  wsState.answers[itemNum] = btn.dataset.value;
}

function wsSelectText(input) {
  wsState.answers[input.dataset.item] = input.value;
}

function wsQuitInteractive() {
  if (confirm('לצאת בלי לסיים לענות?')) {
    wsResetState();
    showScreen('screen-home');
  }
}

function wsSubmitAnswers() {
  wsFinishAndShowResults();
}

// ───── RESULTS ─────

function wsFinishAndShowResults() {
  // Merge: numeric-keyed answers collected in interactive mode override
  // (only for items that didn't already have a detected inline answer).
  const answersByNumber = {};
  wsState.parseResult.items.forEach((item) => {
    answersByNumber[item.number] = item.studentAnswer;
  });
  Object.keys(wsState.answers).forEach((k) => {
    answersByNumber[Number(k)] = wsState.answers[k];
  });

  const { items: graded, score } = WSParser.gradeItems(wsState.parseResult.items, answersByNumber);
  wsSaveScanRecord(graded, score, wsState.parseResult.hasAnswerKey);
  wsRenderResults(graded, score, wsState.parseResult.hasAnswerKey);
  showScreen('screen-scan-results');
}

function wsRenderUnrecognizedResults(rawText) {
  document.getElementById('ws-result-unrecognized').style.display = 'flex';
  document.getElementById('ws-result-normal').style.display = 'none';
  document.getElementById('ws-result-raw-text').textContent = rawText;
}

function wsRenderResults(items, score, hasAnswerKey) {
  document.getElementById('ws-result-unrecognized').style.display = 'none';
  document.getElementById('ws-result-normal').style.display = 'block';

  const gradable = score.gradable > 0;
  document.getElementById('ws-result-score-block').style.display = gradable ? 'block' : 'none';
  document.getElementById('ws-result-no-key-note').style.display = gradable ? 'none' : 'flex';

  if (gradable) {
    const pct = Math.round((score.correct / score.gradable) * 100);
    document.getElementById('ws-result-pct').textContent = pct + '%';
    document.getElementById('ws-result-stars').textContent = pct >= 90 ? '⭐⭐⭐' : pct >= 70 ? '⭐⭐' : '⭐';
    document.getElementById('ws-result-msg').textContent =
      pct >= 90 ? 'מדהים! שליטה מלאה בדף! 🎉' :
      pct >= 70 ? 'עבודה טובה! 👏' :
      pct >= 50 ? 'לא רע, כדאי לתרגל עוד קצת 💪' :
      'בואי ננסה שוב 💡';
    document.getElementById('ws-result-sub').textContent = `${score.correct} נכון מתוך ${score.gradable} (מתוך ${score.total} שאלות בסך הכל)`;
  } else {
    document.getElementById('ws-result-msg').textContent = 'התרגול הושלם';
    document.getElementById('ws-result-sub').textContent = `${score.total} שאלות זוהו`;
  }

  const container = document.getElementById('ws-result-breakdown');
  container.innerHTML = items.map((item) => {
    const statusIcon = item.isCorrect === true ? '✅' : item.isCorrect === false ? '❌' : '➖';
    const rowClass = item.isCorrect === true ? 'ok' : item.isCorrect === false ? 'fail' : '';
    return `
      <div class="word-row ${rowClass}" style="flex-direction:column;align-items:stretch;gap:4px;padding:10px 12px">
        <div style="display:flex;justify-content:space-between;gap:8px">
          <span style="font-size:11px;color:var(--muted)">${wsEsc(WS_TYPE_LABELS[item.type] || item.type)}</span>
          <span>${statusIcon}</span>
        </div>
        <div style="direction:ltr;text-align:left">${wsEsc(item.prompt)}</div>
        <div style="font-size:12px;direction:ltr;text-align:left;color:var(--muted)">
          ${item.studentAnswer ? `answer: ${wsEsc(item.studentAnswer)}` : 'לא נענה'}
          ${item.isCorrect === false && item.correctAnswer ? ` — key: ${wsEsc(item.correctAnswer)}` : ''}
        </div>
      </div>`;
  }).join('');
}
