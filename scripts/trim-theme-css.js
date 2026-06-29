#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'assets', 'theme-v2.css');
const lines = fs.readFileSync(file, 'utf8').split(/\n/);
const paletteIdx = lines.findIndex((l) => l.includes('__DUPE_TRIM_MARKER__') || l.includes('ТЕХЗАКАЗ — оранжевая палитра'));
const trimStart = paletteIdx > 0 ? paletteIdx - 1 : paletteIdx;
const end = lines.findIndex((l, i) => i > paletteIdx && l.trim() === '/* -----------------------------------------------------------------------' && lines[i + 1] && lines[i + 1].includes('Toast'));
if (paletteIdx === -1 || end === -1) {
    console.error('markers not found', paletteIdx, end);
    process.exit(1);
}
const before = lines.length;
const out = lines.slice(0, trimStart).concat(lines.slice(end));
fs.writeFileSync(file, out.join('\n'), 'utf8');
console.log('removed lines', trimStart + 1, 'to', end, `(${before} -> ${out.length})`);
