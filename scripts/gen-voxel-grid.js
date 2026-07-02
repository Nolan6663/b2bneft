'use strict';
// Растеризует GeoJSON России в сетку ячеек для воксельной карты лендинга.
// Запуск: node scripts/gen-voxel-grid.js  → пишет assets/data/russia-voxel-grid.json
const fs = require('fs');
const path = require('path');

const COLS = 96, ROWS = 40;
const LON_MIN = 19, LON_MAX = 191;   // lon<0 (Чукотка за антимеридианом) нормализуется +360
const LAT_MIN = 41, LAT_MAX = 82;

const geo = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'RUS.geo.json'), 'utf8'));

// Собираем все кольца (внешние и дырки) — even-odd правило обрабатывает дырки само.
const rings = [];
for (const f of geo.features) {
    const geom = f.geometry;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    for (const poly of polys) for (const ring of poly) {
        rings.push(ring.map(([lon, lat]) => [lon < 0 ? lon + 360 : lon, lat]));
    }
}

function insideEvenOdd(lon, lat) {
    let inside = false;
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
                inside = !inside;
            }
        }
    }
    return inside;
}

// Детерминированная «случайная» высота 1..3 — рельеф, не данные.
function height(col, row) {
    let h = (col * 73856093) ^ (row * 19349663);
    h = (h >>> 0) % 1000 / 1000;
    return Math.round((1 + 2 * h) * 100) / 100;
}

const cells = [];
for (let col = 0; col < COLS; col++) {
    const lon = LON_MIN + (col + 0.5) * (LON_MAX - LON_MIN) / COLS;
    for (let row = 0; row < ROWS; row++) {
        const lat = LAT_MIN + (row + 0.5) * (LAT_MAX - LAT_MIN) / ROWS;
        if (insideEvenOdd(lon, lat)) cells.push([col, row, height(col, row)]);
    }
}

const out = { cols: COLS, rows: ROWS, lonMin: LON_MIN, lonMax: LON_MAX, latMin: LAT_MIN, latMax: LAT_MAX, cells };
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'data', 'russia-voxel-grid.json'), JSON.stringify(out));
console.log('cells:', cells.length);
