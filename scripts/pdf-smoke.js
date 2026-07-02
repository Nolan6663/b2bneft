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
  const buf = fs.readFileSync(outPath);
  const size = buf.length;
  const hasEmbeddedFont = buf.includes('FontFile2');
  const pageCountMatch = buf.toString('latin1').match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/);
  const pages = pageCountMatch ? Number(pageCountMatch[1]) : -1;
  console.log('PDF written:', outPath, size, 'bytes; embedded font:', hasEmbeddedFont, '; pages:', pages);
  process.exit(hasEmbeddedFont && pages === 1 && size > 5000 ? 0 : 1);
});
