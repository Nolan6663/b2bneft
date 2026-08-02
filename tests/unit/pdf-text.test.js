'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PDFDocument = require('pdfkit');
const { extractPdfText, isPdf, MIN_MEANINGFUL_CHARS } = require('../../lib/pdf-text');

function buildPdf(lines) {
    return new Promise(resolve => {
        const file = path.join(os.tmpdir(), `tz-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
        const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
        const stream = fs.createWriteStream(file);
        doc.pipe(stream);
        doc.font('Helvetica').fontSize(12);
        lines.forEach((l, i) => doc.text(l, 40, 60 + i * 22));
        // Рамка без текста: имитируем графику чертежа
        doc.rect(320, 60, 380, 220).stroke();
        doc.end();
        stream.on('finish', () => resolve(fs.readFileSync(file)));
    });
}

test('распознавание PDF: по MIME и по сигнатуре файла', async () => {
    const buf = await buildPdf(['Test']);
    assert.ok(isPdf('application/pdf', null));
    assert.ok(isPdf('', buf), 'сигнатура %PDF- должна опознаваться без MIME');
    assert.ok(!isPdf('image/png', Buffer.from([0x89, 0x50, 0x4E, 0x47])));
});

test('текстовый слой: штамп чертежа извлекается целиком', async () => {
    const buf = await buildPdf([
        'Flanec privarnoy ploskiy Du100 Ru16 GOST 33259-2015',
        'Material: Stal 09G2S GOST 19281-2014, list 20 mm',
        'Kolichestvo: 40 sht',
        'Ra 6,3 krome uplotnitelnoy poverhnosti Ra 3,2',
    ]);
    const r = await extractPdfText(buf);
    assert.equal(r.hasTextLayer, true);
    assert.equal(r.pages, 1);
    assert.match(r.text, /09G2S/);
    assert.match(r.text, /40 sht/);
    assert.ok(r.text.length >= MIN_MEANINGFUL_CHARS);
});

test('скан без текста: hasTextLayer false, а не пустая карта', async () => {
    const buf = await new Promise(resolve => {
        const file = path.join(os.tmpdir(), `tz-scan-${Date.now()}.pdf`);
        const doc = new PDFDocument({ size: 'A4', margin: 30 });
        const stream = fs.createWriteStream(file);
        doc.pipe(stream);
        doc.rect(50, 50, 400, 300).stroke();
        doc.circle(250, 200, 60).stroke();
        doc.end();
        stream.on('finish', () => resolve(fs.readFileSync(file)));
    });
    const r = await extractPdfText(buf);
    assert.equal(r.hasTextLayer, false);
    assert.equal(r.text, '');
});

test('многостраничный PDF: читаем не больше заданного числа листов', async () => {
    const buf = await new Promise(resolve => {
        const file = path.join(os.tmpdir(), `tz-multi-${Date.now()}.pdf`);
        const doc = new PDFDocument({ size: 'A4', margin: 30 });
        const stream = fs.createWriteStream(file);
        doc.pipe(stream);
        doc.font('Helvetica').fontSize(14);
        for (let i = 1; i <= 5; i++) {
            if (i > 1) doc.addPage();
            doc.text(`List nomer ${i} specification stroka dlya proverki`, 40, 60);
        }
        doc.end();
        stream.on('finish', () => resolve(fs.readFileSync(file)));
    });
    const r = await extractPdfText(buf, { maxPages: 2 });
    assert.equal(r.pages, 5, 'общее число страниц сообщаем честно');
    assert.match(r.text, /List nomer 1/);
    assert.match(r.text, /List nomer 2/);
    assert.ok(!/List nomer 3/.test(r.text), 'третий лист читать не просили');
});
