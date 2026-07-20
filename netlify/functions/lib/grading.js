// Shared grading logic used both when a photographed worksheet already has
// answers written on it (graded immediately) and when the child answers
// on-screen in interactive mode (graded via scan-worksheet-grade). Exact
// string matching (like the rest of the app uses) is too strict for
// OCR-derived or handwritten text, so short free-text answers get a small
// amount of fuzzy tolerance.

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[.,!?;:"'()]/g, '')
    .replace(/\s+/g, ' ');
}

// Classic Levenshtein distance, fine for the short single-word/short-phrase
// answers these worksheets produce (no need for anything fancier).
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
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

const TRUE_WORDS = new Set(['true', 't', 'נכון']);
const FALSE_WORDS = new Set(['false', 'f', 'לא נכון', 'לא']);

function gradeItem(type, studentAnswerRaw, correctAnswerRaw) {
  if (studentAnswerRaw === null || studentAnswerRaw === undefined || String(studentAnswerRaw).trim() === '') {
    return false;
  }
  const student = normalize(studentAnswerRaw);
  const correct = normalize(correctAnswerRaw);

  if (type === 'true_false') {
    const studentBool = TRUE_WORDS.has(student) ? true : FALSE_WORDS.has(student) ? false : null;
    const correctBool = TRUE_WORDS.has(correct) ? true : FALSE_WORDS.has(correct) ? false : null;
    if (studentBool === null || correctBool === null) return student === correct;
    return studentBool === correctBool;
  }

  if (type === 'multiple_choice' || type === 'matching' || type === 'vocabulary') {
    return student === correct;
  }

  // fill_blank / grammar / sentence_completion: allow a small amount of
  // fuzz to tolerate OCR noise or minor spelling slips, scaled to word length.
  if (student === correct) return true;
  const tolerance = correct.length <= 3 ? 0 : correct.length <= 6 ? 1 : 2;
  return levenshtein(student, correct) <= tolerance;
}

// Applies grading to a full worksheet's blocks, filling in isCorrect on each
// item and returning the aggregate score. answersOverride, when given, maps
// itemId -> student answer (used by the interactive/grade flow); otherwise
// each item's own `studentAnswer` (from OCR) is graded as-is.
function gradeWorksheet(blocks, answersOverride) {
  let correct = 0;
  let total = 0;

  const gradedBlocks = blocks.map((block) => {
    const items = block.items.map((item) => {
      const studentAnswer = answersOverride
        ? (answersOverride[item.id] ?? null)
        : (item.studentAnswer ?? null);
      const isCorrect = gradeItem(block.type, studentAnswer, item.correctAnswer);
      total += 1;
      if (isCorrect) correct += 1;
      return {
        id: item.id,
        prompt: item.prompt,
        options: item.options,
        studentAnswer,
        correctAnswer: item.correctAnswer,
        isCorrect,
        explanation: item.explanation || '',
      };
    });
    return { id: block.id, type: block.type, instructions: block.instructions, items };
  });

  const percent = total > 0 ? Math.round((correct / total) * 100) : 0;
  return { blocks: gradedBlocks, score: { correct, total, percent } };
}

// A worksheet is treated as "already answered" if any item anywhere has a
// non-empty detected studentAnswer; otherwise it's blank -> interactive mode.
function worksheetHasAnyAnswers(blocks) {
  return blocks.some((block) =>
    block.items.some((item) => item.studentAnswer !== null && item.studentAnswer !== undefined && String(item.studentAnswer).trim() !== '')
  );
}

module.exports = { normalize, levenshtein, gradeItem, gradeWorksheet, worksheetHasAnyAnswers };
