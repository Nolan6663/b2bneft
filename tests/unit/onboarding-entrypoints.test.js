'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const createCompaniesRouter = require('../../routes/companies');
const { fakePool, serve, baseDeps } = require('./helpers');

const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('лендинг ведёт заказчика в мастер, а не на форму регистрации', () => {
    const src = read('landing.html');
    assert.ok(src.includes('href="/zayavka"'), 'главный CTA должен вести в мастер');
    assert.ok(!/window\.location\.href = 'login\.html#register'/.test(src), 'демо тоже ведёт в мастер');
});

test('страница закупок и генератор категорий ведут в мастера', () => {
    const zakupki = read('zakupki.html');
    assert.ok(zakupki.includes('/zayavka'), 'заказчику — мастер закупки');
    assert.ok(zakupki.includes('/zavod'), 'поставщику — мастер завода');
    const gen = read('scripts', 'sync-category-pages.js');
    assert.ok(gen.includes('/zayavka'), 'CTA категорий — в мастер закупки');
    assert.ok(!/\/login#register/.test(gen), 'старых ссылок на форму регистрации не осталось');
});

test('страница для поставщиков ведёт в мастер завода', () => {
    const src = read('dlya-postavshchikov.html');
    assert.ok(src.includes('/zavod'));
    assert.ok(!/\/login#register/.test(src));
});

test('пустое состояние кабинета заказчика предлагает мастер', () => {
    assert.ok(read('index.html').includes("ctaHref: '/zayavka'"));
});

test('кабинет поставщика уводит пустой профиль в мастер', () => {
    const src = read('producer.html');
    assert.ok(src.includes('pcFillLink'), 'ссылка «Заполнить профиль» адресуемая');
    assert.ok(src.includes('/zavod?inn='), 'при почти пустом профиле ведём в мастер с ИНН');
});

test('полнота профиля отдаёт ИНН — иначе ссылка в мастер будет без предприятия', async () => {
    const deps = baseDeps({
        pool: fakePool([{ match: /FROM companies WHERE company/i, rows: [{ id: 1, company: 'ООО Завод', inn: '1832000000', capabilities: '[]' }] }]),
        rowToCompany: (r) => r,
    });
    const srv = await serve('/api/companies', createCompaniesRouter(deps));
    try {
        const res = await srv.request('/api/companies/my/completeness');
        assert.equal(res.status, 200);
        assert.equal(res.json.inn, '1832000000');
        assert.ok(typeof res.json.percent === 'number');
    } finally { await srv.close(); }
});

test('сгенерированные категорийные страницы совпадают с генератором', () => {
    execFileSync(process.execPath, [path.join(root, 'scripts', 'static-checks.js')], { stdio: 'pipe' });
});
