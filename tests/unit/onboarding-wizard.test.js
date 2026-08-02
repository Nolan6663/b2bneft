'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('мастер заказчика: четыре шага и ни одного обращения к закрытым эндпоинтам', () => {
    const src = read('zayavka.html');
    for (const step of ['data-step="1"', 'data-step="2"', 'data-step="3"', 'data-step="4"']) {
        assert.ok(src.includes(step), `нет ${step}`);
    }
    assert.ok(!/\/api\/ai\/generate-tz/.test(src), 'гостевая страница не должна звать закрытый эндпоинт');
    assert.ok(src.includes('/api/public/tz-draft'), 'должна звать гостевую сборку ТЗ');
    assert.ok(src.includes('/api/public/match-preview'), 'должна звать гостевой подбор');
});

test('мастер заказчика: подключает общий скрипт и стили мастера', () => {
    const src = read('zayavka.html');
    assert.ok(src.includes('assets/onboarding.js'));
    assert.ok(src.includes('assets/onboarding.css'));
});

test('мастер заказчика: данные предприятий выводятся через экранирование', () => {
    const src = read('zayavka.html');
    // Единственное место, где в разметку попадают данные с сервера — карточки подбора
    const matchBlock = src.slice(src.indexOf("matchList').innerHTML"), src.indexOf('const rest'));
    assert.ok(matchBlock.includes('escapeHtml(m.company)'), 'название завода — через escapeHtml');
    assert.ok(!/\$\{m\.(company|city|products)\}/.test(matchBlock), 'сырых подстановок быть не должно');
});

test('мастер заказчика: категории совпадают с теми, что в базе', () => {
    const src = read('zayavka.html');
    const { CATEGORIES } = require('../../seo/categories-data');
    for (const c of CATEGORIES) {
        assert.ok(src.includes(`value="${c.dbCategory}"`), `нет категории ${c.dbCategory}`);
    }
});

test('мастер заказчика: страница отдаётся по чистому адресу', () => {
    assert.ok(read('server.js').includes("'zayavka.html'"), 'страница должна быть в PUBLIC_PAGES');
});

test('каркас мастера: черновик в sessionStorage, файл — только в памяти вкладки', () => {
    const js = read('assets', 'onboarding.js');
    assert.ok(js.includes('sessionStorage'), 'черновик переживает перезагрузку вкладки');
    assert.ok(!/localStorage/.test(js), 'долго хранить черновик гостя незачем');
    const page = read('zayavka.html');
    assert.ok(/let drawingFile = null/.test(page), 'файл чертежа держим в памяти, а не в хранилище');
});
