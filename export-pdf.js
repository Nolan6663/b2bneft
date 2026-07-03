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
    const oldBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
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
    doc.page.margins.bottom = oldBottom;
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

// ── Договор поставки + спецификация ─────────────────────────────────────────

const NUM_UNITS = [
  ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
   'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать',
   'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'],
  ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
   'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать',
   'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'],
];
const NUM_TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const NUM_HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
const NUM_SCALES = [null, ['тысяча', 'тысячи', 'тысяч', 1], ['миллион', 'миллиона', 'миллионов', 0], ['миллиард', 'миллиарда', 'миллиардов', 0]];

function pluralRu(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function tripletToWords(n, gender) {
  const words = [];
  if (NUM_HUNDREDS[Math.floor(n / 100)]) words.push(NUM_HUNDREDS[Math.floor(n / 100)]);
  const rest = n % 100;
  if (rest < 20) { if (NUM_UNITS[gender][rest]) words.push(NUM_UNITS[gender][rest]); }
  else {
    words.push(NUM_TENS[Math.floor(rest / 10)]);
    if (NUM_UNITS[gender][rest % 10]) words.push(NUM_UNITS[gender][rest % 10]);
  }
  return words;
}

function rublesInWords(amount) {
  const abs = Math.abs(Number(amount) || 0);
  const rub = Math.floor(abs);
  const kop = Math.round((abs - rub) * 100);
  const kopStr = `${String(kop).padStart(2, '0')} ${pluralRu(kop, 'копейка', 'копейки', 'копеек')}`;
  if (rub === 0) return `ноль рублей ${kopStr}`;
  const groups = [];
  let n = rub;
  while (n > 0) { groups.push(n % 1000); n = Math.floor(n / 1000); }
  const words = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g === 0) continue;
    const gender = NUM_SCALES[i] ? NUM_SCALES[i][3] : 0;
    words.push(...tripletToWords(g, gender));
    if (NUM_SCALES[i]) words.push(pluralRu(g, NUM_SCALES[i][0], NUM_SCALES[i][1], NUM_SCALES[i][2]));
  }
  const rubWord = pluralRu(rub, 'рубль', 'рубля', 'рублей');
  return `${words.join(' ')} ${rubWord} ${kopStr}`;
}

const DASH = '___________________';

const PAYMENT_CLAUSES = {
  prepay100: '2.3. Покупатель производит предоплату в размере 100% Цены договора в течение 5 (пяти) банковских дней с даты подписания настоящего Договора.',
  split5050: '2.3. Покупатель производит авансовый платёж в размере 50% Цены договора в течение 5 (пяти) банковских дней с даты подписания настоящего Договора. Оставшиеся 50% Покупатель оплачивает в течение 5 (пяти) банковских дней с даты приёмки Продукции.',
  postpay: '2.3. Покупатель оплачивает 100% Цены договора в течение 10 (десяти) банковских дней с даты приёмки Продукции.',
};

const DELIVERY_START = {
  prepay100: 'с даты поступления предоплаты',
  split5050: 'с даты поступления авансового платежа',
  postpay: 'с даты подписания настоящего Договора',
};

function req(v) { return (v && String(v).trim()) ? String(v).trim() : DASH; }
function plainText(s) { return String(s || '').replace(/<[^>]*>/g, '').trim(); }

function drawingName(drawing) {
  if (!drawing) return '—';
  try {
    const d = typeof drawing === 'string' ? JSON.parse(drawing) : drawing;
    return d.originalName || d.storedName || '—';
  } catch {
    return typeof drawing === 'string' ? drawing.slice(0, 80) : '—';
  }
}

function partyBlock(c, label) {
  return [
    [label, req(c && c.company)],
    ['ИНН', req(c && c.inn)], ['КПП', req(c && c.kpp)], ['ОГРН', req(c && c.ogrn)],
    ['Юр. адрес', req(c && c.legalAddress)],
    ['Банк', req(c && c.bankName)],
    ['Р/с', req(c && c.bankAccount)], ['К/с', req(c && c.bankCorr)], ['БИК', req(c && c.bankBik)],
    ['Руководитель', req(c && c.director)],
  ];
}

