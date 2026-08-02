'use strict';

/**
 * Текстовый слой PDF-чертежа.
 *
 * Чертёж, выгруженный из CAD, почти всегда несёт текст: штамп, материал, ГОСТы,
 * размеры с допусками. Этого хватает, чтобы собрать техкарту текстовой моделью —
 * рендерить страницу в картинку не нужно, а значит не нужны и нативные зависимости
 * вроде canvas, которых на VPS нет.
 *
 * Скан (фотография листа в PDF) текстового слоя не имеет: такой файл честно
 * отбивается, пользователю предлагается картинка — её читает зрячая модель.
 */

const MIN_MEANINGFUL_CHARS = 40;
const DEFAULT_MAX_PAGES = 3;

let pdfjsPromise = null;
function loadPdfjs() {
    // Динамический импорт: pdfjs поставляется как ESM, а сервер — CommonJS.
    if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
    return pdfjsPromise;
}

function isPdf(mime, buffer) {
    if (String(mime || '').toLowerCase() === 'application/pdf') return true;
    return Buffer.isBuffer(buffer) && buffer.slice(0, 5).toString('latin1') === '%PDF-';
}

/**
 * @returns {Promise<{ text: string, pages: number, hasTextLayer: boolean }>}
 */
async function extractPdfText(buffer, { maxPages = DEFAULT_MAX_PAGES } = {}) {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({
        data: new Uint8Array(buffer),
        useSystemFonts: true,
        isEvalSupported: false,
    }).promise;

    const pages = Math.min(doc.numPages, maxPages);
    const parts = [];
    for (let i = 1; i <= pages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const line = content.items.map(it => (it && it.str) || '').join(' ').replace(/\s+/g, ' ').trim();
        if (line) parts.push(line);
    }
    await doc.destroy().catch(() => {});

    const text = parts.join('\n').trim();
    return { text, pages: doc.numPages, hasTextLayer: text.length >= MIN_MEANINGFUL_CHARS };
}

module.exports = { extractPdfText, isPdf, MIN_MEANINGFUL_CHARS };
