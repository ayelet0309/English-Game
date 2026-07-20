// ═══════════════════════════════════════════
//  WORKSHEET PARSER — pure logic, no DOM, no OCR, no network.
//
//  Takes the (user-corrected) OCR text and turns it into structured items,
//  using simple pattern heuristics only -- there is no AI/semantic model
//  behind this, so exercise-type detection is best-effort and grading is
//  ONLY ever claimed when a deterministic rule applies: either the answer
//  matches text from an explicit answer-key section printed on the
//  worksheet itself, or a fill-blank's inline hint pattern gives us the
//  filled-in word directly. Nothing here ever *infers* correctness from
//  grammar/meaning -- that would require a model this feature deliberately
//  does not use.
//
//  Works both as a browser <script> (attaches to window.WSParser) and via
//  Node's require() (module.exports), so the logic can be unit-tested
//  without a browser or canvas.
// ═══════════════════════════════════════════

(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.WSParser = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {

  function normalize(str) {
    return String(str || '')
      .toLowerCase()
      .trim()
      .replace(/[.,!?;:"'()]/g, '')
      .replace(/\s+/g, ' ');
  }

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j];
        dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
        prev = tmp;
      }
    }
    return dp[n];
  }

  function fuzzyMatches(studentAnswer, correctAnswer) {
    if (studentAnswer === null || studentAnswer === undefined || String(studentAnswer).trim() === '') return false;
    const student = normalize(studentAnswer);
    const correct = normalize(correctAnswer);
    if (student === correct) return true;
    const tolerance = correct.length <= 3 ? 0 : correct.length <= 6 ? 1 : 2;
    return levenshtein(student, correct) <= tolerance;
  }

  // ───── answer-key section detection ─────

  const KEY_HEADING_RE = /(answer\s*key|answers?\s*[:\-]|^\s*key\s*[:\-])/i;

  function splitKeySection(text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (KEY_HEADING_RE.test(lines[i].trim())) {
        return {
          questionsText: lines.slice(0, i).join('\n'),
          keyText: lines.slice(i).join('\n'),
        };
      }
    }
    return { questionsText: text, keyText: '' };
  }

  function parseAnswerKeySection(keyText) {
    const map = {};
    if (!keyText) return map;
    const re = /(\d{1,3})\s*[.):]\s*([\s\S]*?)(?=(?:\s*\d{1,3}\s*[.):])|$)/g;
    let m;
    while ((m = re.exec(keyText)) !== null) {
      const num = parseInt(m[1], 10);
      const ans = m[2].replace(/[,;]+$/, '').trim();
      if (ans) map[num] = ans;
    }
    return map;
  }

  // ───── splitting questions text into candidate items ─────

  function splitIntoItems(questionsText) {
    const numbered = [...questionsText.matchAll(/(\d{1,3})\s*[.):]\s*([\s\S]*?)(?=(?:\n\s*\d{1,3}\s*[.):])|$)/g)];
    if (numbered.length >= 2) {
      return numbered
        .map((m) => ({ number: parseInt(m[1], 10), raw: m[2].trim() }))
        .filter((i) => i.raw.length > 0);
    }
    return questionsText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((raw, i) => ({ number: i + 1, raw }));
  }

  // ───── per-item exercise-type classification ─────

  const TF_MARKER_RE = /\(\s*true\s*\/\s*false\s*\)/i;
  const UNDERSCORE_RE = /_{2,}/;
  // An explicit "-> answer" / "→ answer" marker is the ONLY signal we trust
  // for "this blank was already filled in" -- deliberately NOT inferring it
  // from "the word right before a (hint)", since real OCR output frequently
  // drops faint underscore blanks entirely, which would otherwise make the
  // sentence's own subject (e.g. "She", "They") look like a filled-in
  // answer. Better to under-detect than to falsely claim an answer exists.
  const ARROW_ANSWER_RE = /(?:->|→)\s*(\S+)/;
  const MC_OPTION_RE = /(?:^|\s)([a-dA-D])[.)]\s+([\s\S]*?)(?=(?:\s[a-dA-D][.)]\s)|$)/g;

  function classifyItem(item) {
    const raw = item.raw;

    const tf = raw.match(TF_MARKER_RE);
    if (tf) {
      const before = raw.slice(0, tf.index).trim();
      const after = raw.slice(tf.index + tf[0].length).replace(/^[\s\->→:.,]+/, '').trim();
      const answerMatch = after.match(/^(true|false)/i);
      return {
        number: item.number,
        type: 'true_false',
        prompt: before,
        options: ['True', 'False'],
        studentAnswer: answerMatch ? answerMatch[1] : null,
        recognized: true,
      };
    }

    const mcOptions = [...raw.matchAll(MC_OPTION_RE)];
    if (mcOptions.length >= 2) {
      const prompt = raw.slice(0, mcOptions[0].index).trim();
      return {
        number: item.number,
        type: 'multiple_choice',
        prompt,
        options: mcOptions.map((m) => m[2].trim().replace(/[,.]+$/, '')),
        studentAnswer: null,
        recognized: true,
      };
    }

    // Checked before the plain underscore-run case: a worksheet can show
    // both the original printed blank ("______") AND the child's answer
    // written in via an arrow -- the arrow is the more specific signal and
    // must win.
    const arrow = raw.match(ARROW_ANSWER_RE);
    if (arrow) {
      return {
        number: item.number,
        type: 'fill_blank',
        prompt: raw.slice(0, arrow.index).trim(),
        options: null,
        studentAnswer: arrow[1].replace(/[.,!?;:]+$/, ''),
        recognized: true,
      };
    }

    if (UNDERSCORE_RE.test(raw)) {
      return {
        number: item.number,
        type: 'fill_blank',
        prompt: raw,
        options: null,
        studentAnswer: null,
        recognized: true,
      };
    }

    // Short "word - translation" / "word = translation" style vocabulary line.
    const vocab = raw.match(/^([^\-=:]{1,40})[\-=:]\s*(.*)$/);
    if (vocab && raw.split(/\s+/).length <= 8) {
      return {
        number: item.number,
        type: 'vocabulary',
        prompt: vocab[1].trim(),
        options: null,
        studentAnswer: vocab[2].trim() || null,
        recognized: true,
      };
    }

    return {
      number: item.number,
      type: 'unknown',
      prompt: raw,
      options: null,
      studentAnswer: null,
      recognized: false,
    };
  }

  // ───── top-level entry point ─────

  // Returns:
  //   { recognized: bool, hasAnswerKey: bool, items: [...] }
  // `recognized` is false when we couldn't confidently identify any
  // supported exercise structure at all -- callers should fall back to
  // showing the raw corrected text with the "we could not automatically
  // understand this worksheet" message, per the no-false-claims requirement.
  function parseWorksheetText(rawText) {
    const text = String(rawText || '').replace(/\r\n/g, '\n');
    const { questionsText, keyText } = splitKeySection(text);
    const answerKeyMap = parseAnswerKeySection(keyText);
    const hasAnswerKey = Object.keys(answerKeyMap).length > 0;

    const rawItems = splitIntoItems(questionsText);
    const items = rawItems.map(classifyItem);

    const recognizedCount = items.filter((i) => i.recognized).length;
    const recognized = items.length > 0 && recognizedCount / items.length >= 0.5;

    if (hasAnswerKey) {
      items.forEach((item) => {
        if (answerKeyMap[item.number] !== undefined) {
          item.correctAnswer = answerKeyMap[item.number];
        }
      });
    }

    return { recognized, hasAnswerKey, items };
  }

  // Grades only items that have both a correctAnswer (from an answer-key
  // section) and a studentAnswer (detected inline or supplied via
  // `answersOverride`, keyed by item number, from interactive mode). Every
  // other item is left ungraded (isCorrect: null) -- never guessed.
  function gradeItems(items, answersOverride) {
    let correct = 0;
    let gradable = 0;

    const graded = items.map((item) => {
      const studentAnswer = answersOverride && answersOverride[item.number] !== undefined
        ? answersOverride[item.number]
        : item.studentAnswer;
      const out = { ...item, studentAnswer };
      if (item.correctAnswer !== undefined) {
        gradable += 1;
        out.isCorrect = fuzzyMatches(studentAnswer, item.correctAnswer);
        if (out.isCorrect) correct += 1;
      } else {
        out.isCorrect = null;
      }
      return out;
    });

    return { items: graded, score: { correct, gradable, total: items.length } };
  }

  return { normalize, levenshtein, fuzzyMatches, parseWorksheetText, gradeItems };
});
