// ═══════════════════════════════════════════
//  WORKSHEET PDF PROVIDER — the only file that knows PDF rendering is done
//  via PDF.js. Everything else (worksheet-scan.js) only calls
//  WSPdfProvider.renderFirstPage(file); swapping the PDF engine later means
//  replacing this one file's implementation, nothing else.
//
//  Runs entirely in the browser (PDF.js parses/rasterizes in a Web Worker).
//  The PDF file never leaves the device -- it is read directly into memory
//  here, rendered to a canvas, and every reference to it (the document, the
//  raw bytes, the page) is released before this function returns. Nothing
//  about the PDF's contents is logged.
// ═══════════════════════════════════════════

const WSPdfProvider = (function () {
  const MAX_PDF_BYTES = 30 * 1024 * 1024; // 30 MB, checked before any parsing
  const MAX_DIMENSION = 2000; // matches the image path's downscale cap
  const MAX_RENDER_SCALE = 4; // defensive upper bound against degenerate tiny pages

  const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  }

  class PdfError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  // Renders only the first page of the given PDF File to an in-memory
  // canvas, scaled so its long edge is ~MAX_DIMENSION px (computed directly
  // -- never rendered at native resolution and downscaled afterward).
  // Resolves { canvas, isMultiPage, pageCount }. Throws PdfError with a
  // `code` for every failure case; the caller maps codes to user-facing text.
  async function renderFirstPage(file) {
    if (file.size > MAX_PDF_BYTES) {
      throw new PdfError('PDF_TOO_LARGE', 'PDF file exceeds the size limit');
    }
    if (typeof pdfjsLib === 'undefined') {
      throw new PdfError('PDF_ENGINE_UNAVAILABLE', 'PDF engine failed to load');
    }

    let arrayBuffer;
    try {
      arrayBuffer = await file.arrayBuffer();
    } catch {
      throw new PdfError('PDF_READ_FAILED', 'Could not read the file');
    }

    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    } catch (err) {
      arrayBuffer = null;
      if (err && err.name === 'PasswordException') {
        throw new PdfError('PDF_PASSWORD_PROTECTED', 'PDF is password-protected');
      }
      throw new PdfError('PDF_CORRUPTED', 'PDF could not be opened');
    }
    arrayBuffer = null; // pdf.js has its own internal copy by this point

    try {
      if (!pdf.numPages || pdf.numPages < 1) {
        throw new PdfError('PDF_EMPTY', 'PDF has no pages');
      }
      const isMultiPage = pdf.numPages > 1;
      const pageCount = pdf.numPages;

      const page = await pdf.getPage(1);
      try {
        const baseViewport = page.getViewport({ scale: 1 });
        const longEdge = Math.max(baseViewport.width, baseViewport.height);
        const scale = Math.min(MAX_DIMENSION / longEdge, MAX_RENDER_SCALE);
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d');

        await page.render({ canvasContext: ctx, viewport }).promise;

        return { canvas, isMultiPage, pageCount };
      } finally {
        page.cleanup();
      }
    } finally {
      try { await pdf.destroy(); } catch { /* already gone, nothing to clean up */ }
    }
  }

  return { renderFirstPage, PdfError };
})();
