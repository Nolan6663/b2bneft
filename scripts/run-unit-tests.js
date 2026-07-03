'use strict';

// Кроссплатформенный запуск юнит-тестов: node --test с glob-паттерном
// не работает на Node 20 (CI) — собираем список файлов сами.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'tests', 'unit');
const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.test.js'))
    .map(f => path.join(dir, f));

if (!files.length) {
    console.error('Нет тестов в tests/unit');
    process.exit(1);
}

const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
