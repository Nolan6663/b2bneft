'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const PUBLIC_PAGES = [
    'landing.html', 'zakupki.html',
    'zakupki/armatura.html', 'zakupki/elektro.html', 'zakupki/metall.html', 'zakupki/rti.html',
    'catalog.html', 'map.html', 'supplier-public.html', 'dlya-postavshchikov.html',
    'partners.html', 'tariff.html', 'delivery.html', 'privacy.html', 'terms.html',
    'login.html', '404.html',
];

// Мягкая цветная тень — маркер генерённого интерфейса. Hairline `0 1px 3px` это
// разделитель строк, а не свечение: ловим только то, что одновременно смещено
// вниз от 2px и размыто от 4px.
const SOFT_SHADOW = /box-shadow:\s*[^;]*?\b0\s+([2-9]|\d{2,})px\s+([4-9]|\d{2,})px\s+rgba/gi;
const PILL_RADIUS = /border-radius:\s*(999px|50px|30px|20px)/gi;
const GRADIENT = /linear-gradient/gi;

// Общие исключения — работают в любом файле. Каждая запись с комментарием,
// зачем осталась, иначе список превратится в свалку.
const ALLOWED_ANYWHERE = [
    '1px, transparent 1px',   // чертёжная сетка — фирменный элемент, не декор
    'mask-image',             // фейд длинного блока, а не заливка
    'var(--inner-bg) 25%',    // шиммер скелетона загрузки
    '.skel-cell',             // скелетоны загрузки
];

// Исключения на файл: селектор виден только в контексте, поэтому сверяем
// по куску строки.
const ALLOWED = {
    'assets/theme-v2.css': [
        'rgba(0,0,0,0.14)',                       // .toast — всплывающее уведомление
        'rgba(0,0,0,.18)',                        // .kp-compare-bar, .ob-checklist — плавающие панели
        'rgba(0,0,0,.28)',                        // .cp-box — модальная шторка
        'rgba(0,0,0,.14)',                        // .cs-menu — выпадающий список
        'rgba(0,0,0,.32)',                        // модальный диалог
        'var(--border-mid); border-radius: 20px', // .theme-slider — переключатель темы, форма функциональна
        'background: linear-gradient(90deg,',     // шиммер скелетона, многострочный
        'background: linear-gradient(',           // шиммер скелетона, многострочный
    ],
};

function lintFile(rel) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const allowed = (ALLOWED[rel] || []).concat(ALLOWED_ANYWHERE);
    const hits = [];
    for (const [name, re] of [['soft-shadow', SOFT_SHADOW], ['pill-radius', PILL_RADIUS], ['gradient', GRADIENT]]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            const lineStart = text.lastIndexOf('\n', m.index) + 1;
            const lineEnd = text.indexOf('\n', m.index);
            const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
            if (allowed.some(a => line.includes(a))) continue;
            const lineNo = text.slice(0, m.index).split('\n').length;
            hits.push(`${rel}:${lineNo} ${name}: ${line.slice(0, 90)}`);
        }
    }
    return hits;
}

test('тема: мягких свечений, pill-радиусов и градиентов не осталось', () => {
    const hits = lintFile('assets/theme-v2.css');
    assert.deepEqual(hits, [], 'слоп в теме:\n' + hits.join('\n'));
});

test('публичные страницы: маркеров слопа нет', () => {
    const hits = PUBLIC_PAGES.flatMap(lintFile);
    assert.deepEqual(hits, [], 'слоп на страницах:\n' + hits.join('\n'));
});
