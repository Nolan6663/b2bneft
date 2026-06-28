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

module.exports = { buildOrdersPdf, buildProposalsPdf };
