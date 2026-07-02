'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildOrdersPdf } = require('../export-pdf.js');

const outPath = path.join(os.tmpdir(), 'tz-pdf-smoke.pdf');
const out = fs.createWriteStream(outPath);
out.setHeader = () => {};
out.status = () => out;

buildOrdersPdf([{
  id: 1,
  title: 'Тест: Уплотнение РТИ DN150 ГОСТ 9833-73',
  category: 'РТИ и уплотнения',
  status: 'Открыта',
  deadline: '2026-07-10',
  proposals: 2,
  created_at: new Date().toISOString()
}], out);

out.on('finish', () => {
  const size = fs.statSync(outPath).size;
  console.log('PDF written:', outPath, size, 'bytes');
  // с embedded-шрифтом файл заметно больше 20КБ; со встроенным Helvetica — ~2-3КБ
  process.exit(size > 20000 ? 0 : 1);
});
