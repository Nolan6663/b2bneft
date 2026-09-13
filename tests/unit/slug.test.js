'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toSlug, uniqueSlug, isValidSlug } = require('../../lib/slug');

/* Адреса справочников должны совпадать с теми, что маркетинг уже нарисовал в
   «Архитектуре публичных страниц». Если транслитерация поедет, разойдутся и
   URL в ТЗ, и то, что заведёт админка, — а чинить это придётся редиректами. */

test('примеры из ТЗ транслитерируются буква в букву', () => {
    const fromSpec = [
        ['токарная обработка', 'tokarnaya-obrabotka'],
        ['механическая обработка', 'mehanicheskaya-obrabotka'],
        ['фланцы', 'flancy'],
        ['нержавеющая сталь', 'nerzhaveyushchaya-stal'],
        ['литьё под давлением', 'litie-pod-davleniem'],
        ['изготовление валов', 'izgotovlenie-valov'],
        ['детали трубопроводов', 'detali-truboprovodov'],
        ['фланцы воротниковые', 'flancy-vorotnikovye'],
        ['сталь 40Х', 'stal-40h'],
    ];
    for (const [ru, want] of fromSpec) {
        assert.equal(toSlug(ru), want, `«${ru}»`);
    }
});

test('мягкий знак: молчит на конце, читается как i перед йотированной', () => {
    // Ровно из-за этого правила «литьё» даёт litie, а не lite.
    assert.equal(toSlug('сталь'), 'stal', 'на конце слова мягкий знак исчезает');
    assert.equal(toSlug('литьё'), 'litie', 'ь + ё → i + e');
    assert.equal(toSlug('статья'), 'statiya', 'ь + я → i + ya, по тому же правилу');
});

test('мусор и пунктуация не оставляют хвостов из дефисов', () => {
    assert.equal(toSlug('  Токарная   обработка!!!  '), 'tokarnaya-obrabotka');
    assert.equal(toSlug('ООО «Завод» — цех №5'), 'ooo-zavod-ceh-5');
    assert.equal(toSlug('---'), '');
});

test('длинное название обрезается по границе слова', () => {
    const long = 'изготовление деталей трубопроводов из нержавеющей стали по чертежам заказчика';
    const full = toSlug(long, 1000);
    assert.ok(full.length > 80, 'исходный пример должен быть длиннее лимита, иначе тест ничего не проверяет');

    for (const limit of [40, 60, 80]) {
        const s = toSlug(long, limit);
        assert.ok(s.length <= limit, `лимит ${limit}: длина ${s.length}`);
        assert.ok(!s.endsWith('-'), `лимит ${limit}: висящий дефис`);
        // Обрыв по границе слова: укороченный вариант — это целые слова полного,
        // а не «...nerzhaveyushche». Иначе в адресе появляется огрызок.
        assert.ok(
            full === s || full.startsWith(s + '-'),
            `лимит ${limit}: слово разрезано посередине — «${s}»`
        );
    }
    assert.equal(toSlug(long, 40), toSlug(long, 40), 'результат детерминирован');
});

test('проверка вручную введённого slug', () => {
    assert.ok(isValidSlug('tokarnaya-obrabotka'));
    assert.ok(isValidSlug('stal-40h'));
    assert.ok(!isValidSlug('Токарная'), 'кириллица не годится');
    assert.ok(!isValidSlug('tokarnaya_obrabotka'), 'подчёркивание не годится');
    assert.ok(!isValidSlug('-tokarnaya'), 'дефис по краям не годится');
    assert.ok(!isValidSlug('tokarnaya--obrabotka'), 'двойной дефис не годится');
    assert.ok(!isValidSlug('a'.repeat(81)), 'длиннее 80 не годится');
});

test('уникальный slug добавляет суффикс, пока не найдёт свободный', async () => {
    const taken = new Set(['valy', 'valy-2', 'valy-3']);
    assert.equal(await uniqueSlug('Валы', async (s) => taken.has(s)), 'valy-4');
});

test('пустое название не даёт пустой адрес', async () => {
    assert.equal(await uniqueSlug('!!!', async () => false), 'bez-nazvaniya');
});

test('сломанная проверка занятости не вешает запрос навсегда', async () => {
    // Если isTaken всегда отвечает «занято», цикл обязан сдаться с ошибкой,
    // а не крутиться внутри обработчика запроса.
    await assert.rejects(
        () => uniqueSlug('Валы', async () => true),
        /Не удалось подобрать свободный slug/
    );
});
