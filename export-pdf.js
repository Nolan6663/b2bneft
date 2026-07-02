'use strict';

const PDFDocument = require('pdfkit');
const path = require('path');
const FONT_DIR = path.join(__dirname, 'assets', 'fonts', 'pdf');
const TZ_INK = '#071B2A';
const TZ_GRAPHITE = '#475569';

function fmtNum(n) {
  if (n == null || n === '') return '—';
  return new Intl.NumberFormat('ru-RU').format(Number(n));
}

function fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('ru-RU');
  } catch {
    return String(d);
  }
}

function pipePdf(res, filename, build, meta = {}) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  doc.registerFont('TZ', path.join(FONT_DIR, 'JetBrainsMono-Regular.ttf'));
  doc.registerFont('TZ-Bold', path.join(FONT_DIR, 'JetBrainsMono-Bold.ttf'));
  doc.font('TZ');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  doc.on('error', () => { if (!res.headersSent) res.status(500).end(); });
  doc.pipe(res);
  build(doc);
  drawTitleBlocks(doc, meta);
  doc.end();
}

// Рамка листа + «основная надпись» (title-block) на каждой странице
function drawTitleBlocks(doc, meta) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const W = doc.page.width, H = doc.page.height;
    doc.save();
    doc.lineWidth(0.8).strokeColor(TZ_INK).rect(20, 20, W - 40, H - 40).stroke();
    const bw = 250, bh = 42, x = W - 20 - bw, y = H - 20 - bh;
    doc.lineWidth(0.8).rect(x, y, bw, bh).stroke();
    doc.moveTo(x, y + 21).lineTo(x + bw, y + 21).stroke();
    doc.moveTo(x + 130, y).lineTo(x + 130, y + bh).stroke();
    doc.font('TZ-Bold').fontSize(7.5).fillColor(TZ_INK)
      .text('ТЕХЗАКАЗ · TEXZAKAZ.RU', x + 8, y + 8, { width: 116, lineBreak: false });
    doc.font('TZ').fontSize(7).fillColor(TZ_GRAPHITE)
      .text(meta.docNo || 'ОТЧЁТ', x + 138, y + 8, { width: bw - 146, lineBreak: false })
      .text(new Date().toLocaleDateString('ru-RU'), x + 8, y + 29, { width: 116, lineBreak: false })
      .text(`ЛИСТ ${i - range.start + 1} / ${range.count}`, x + 138, y + 29, { width: bw - 146, lineBreak: false });
    doc.restore();
  }
}

function buildOrdersPdf(rows, res) {
  pipePdf(res, `zakupki-${Date.now()}.pdf`, (doc) => {
    doc.fontSize(16).fillColor('#1E3A5F').text('Отчёт по прямым закупкам', { align: 'center' });
    doc.fontSize(10).fillColor('#666').text('ТехЗаказ · ' + new Date().toLocaleDateString('ru-RU'), { align: 'center' });
    doc.moveDown(1.2);
    doc.fontSize(9).fillColor('#111');

    if (!rows.length) {
      doc.text('Нет данных для экспорта.');
      return;
    }

    rows.forEach((r, i) => {
      if (i > 0) doc.moveDown(0.6);
      doc.font('TZ-Bold').text(`№${r.id} · ${r.title || '—'}`);
      doc.font('TZ');
      doc.text(`Категория: ${r.category || '—'}    Статус: ${r.status || '—'}`);
      doc.text(`Дедлайн: ${r.deadline || '—'}    Откликов: ${r.proposals ?? 0}`);
      if (r.won_price) doc.text(`Договор: ${fmtNum(r.won_price)} ₽ · ${r.won_supplier || '—'}`);
      doc.text(`Создана: ${fmtDate(r.created_at)}`);
      if (doc.y > 720) doc.addPage();
    });
  }, { docNo: 'РЕЕСТР ЗАКУПОК' });
}

function buildProposalsPdf(rows, res, isProducer) {
  pipePdf(res, `kp-${Date.now()}.pdf`, (doc) => {
    doc.fontSize(16).fillColor('#FF6A00').text('Отчёт по коммерческим предложениям', { align: 'center' });
    doc.fontSize(10).fillColor('#666').text('ТехЗаказ · ' + new Date().toLocaleDateString('ru-RU'), { align: 'center' });
    doc.moveDown(1.2);
    doc.fontSize(9).fillColor('#111');

    if (!rows.length) {
      doc.text('Нет данных для экспорта.');
      return;
    }

    rows.forEach((r, i) => {
      if (i > 0) doc.moveDown(0.6);
      doc.font('TZ-Bold').text(r.order_title || '—');
      doc.font('TZ');
      doc.text(`Категория: ${r.category || '—'}`);
      doc.text(isProducer
        ? `Заказчик: ${r.customer || '—'}`
        : `Поставщик: ${r.supplier || '—'}`);
      doc.text(`Цена: ${fmtNum(r.price)} ₽/шт    Срок: ${r.days != null ? r.days + ' дн.' : '—'}`);
      doc.text(`Статус: ${r.status || '—'}    Дата: ${fmtDate(r.created_at)}`);
      if (doc.y > 720) doc.addPage();
    });
  }, { docNo: 'РЕЕСТР КП' });
}

function buildCompareKpPdf(meta, rows, res) {
  const title = meta.orderTitle || 'Закупка';
  pipePdf(res, `sravnenie-kp-${meta.orderId || Date.now()}.pdf`, (doc) => {
    doc.fontSize(16).fillColor('#1E3A5F').text('Сравнение коммерческих предложений', { align: 'center' });
    doc.fontSize(11).fillColor('#666').text(`«${title}»`, { align: 'center' });
    doc.fontSize(9).fillColor('#888').text(`ТехЗаказ · ${new Date().toLocaleDateString('ru-RU')}`, { align: 'center' });
    doc.moveDown(1);

    if (!rows.length) {
      doc.fontSize(10).fillColor('#111').text('Нет КП для сравнения.');
      return;
    }

    const sorted = [...rows].sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));
    const bestPrice = sorted[0]?.price;

    sorted.forEach((r, i) => {
      if (i > 0) doc.moveDown(0.5);
      const isBest = r.price === bestPrice;
      doc.font('TZ-Bold').fillColor(isBest ? '#0d9488' : '#111')
        .text(`${i + 1}. ${r.supplier || r.company || '—'}${isBest ? '  ★ лучшая цена' : ''}`);
      doc.font('TZ').fillColor('#111');
      doc.text(`Цена: ${fmtNum(r.price)} ₽/шт    Срок: ${r.days != null ? r.days + ' дн.' : '—'}`);
      doc.text(`Статус: ${r.status || '—'}    Дата: ${fmtDate(r.created_at)}`);
      if (r.match_score) doc.text(`Совпадение с закупкой: ${r.match_score}%`);
      if (doc.y > 720) doc.addPage();
    });

    if (meta.benchmark?.enough) {
      doc.moveDown(0.8);
      doc.font('TZ-Bold').text('Бенчмарк по категории (6 мес.):');
      doc.font('TZ');
      doc.text(`Медиана: ${fmtNum(meta.benchmark.median)} ₽    Диапазон: ${fmtNum(meta.benchmark.min)}–${fmtNum(meta.benchmark.max)} ₽`);
    }
  }, { docNo: 'СРАВНЕНИЕ КП' });
}

module.exports = { buildOrdersPdf, buildProposalsPdf, buildCompareKpPdf };
