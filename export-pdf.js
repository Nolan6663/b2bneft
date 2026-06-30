'use strict';

const PDFDocument = require('pdfkit');

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

function pipePdf(res, filename, build) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  doc.on('error', () => { if (!res.headersSent) res.status(500).end(); });
  doc.pipe(res);
  build(doc);
  doc.end();
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
      doc.font('Helvetica-Bold').text(`№${r.id} · ${r.title || '—'}`);
      doc.font('Helvetica');
      doc.text(`Категория: ${r.category || '—'}    Статус: ${r.status || '—'}`);
      doc.text(`Дедлайн: ${r.deadline || '—'}    Откликов: ${r.proposals ?? 0}`);
      if (r.won_price) doc.text(`Договор: ${fmtNum(r.won_price)} ₽ · ${r.won_supplier || '—'}`);
      doc.text(`Создана: ${fmtDate(r.created_at)}`);
      if (doc.y > 720) doc.addPage();
    });
  });
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
      doc.font('Helvetica-Bold').text(r.order_title || '—');
      doc.font('Helvetica');
      doc.text(`Категория: ${r.category || '—'}`);
      doc.text(isProducer
        ? `Заказчик: ${r.customer || '—'}`
        : `Поставщик: ${r.supplier || '—'}`);
      doc.text(`Цена: ${fmtNum(r.price)} ₽/шт    Срок: ${r.days != null ? r.days + ' дн.' : '—'}`);
      doc.text(`Статус: ${r.status || '—'}    Дата: ${fmtDate(r.created_at)}`);
      if (doc.y > 720) doc.addPage();
    });
  });
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
      doc.font('Helvetica-Bold').fillColor(isBest ? '#0d9488' : '#111')
        .text(`${i + 1}. ${r.supplier || r.company || '—'}${isBest ? '  ★ лучшая цена' : ''}`);
      doc.font('Helvetica').fillColor('#111');
      doc.text(`Цена: ${fmtNum(r.price)} ₽/шт    Срок: ${r.days != null ? r.days + ' дн.' : '—'}`);
      doc.text(`Статус: ${r.status || '—'}    Дата: ${fmtDate(r.created_at)}`);
      if (r.match_score) doc.text(`Совпадение с закупкой: ${r.match_score}%`);
      if (doc.y > 720) doc.addPage();
    });

    if (meta.benchmark?.enough) {
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').text('Бенчмарк по категории (6 мес.):');
      doc.font('Helvetica');
      doc.text(`Медиана: ${fmtNum(meta.benchmark.median)} ₽    Диапазон: ${fmtNum(meta.benchmark.min)}–${fmtNum(meta.benchmark.max)} ₽`);
    }
  });
}

module.exports = { buildOrdersPdf, buildProposalsPdf, buildCompareKpPdf };
