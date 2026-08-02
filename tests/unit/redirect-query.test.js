'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withQuery } = require('../../lib/redirect-query');

test('редирект сохраняет параметры: ссылка на доставку не теряет id', () => {
    assert.equal(withQuery('/delivery.html?id=1', '/delivery'), '/delivery?id=1');
});

test('редирект без параметров остаётся коротким', () => {
    assert.equal(withQuery('/delivery.html', '/delivery'), '/delivery');
});

test('пустой знак вопроса не тащим в адрес', () => {
    assert.equal(withQuery('/delivery.html?', '/delivery'), '/delivery');
});

test('несколько параметров и кириллица переносятся как есть', () => {
    assert.equal(
        withQuery('/catalog.html?search=12&q=%D0%A0%D0%A2%D0%98', '/catalog'),
        '/catalog?search=12&q=%D0%A0%D0%A2%D0%98'
    );
});

test('якорь браузер не отправляет, но если пришёл — не ломаемся', () => {
    assert.equal(withQuery('/login.html?next=/deals', '/login'), '/login?next=/deals');
});

test('главная: адрес остаётся корнем и параметры сохраняются', () => {
    assert.equal(withQuery('/landing.html?utm_source=tg', '/'), '/?utm_source=tg');
});