function buildContractPdf(data, res) {
  const { proposalId, payment, order, proposal, customer, supplier } = data;
  const year = new Date().getFullYear();
  const docNo = `ТЗ-${year}-${proposalId}`;
  const price = Number(proposal.price) || 0;
  const clause = PAYMENT_CLAUSES[payment] || PAYMENT_CLAUSES.split5050;
  const delStart = DELIVERY_START[payment] || DELIVERY_START.split5050;
  const L = 40, W_TEXT = 515;
  const colW = W_TEXT / 2 - 10;

  pipePdf(res, `dogovor-${docNo}.pdf`, (doc) => {
    const h = (t) => { doc.moveDown(0.8).font('TZ-Bold').fontSize(10).fillColor(TZ_INK).text(t, L, undefined, { width: W_TEXT }); doc.moveDown(0.3); };
    const p = (t) => doc.font('TZ').fontSize(8.5).fillColor(TZ_INK).text(t, L, undefined, { width: W_TEXT, align: 'justify', lineGap: 1.5 });

    doc.font('TZ-Bold').fontSize(13).fillColor(TZ_INK)
      .text(`ДОГОВОР ПОСТАВКИ № ${docNo}`, L, 50, { width: W_TEXT, align: 'center' });
    doc.moveDown(0.5).font('TZ').fontSize(8.5);
    const cityLine = 'г. ' + ((customer && customer.city && String(customer.city).trim()) || DASH);
    const headY = doc.y;
    doc.text(cityLine, L, headY, { width: W_TEXT / 2 });
    doc.text(fmtDate(new Date()), L + W_TEXT / 2, headY, { width: W_TEXT / 2, align: 'right' });
    doc.moveDown(0.8);
    p(`${req(customer && customer.company)}, именуемое в дальнейшем «Покупатель», в лице руководителя ${req(customer && customer.director)}, действующего на основании Устава, с одной стороны, и ${req(supplier && supplier.company)}, именуемое в дальнейшем «Поставщик», в лице руководителя ${req(supplier && supplier.director)}, действующего на основании Устава, с другой стороны, совместно именуемые «Стороны», заключили настоящий Договор о нижеследующем:`);

    h('1. ПРЕДМЕТ ДОГОВОРА');
    p('1.1. Поставщик обязуется изготовить и поставить, а Покупатель — принять и оплатить продукцию (далее — «Продукция»), наименование, количество, цена и сроки поставки которой определены в Спецификации (Приложение № 1), являющейся неотъемлемой частью настоящего Договора.');
    p('1.2. Продукция изготавливается в соответствии с технической документацией (чертежами, техническим заданием), переданной Покупателем через платформу ТехЗаказ (texzakaz.ru).');

    h('2. ЦЕНА ДОГОВОРА И ПОРЯДОК ОПЛАТЫ');
    p(`2.1. Цена Договора составляет ${fmtNum(price)} руб. (${rublesInWords(price)}), НДС — в соответствии с применяемой Поставщиком системой налогообложения.`);
    p('2.2. Оплата производится безналичным перечислением на расчётный счёт Поставщика, указанный в разделе 8 настоящего Договора.');
    p(clause);

    h('3. СРОКИ И УСЛОВИЯ ПОСТАВКИ');
    p(`3.1. Срок изготовления и поставки Продукции — ${proposal.days || DASH} календарных дней ${delStart}.`);
    p('3.2. Условия доставки, грузополучатель и адрес поставки согласуются Сторонами в Спецификации либо дополнительно в письменной форме (в том числе в чате сделки на платформе ТехЗаказ).');

    h('4. КАЧЕСТВО И ПРИЁМКА');
    p('4.1. Качество Продукции должно соответствовать Спецификации, чертежам и техническому заданию Покупателя, а также применимым ГОСТ/ТУ, указанным в Спецификации.');
    p('4.2. Приёмка Продукции по количеству и качеству производится Покупателем в течение 10 (десяти) рабочих дней с даты получения. О выявленных недостатках Покупатель уведомляет Поставщика письменно в указанный срок.');
    p('4.3. При обнаружении недостатков Поставщик обязан за свой счёт устранить их либо заменить Продукцию в согласованный Сторонами срок.');

    h('5. ОТВЕТСТВЕННОСТЬ СТОРОН');
    p('5.1. За нарушение сроков поставки Покупатель вправе требовать уплаты неустойки в размере 0,1% от стоимости непоставленной в срок Продукции за каждый день просрочки, но не более 10% от Цены Договора.');
    p('5.2. За нарушение сроков оплаты Поставщик вправе требовать уплаты неустойки в размере 0,1% от неоплаченной суммы за каждый день просрочки, но не более 10% от Цены Договора.');
    p('5.3. Во всём ином Стороны несут ответственность в соответствии с законодательством Российской Федерации.');

    h('6. РАЗРЕШЕНИЕ СПОРОВ');
    p('6.1. Споры разрешаются путём переговоров. Претензионный порядок обязателен: срок ответа на претензию — 30 (тридцать) календарных дней с даты получения.');
    p('6.2. При недостижении согласия спор передаётся в арбитражный суд по месту нахождения истца.');

    h('7. ПРОЧИЕ УСЛОВИЯ');
    p('7.1. Договор вступает в силу с даты подписания обеими Сторонами и действует до полного исполнения обязательств.');
    p('7.2. Договор составлен в двух экземплярах, имеющих равную юридическую силу, по одному для каждой из Сторон. Стороны признают юридическую силу документов, переданных по электронной почте (сканированных копий), до момента обмена оригиналами.');
    p('7.3. Настоящий Договор сформирован на основании данных сделки платформы ТехЗаказ (texzakaz.ru).');

    h('8. РЕКВИЗИТЫ И ПОДПИСИ СТОРОН');
    if (doc.y > doc.page.height - 260) doc.addPage();
    const startY = doc.y;
    const drawParty = (rows, x) => {
      let y = startY;
      rows.forEach(([k, v]) => {
        doc.font('TZ-Bold').fontSize(7.5).fillColor(TZ_GRAPHITE).text(k + ':', x, y, { width: 90, lineBreak: false });
        doc.font('TZ').fontSize(7.5).fillColor(TZ_INK).text(v, x + 92, y, { width: colW - 92 });
        y = Math.max(y + 11, doc.y + 2);
      });
      doc.font('TZ').fontSize(8).fillColor(TZ_INK).text('Подпись: ______________ М.П.', x, y + 14, { width: colW });
      return y + 30;
    };
    const yLeft = drawParty(partyBlock(customer, 'ПОКУПАТЕЛЬ'), L);
    const yRight = drawParty(partyBlock(supplier, 'ПОСТАВЩИК'), L + colW + 20);
    doc.y = Math.max(yLeft, yRight);

    // Приложение № 1: Спецификация
    doc.addPage();
    doc.font('TZ-Bold').fontSize(11).fillColor(TZ_INK)
      .text(`ПРИЛОЖЕНИЕ № 1 к Договору поставки № ${docNo} от ${fmtDate(new Date())}`, L, 50, { width: W_TEXT, align: 'center' });
    doc.moveDown(0.3).fontSize(12).text('СПЕЦИФИКАЦИЯ', L, undefined, { width: W_TEXT, align: 'center' });
    doc.moveDown(1);

    const qty = Number(order.quantity) || 0;
    const unitPrice = qty > 0 ? price / qty : null;
    const rows = [
      ['Наименование', plainText(order.title)],
      ['Категория', order.category || '—'],
      ['Количество', qty > 0 ? `${fmtNum(qty)} шт` : '—'],
      ['Цена за единицу', unitPrice != null ? `${fmtNum(Math.round(unitPrice * 100) / 100)} руб.` : '—'],
      ['Сумма', `${fmtNum(price)} руб. (${rublesInWords(price)})`],
      ['Срок поставки', `${proposal.days || DASH} календарных дней ${delStart}`],
      ['Чертёж / ТЗ', drawingName(order.drawing)],
    ];
    let ty = doc.y;
    rows.forEach(([k, v]) => {
      doc.rect(L, ty, 150, 22).lineWidth(0.6).strokeColor(TZ_INK).stroke();
      doc.rect(L + 150, ty, W_TEXT - 150, 22).stroke();
      doc.font('TZ-Bold').fontSize(8).fillColor(TZ_INK).text(k, L + 6, ty + 7, { width: 138, lineBreak: false });
      doc.font('TZ').fontSize(8).text(String(v).slice(0, 120), L + 156, ty + 7, { width: W_TEXT - 162, lineBreak: false });
      ty += 22;
    });
    doc.y = ty + 10;

    if (order.description) {
      doc.font('TZ-Bold').fontSize(9).fillColor(TZ_INK).text('Техническое задание / описание:', L, undefined, { width: W_TEXT });
      doc.moveDown(0.3).font('TZ').fontSize(8).fillColor(TZ_INK)
        .text(plainText(order.description).slice(0, 2500), L, undefined, { width: W_TEXT, align: 'justify', lineGap: 1.5 });
    }

    doc.moveDown(2);
    if (doc.y > doc.page.height - 120) doc.addPage();
    const sigY = doc.y;
    doc.font('TZ-Bold').fontSize(8).fillColor(TZ_INK).text('ПОКУПАТЕЛЬ:', L, sigY, { width: colW });
    doc.font('TZ').fontSize(8).text(`${req(customer && customer.company)}\n\nПодпись: ______________ М.П.`, L, sigY + 12, { width: colW });
    doc.font('TZ-Bold').fontSize(8).text('ПОСТАВЩИК:', L + colW + 20, sigY, { width: colW });
    doc.font('TZ').fontSize(8).text(`${req(supplier && supplier.company)}\n\nПодпись: ______________ М.П.`, L + colW + 20, sigY + 12, { width: colW });
  }, { docNo });
}

module.exports = { buildOrdersPdf, buildProposalsPdf, buildCompareKpPdf, buildContractPdf, rublesInWords };
