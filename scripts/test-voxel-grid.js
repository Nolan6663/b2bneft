'use strict';
const fs = require('fs');
const path = require('path');

const p = path.join(__dirname, '..', 'assets', 'data', 'russia-voxel-grid.json');
if (!fs.existsSync(p)) { console.error('FAIL: grid json not generated'); process.exit(1); }
const g = JSON.parse(fs.readFileSync(p, 'utf8'));

function cellAt(lon, lat) {
    if (lon < 0) lon += 360;
    const col = Math.floor((lon - g.lonMin) / (g.lonMax - g.lonMin) * g.cols);
    const row = Math.floor((lat - g.latMin) / (g.latMax - g.latMin) * g.rows);
    return g.cells.some(c => c[0] === col && c[1] === row);
}

const checks = [
    ['cells count 1200..6000', g.cells.length >= 1200 && g.cells.length <= 6000],
    ['heights in [1,3]', g.cells.every(c => c[2] >= 1 && c[2] <= 3)],
    ['Москва на суше', cellAt(37.6, 55.75)],
    ['Казань на суше', cellAt(49.1, 55.8)],
    ['Тюмень на суше', cellAt(65.5, 57.15)],
    ['Чукотка есть (антимеридиан)', cellAt(-173, 65)],
    ['Чёрное море пустое', !cellAt(31.0, 43.5)],
    ['Северный Ледовитый океан пустой', !cellAt(75.0, 80.5)],
];
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? 'PASS' : 'FAIL') + ': ' + name); if (!pass) ok = false; }
process.exit(ok ? 0 : 1);
