'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const limits = require('../../lib/content-limits');

/* Правило задано маркетингом (ответ 22.09, пункт 8): показывать счётчик и
   рекомендуемую длину, при превышении предупреждать — но сохранять значение
   целиком, без автоматического обрезания и блокировки сохранения.

   Эти тесты сторожат именно вторую половину правила. Первая очевидна и сама
   себя не сломает, а вот «обрежем на всякий случай» и «не дадим сохранить»
   появляются в коде сами собой при любой следующей правке. */

test('длинное значение сохраняется целиком, а не обрезается', () => {
    const long = 'Т'.repeat(300);
    const { values, warnings } = limits.measureAll({ title: long });
    assert.equal(values.title, long, 'ни одного знака потеряться не должно');
    assert.equal(warnings.length, 1, 'но предупредить обязаны');
});

test('превышение — предупреждение, а не ошибка', () => {
    const { measures } = limits.measureAll({ description: 'О'.repeat(200) });
    assert.equal(measures[0].tooLong, true);
    assert.match(measures[0].warning, /200/);
    assert.match(measures[0].warning, /160/, 'человеку нужна и текущая длина, и рекомендуемая');
});

test('в пределах рекомендации предупреждения нет', () => {
    const { warnings, measures } = limits.measureAll({ title: 'Производители валов — 23 предприятия' });
    assert.deepEqual(warnings, []);
    assert.equal(measures[0].tooLong, false);
    assert.equal(measures[0].warning, '');
});

test('непереданные поля не трогаются', () => {
    // Иначе правка одного лишь заголовка сотрёт описание.
    const { values } = limits.measureAll({ title: 'Валы' });
    assert.deepEqual(Object.keys(values), ['title']);
});

test('счётчик считает знаки, а не единицы UTF-16', () => {
    // «5 знаков» под полем обязано совпадать с тем, что видит человек.
    assert.equal(limits.countChars('валы🔩'), 5);
});

test('знаки без пробелов считаются отдельно — в них задан объём текстов', () => {
    assert.equal(limits.countChars('токарная обработка'), 18);
    assert.equal(limits.countCharsNoSpaces('токарная обработка'), 17);
    assert.equal(limits.countCharsNoSpaces('а\n б\tв'), 3);
});

test('крайние пробелы снимаются, внутренние — нет', () => {
    const { values } = limits.measureAll({ h1: '  Производители  валов  ' });
    assert.equal(values.h1, 'Производители  валов');
});

test('случайная вставка документа в поле — единственное, что отвергается', () => {
    /* Это не правило длины, а страховка: предел на два порядка выше любого
       осмысленного текста, и срабатывает он там, где в поле попало не то. */
    const accident = 'я'.repeat(limits.HARD_CEILING + 1);
    assert.throws(() => limits.measureAll({ intro: accident }), /не тот текст/);
    // А ровно на пределе — сохраняем.
    assert.doesNotThrow(() => limits.measureAll({ intro: 'я'.repeat(limits.HARD_CEILING) }));
});

test('неизвестное поле в тело запроса не пролезает', () => {
    // Имена полей уходят в SQL строкой, поэтому список закрытый.
    const { values } = limits.measureAll({ title: 'Валы', status: 'published_index', id: 7 });
    assert.deepEqual(Object.keys(values), ['title']);
    assert.throws(() => limits.measure('status', 'x'), /Неизвестное поле/);
});

test('рекомендации отдаются админке списком', () => {
    const list = limits.limits();
    assert.equal(list.length, limits.FIELD_NAMES.length);
    const title = list.find(l => l.field === 'title');
    assert.equal(title.recommended, 60);
    assert.ok(title.hint.length > 0, 'счётчику нужен не только предел, но и причина');
});
