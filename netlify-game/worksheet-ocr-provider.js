// ═══════════════════════════════════════════
//  WORKSHEET OCR PROVIDER — the only file that knows OCR is done via
//  Tesseract.js. Everything else (worksheet-parser.js, worksheet-scan.js)
//  only calls WSOcrProvider.recognize(); swapping to a different OCR/vision
//  engine later means replacing this one file's implementation, nothing
//  else.
//
//  Runs entirely in the browser (Tesseract.js compiles to WebAssembly and
//  executes in a Web Worker). The image never leaves the device -- it is
//  handed directly to the local worker, never uploaded anywhere.
// ═══════════════════════════════════════════

const WSOcrProvider = (function () {
  async function recognize(imageSource, onProgress) {
    if (typeof Tesseract === 'undefined') {
      throw new Error('OCR engine failed to load (check your internet connection and try again)');
    }
    const worker = await Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (onProgress && m.status === 'recognizing text' && typeof m.progress === 'number') {
          onProgress(m.progress);
        }
      },
    });
    try {
      const { data } = await worker.recognize(imageSource);
      return data.text || '';
    } finally {
      await worker.terminate();
    }
  }

  return { recognize };
})();
