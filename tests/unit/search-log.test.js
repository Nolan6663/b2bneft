'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQuery, sessionKey, roleOf, logSearch, recordOutcome } = require('../../lib/search-log');

function fakePool(handler) {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            return handler ? handler(sql, params) : { rows: [{ id: 1 }], rowCount: 1 };
        },
    };
}

test('нормализация: регистр, ё, пунктуация и лишние пробелы', () => {
    assert.equal(normalizeQuery('  Валы  ПО   Чертежу!!! '), 'валы по чертежу');
    assert.equal(normalizeQuery('Литьё, ГОСТ 977'), 'литье гост 977');
    assert.equal(normalizeQuery('токарка/фрезеровка'), 'токарка фрезеровка');
    assert.equal(normalizeQuery(''), '');
    assert.equal(normalizeQuery(null), '');
});

test('нормализация не трогает морфологию: исходная формулировка не теряется', () => {
    // «валов» и «вал» — разные строки: сводит их редактор при кластеризации,
    // а не запись в журнал. Иначе спрос на изделие и на операцию сольются молча.
    assert.notEqual(normalizeQuery('изготовление валов'), normalizeQuery('изготовление вала'));
});

test('ключ сессии псевдонимен: устойчив, различает людей и не содержит id', () => {
    const a = sessionKey(42);
    const b = sessionKey(43);
    assert.equal(a, sessionKey(42));
    assert.notEqual(a, b);
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.ok(!a.includes('42'));
    assert.equal(sessionKey(null), '');
});

test('роль пишется в терминах ТЗ', () => {
    assert.equal(roleOf({ role: 'customer' }), 'customer');
    assert.equal(roleOf({ role: 'producer' }), 'producer');
    assert.equal(roleOf({ role: 'admin' }), 'unknown');
    assert.equal(roleOf(null), 'unknown');
});

test('запись запроса: поля ТЗ 8.1 уходят в базу, пользователь — нет', async () => {
    const pool = fakePool();
    const id = await logSearch(pool, {
        queryRaw: 'Валы по чертежу',
        user: { id: 7, role: 'customer', email: 'snab@zavod.ru' },
        resultsCount: 3,
        resultGroups: { companies: 3 },
    });
    assert.equal(id, 1);
    const [call] = pool.calls;
    assert.deepEqual(call.params.slice(0, 5), ['Валы по чертежу', 'валы по чертежу', 'customer', '', 3]);
    assert.equal(call.params[5], '{"companies":3}');
    assert.equal(call.params[6], sessionKey(7));
    const flat = JSON.stringify(call);
    assert.ok(!flat.includes('snab@zavod.ru'), 'в журнал уехала почта пользователя');
});

test('нулевая выдача записывается: это спрос, которого у нас нет', async () => {
    const pool = fakePool();
    await logSearch(pool, { queryRaw: 'шестерни m12', user: null, resultsCount: 0, resultGroups: {} });
    assert.equal(pool.calls[0].params[4], 0);
    assert.equal(pool.calls[0].params[2], 'unknown');
});

test('пустой запрос в журнал не идёт', async () => {
    const pool = fakePool();
    assert.equal(await logSearch(pool, { queryRaw: '   ', user: null, resultsCount: 0 }), null);
    assert.equal(pool.calls.length, 0);
});

test('упавший журнал не ломает поиск', async () => {
    const pool = fakePool(() => { throw new Error('база недоступна'); });
    assert.equal(await logSearch(pool, { queryRaw: 'валы', user: { id: 1 }, resultsCount: 2 }), null);
    assert.equal(await recordOutcome(pool, { id: 5, user: { id: 1 }, clickedEntity: 'company:9' }), false);
});

test('исход дописывается только своей строке', async () => {
    const pool = fakePool(() => ({ rowCount: 1 }));
    assert.equal(await recordOutcome(pool, { id: 5, user: { id: 1 }, clickedEntity: 'company:9' }), true);
    assert.deepEqual(pool.calls[0].params, ['company:9', null, 5, sessionKey(1)]);

    // Чужая строка: ключ сессии в WHERE не совпал, обновления не было.
    const missed = fakePool(() => ({ rowCount: 0 }));
    assert.equal(await recordOutcome(missed, { id: 5, user: { id: 2 }, clickedEntity: 'company:9' }), false);

    // Гость и мусорный номер до базы не доходят вовсе.
    const guarded = fakePool();
    assert.equal(await recordOutcome(guarded, { id: 5, user: null, clickedEntity: 'company:9' }), false);
    assert.equal(await recordOutcome(guarded, { id: 'abc', user: { id: 1 } }), false);
    assert.equal(guarded.calls.length, 0);
});
