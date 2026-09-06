'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickTown, townByInn } = require('../../lib/dadata-party');

/* Ответы DaData сохранены по форме живых: в сеть тест не ходит.
 * Проверяем то, из-за чего всё затевалось, — что из ответа достаётся город, а
 * не регион. Регион у нас и так есть, и именно он портил заголовки в выдаче. */

const GLAZOV = { data: { region_with_type: 'Удмуртская Респ', region: 'Удмуртская', city: 'Глазов', city_with_type: 'г Глазов', settlement: null } };
const MOSCOW = { data: { region_with_type: 'г Москва', region: 'Москва', city: null, city_with_type: null, settlement: null } };
const VILLAGE = { data: { region_with_type: 'Кировская обл', region: 'Кировская', city: null, settlement: 'Индустриальный', settlement_with_type: 'п Индустриальный' } };
const REGION_ONLY = { data: { region_with_type: 'Пермский край', region: 'Пермский', city: null, settlement: null } };

test('город берётся из адреса организации', () => {
    assert.equal(pickTown(GLAZOV), 'Глазов');
});

test('города федерального значения приезжают регионом — их узнаём отдельно', () => {
    assert.equal(pickTown(MOSCOW), 'Москва');
});

test('посёлок — тоже ответ на вопрос «где завод»', () => {
    assert.equal(pickTown(VILLAGE), 'Индустриальный');
});

test('регион городом не считается: ради этого всё и делалось', () => {
    assert.equal(pickTown(REGION_ONLY), '', 'Пермский край — не город');
    assert.equal(pickTown(null), '');
    assert.equal(pickTown({}), '');
});

test('запрос по ИНН: мусорный номер до сети не доходит', async () => {
    const prev = process.env.DADATA_API_KEY;
    process.env.DADATA_API_KEY = 'test-key';
    try {
        let called = false;
        const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({ suggestions: [] }) }; };
        assert.equal(await townByInn('не инн', { fetchImpl }), '');
        assert.equal(await townByInn('123', { fetchImpl }), '');
        assert.equal(called, false, 'на заведомо неверный ИНН квоту не тратим');

        assert.equal(await townByInn('1829004048', { fetchImpl }), '');
        assert.equal(called, true, 'корректный ИНН должен уйти в справочник');
    } finally {
        if (prev === undefined) delete process.env.DADATA_API_KEY; else process.env.DADATA_API_KEY = prev;
    }
});

test('без ключа запросов не делаем вовсе', async () => {
    const prev = process.env.DADATA_API_KEY;
    delete process.env.DADATA_API_KEY;
    try {
        let called = false;
        await townByInn('1829004048', { fetchImpl: async () => { called = true; } });
        assert.equal(called, false);
    } finally {
        if (prev !== undefined) process.env.DADATA_API_KEY = prev;
    }
});

test('ответ справочника разбирается целиком, как приходит', async () => {
    const prev = process.env.DADATA_API_KEY;
    process.env.DADATA_API_KEY = 'test-key';
    try {
        const fetchImpl = async () => ({
            ok: true,
            json: async () => ({ suggestions: [{ value: 'АО "ГЛАЗОВСКИЙ ЗАВОД "МЕТАЛЛИСТ"', data: { inn: '1829004048', address: GLAZOV } }] }),
        });
        assert.equal(await townByInn('1829004048', { fetchImpl }), 'Глазов');
    } finally {
        if (prev === undefined) delete process.env.DADATA_API_KEY; else process.env.DADATA_API_KEY = prev;
    }
});
