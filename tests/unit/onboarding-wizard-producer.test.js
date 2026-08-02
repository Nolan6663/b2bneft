'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('мастер завода: шаг ИНН и четыре шага профиля', () => {
    const src = read('zavod.html');
    for (const step of ['data-step="1"', 'data-step="2"', 'data-step="3"', 'data-step="4"', 'data-step="5"']) {
        assert.ok(src.includes(step), `нет ${step}`);
    }
    assert.ok(src.includes('/api/public/company-by-inn'), 'должен искать стаб по ИНН');
    assert.ok(src.includes('/api/auth/register'), 'регистрация — последний шаг');
});

test('мастер завода: операции берутся из справочника, а не из головы', () => {
    const src = read('zavod.html');
    const { OPERATIONS } = require('../../seo/operations-data');
    for (const op of OPERATIONS) {
        assert.ok(src.includes(`data-op="${op.slug}"`), `в чипах нет операции ${op.slug}`);
    }
});

test('мастер завода: данные предприятия выводятся через экранирование', () => {
    const src = read('zavod.html');
    assert.ok(src.includes('escapeHtml(c.company)'), 'название — через escapeHtml');
    assert.ok(!/\$\{c\.(company|city|specialization)\}/.test(src), 'сырых подстановок быть не должно');
});

test('мастер завода: занятое предприятие не предлагает присвоить себе', () => {
    const src = read('zavod.html');
    assert.ok(src.includes('fillClaimed'), 'для claimed=true отдельная ветка');
    assert.ok(/if \(claimed\) return;/.test(src), 'кнопка продолжения заблокирована для занятой карточки');
});

test('мастер завода: инвайт-письмо ведёт в мастер, а не на общую регистрацию', () => {
    const src = read('lib', 'registry-invites.js');
    assert.ok(src.includes('/zavod?inn='), 'ссылка приглашения должна вести на /zavod с ИНН');
    assert.ok(!/login\.html\?utm_source=registry-invite/.test(src), 'старая ссылка на форму регистрации убрана');
});

test('мастер завода: страница отдаётся по чистому адресу', () => {
    assert.ok(read('server.js').includes("'zavod.html'"));
});
