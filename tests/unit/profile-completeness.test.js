'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FIELDS, profileCompleteness } = require('../../lib/profile-completeness');

test('веса полей в сумме дают ровно сто', () => {
    assert.equal(FIELDS.reduce((s, f) => s + f.weight, 0), 100);
});

test('пустой профиль: ноль процентов, все поля в списке недостающих', () => {
    const r = profileCompleteness({});
    assert.equal(r.percent, 0);
    assert.equal(r.missing.length, FIELDS.length);
    assert.equal(r.complete, false);
});

test('каждое недостающее поле объясняет, что откроется', () => {
    for (const m of profileCompleteness({}).missing) {
        assert.ok(m.unlocks && m.unlocks.length > 15, `${m.key}: нет объяснения`);
        assert.ok(m.label, `${m.key}: нет названия`);
    }
});

test('недостающие идут по убыванию веса: сначала то, что важнее', () => {
    const w = profileCompleteness({}).missing.map(m => m.weight);
    assert.deepEqual(w, [...w].sort((a, b) => b - a));
});

test('заполненный профиль: сто процентов и пустой список', () => {
    const r = profileCompleteness({
        specialization: 'РТИ и уплотнения',
        products: 'манжеты армированные, кольца круглого сечения, прокладки',
        capabilities: ['rti'],
        equipment: ['Пресс-форма 250 т'],
        city: 'Свердловская область',
        about: 'Завод резинотехнических изделий полного цикла с 1998 года, собственная оснастка.',
        phone: '+7 900 000-00-00',
        productionLoad: 40,
    });
    assert.equal(r.percent, 100);
    assert.equal(r.complete, true);
    assert.equal(r.missing.length, 0);
});

test('короткая отписка в продукции и описании не считается заполнением', () => {
    const r = profileCompleteness({ products: 'детали', about: 'завод' });
    assert.equal(r.percent, 0, 'три слова — это не профиль');
});

test('нулевая загрузка производства — это значение, а не пропуск', () => {
    const r = profileCompleteness({ productionLoad: 0 });
    assert.ok(r.done.some(d => d.key === 'productionLoad'), 'ноль процентов загрузки тоже ответ');
});
