'use strict';
const path = require('path');
let parseRegistryFile;
try { ({ parseRegistryFile } = require('./import-registry.js')); }
catch { console.error('FAIL: import-registry.js not found'); process.exit(1); }

const rows = parseRegistryFile(path.join(__dirname, 'data', 'registry-fixture.json'));
const checks = [
    ['валидных записей = 2', rows.length === 2],
    ['трим названия', rows[0].company === 'ООО «Тестовый завод РТИ»'],
    ['инн нормализован из 16-58-012345', rows[1].inn === '1658012345'],
    ['город на месте', rows[0].city === 'Пермь'],
    ['дубль по ИНН отброшен (не Тверь)', rows[0].city !== 'Тверь'],
];
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? 'PASS' : 'FAIL') + ': ' + name); if (!pass) ok = false; }
process.exit(ok ? 0 : 1);
