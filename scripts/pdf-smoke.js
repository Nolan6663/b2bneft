'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildOrdersPdf, buildContractPdf, rublesInWords } = require('../export-pdf.js');

function fakeRes(outPath) {
  const out = fs.createWriteStream(outPath);
  out.setHeader = () => {};
  out.status = () => out;
  return out;
}

function checkPdf(outPath, minPages, minSize) {
  const buf = fs.readFileSync(outPath);
  const hasFont = buf.includes('FontFile2');
  const m = buf.toString('latin1').match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/);
  const pages = m ? Number(m[1]) : -1;
  console.log(outPath, buf.length, 'bytes; font:', hasFont, '; pages:', pages);
  return hasFont && pages >= minPages && buf.length > minSize;
}

// сумма прописью
const w = rublesInWords(1234567.5);
console.log('words:', w);
const wordsOk = w === 'один миллион двести тридцать четыре тысячи пятьсот шестьдесят семь рублей 50 копеек';

const p1 = path.join(os.tmpdir(), 'tz-pdf-smoke.pdf');
const r1 = fakeRes(p1);
buildOrdersPdf([{
  id: 1,
  title: 'Тест: Уплотнение РТИ DN150 ГОСТ 9833-73',
  category: 'РТИ и уплотнения',
  status: 'Открыта',
  deadline: '2026-07-10',
  proposals: 2,
  created_at: new Date().toISOString()
}], r1);

r1.on('finish', () => {
  const ok1 = checkPdf(p1, 1, 5000);

  const company = (over) => Object.assign({
    company: 'ООО «Тест»', inn: '7203000000', kpp: '720301001', ogrn: '1027200000000',
    legalAddress: '625000, г. Тюмень, ул. Республики, 42', director: 'Иванов И.И.', city: 'Тюмень',
    bankName: 'ПАО Сбербанк', bankAccount: '40702810500000012345', bankBik: '047102651', bankCorr: '30101810800000000651',
  }, over || {});

  const runContract = (name, data, cb) => {
    const p = path.join(os.tmpdir(), name);
    const r = fakeRes(p);
    buildContractPdf(data, r);
    r.on('finish', () => cb(checkPdf(p, 2, 8000)));
  };

  runContract('tz-contract-full.pdf', {
    proposalId: 42, payment: 'split5050',
    order: { title: 'Манжеты 2-100х125 ГОСТ 8752-79', category: 'РТИ и уплотнения', quantity: 200, description: 'Резина НБР, твёрдость 75 ShA, поставка партиями', drawing: JSON.stringify({ originalName: 'manzheta.pdf' }) },
    proposal: { price: 1234567.5, days: 14 },
    customer: company(), supplier: company({ company: 'АО «Завод РТИ»' }),
  }, (ok2) => {
    runContract('tz-contract-empty.pdf', {
      proposalId: 43, payment: 'nonsense',
      order: { title: 'Тест без данных', category: '', quantity: 0, description: '', drawing: null },
      proposal: { price: 0, days: null },
      customer: null, supplier: { company: 'ООО «Пусто»' },
    }, (ok3) => {
      console.log('orders:', ok1, '| contract full:', ok2, '| contract empty:', ok3, '| words:', wordsOk);
      process.exit(ok1 && ok2 && ok3 && wordsOk ? 0 : 1);
    });
  });
});
