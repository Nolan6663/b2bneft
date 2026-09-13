'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* Слой обязательных событий ТЗ §12.1. Проверяется в песочнице, потому что это
   браузерный файл без экспортов: собираем ему минимальное окружение и смотрим,
   что уходит в Метрику. */

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'analytics-events.js'), 'utf8');

function sandbox({ granted = true, ymDefined = true, counterId = 110221667 } = {}) {
    const sent = [];
    const warnings = [];
    const window = {
        tzAnalytics: { granted: () => granted },
        __tzYmId: counterId,
        console: { warn: (m) => warnings.push(m) },
    };
    if (ymDefined) window.ym = (...args) => sent.push(args);
    const ctx = vm.createContext({ window, console: window.console });
    vm.runInContext(SRC, ctx);
    return { window, sent, warnings };
}

let env;
beforeEach(() => { env = sandbox(); });

test('событие уходит в счётчик с параметрами', () => {
    const ok = env.window.tzEvent('order_created', { region: 'Пермь' });
    assert.equal(ok, true);
    assert.equal(env.sent.length, 1);
    assert.deepEqual(env.sent[0], [110221667, 'reachGoal', 'order_created', { region: 'Пермь' }]);
});

test('без параметров вызов короче — Метрика не любит пустой объект', () => {
    env.window.tzEvent('landing_view');
    assert.deepEqual(env.sent[0], [110221667, 'reachGoal', 'landing_view']);
});

test('событие отправляется ровно один раз, а не в оба счётчика', () => {
    // ТЗ §16.3: дубль удваивает конверсию в отчётах и ломает воронку.
    env.window.tzEvent('order_created', { region: 'Пермь' });
    assert.equal(env.sent.length, 1);
});

test('без согласия не отправляется ничего', () => {
    const e = sandbox({ granted: false });
    assert.equal(e.window.tzEvent('landing_view'), false);
    assert.equal(e.sent.length, 0);
});

test('до загрузки счётчика вызов безопасен', () => {
    // ym появляется только после согласия; обращение к нему раньше — это
    // исключение внутри обработчика клика, то есть сломанная кнопка.
    const e = sandbox({ ymDefined: false });
    assert.doesNotThrow(() => e.window.tzEvent('primary_cta_click', { cta: 'Разместить' }));
    assert.equal(e.window.tzEvent('primary_cta_click'), false);
});

test('без идентификатора счётчика молчим, а не шлём в никуда', () => {
    const e = sandbox({ counterId: null });
    assert.equal(e.window.tzEvent('landing_view'), false);
    assert.equal(e.sent.length, 0);
});

test('опечатка в имени события заметна в консоли', () => {
    // Иначе цель молча не набирает статистику, и это всплывает через месяц,
    // когда маркетинг приходит за воронкой.
    assert.equal(env.window.tzEvent('landing_veiw'), false);
    assert.equal(env.sent.length, 0);
    assert.match(env.warnings[0], /неизвестное событие/i);
});

test('каталог покрывает все пятнадцать событий ТЗ §12.1', () => {
    const required = [
        'landing_view', 'primary_cta_click', 'drawing_upload_start', 'drawing_upload_success',
        'order_step_complete', 'order_created', 'company_filter', 'company_compare',
        'company_invited', 'order_response', 'search_submit', 'search_result_click',
        'case_submit', 'case_published', 'order_subscription',
    ];
    const known = Object.keys(env.window.tzEvent.EVENTS);
    for (const name of required) assert.ok(known.includes(name), `нет события ${name}`);
    assert.equal(known.length, required.length, 'лишних событий в каталоге быть не должно');
});

test('ошибка внутри Метрики не роняет страницу', () => {
    const e = sandbox();
    e.window.ym = () => { throw new Error('счётчик сломался'); };
    assert.doesNotThrow(() => e.window.tzEvent('landing_view'));
    assert.equal(e.window.tzEvent('landing_view'), false);
});

test('размер файла отправляется корзиной, а не байтами', () => {
    // Точный размер чертежа — характеристика документа заказчика, в аналитике
    // ей делать нечего.
    const b = env.window.tzEvent.sizeBucket;
    assert.equal(b(500 * 1024), '<1mb');
    assert.equal(b(3 * 1024 * 1024), '1-5mb');
    assert.equal(b(10 * 1024 * 1024), '5-20mb');
    assert.equal(b(50 * 1024 * 1024), '>20mb');
    assert.equal(b(0), 'unknown');
    assert.equal(b(undefined), 'unknown');
});

test('повторное подключение не перетирает уже созданный слой', () => {
    const before = env.window.tzEvent;
    const ctx = vm.createContext({ window: env.window, console: env.window.console });
    vm.runInContext(SRC, ctx);
    assert.equal(env.window.tzEvent, before);
});
