'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { categorizeProducer, CATEGORY_NAMES } = require('../../lib/producer-categories');

// Профили взяты с прода (/api/map, 30.07.2026) — включая те, на которых
// общий классификатор из server.js ошибается.
const KABEL = {
    company: 'ООО «Торговый Дом Марпосадкабель»',
    specialization: 'Кабельно-проводниковая продукция',
    about: 'Кабельный завод «Марпосадкабель» — это современное высокотехнологичное предприятие с более чем 35-летней историей. Выпускаем кабели и провода для энергетики, строительства и промышленности. Собственная лаборатория, контроль качества на всех переделах, отгрузка с барабанов и в бухтах.',
    products: '',
};
const RTI_3TONN = {
    company: '3-Тонн',
    specialization: 'Компания 3-Тонн специализируется на производстве высококачественных изделий из резины, полиуретана, силикона и пластика',
    about: '',
    products: '',
};
const RTI_CS20 = {
    company: 'CS20',
    specialization: 'Компания производит износостойкие авто компоненты из полиуретана, силикона и резины.',
    about: '',
    products: '',
};
const METAL = {
    company: 'ООО Механик',
    specialization: 'Механическая обработка металла',
    about: '',
    products: 'токарные и фрезерные работы по чертежам, металлоконструкции',
};
const ARMATURA = {
    company: 'ООО Арматурный завод',
    specialization: 'Трубопроводная арматура',
    about: '',
    products: 'задвижки, шаровые краны, фланцы',
};
const NOISE = {
    company: 'ООО Пекарня',
    specialization: 'Хлебобулочные изделия',
    about: 'Пекарня полного цикла.',
    products: 'батоны, багеты',
};

test('витрина: кабельный завод — только электрооборудование, а не все четыре категории', () => {
    const cats = categorizeProducer(KABEL);
    assert.deepEqual(cats, ['Электрооборудование'],
        `длинное описание не должно делать компанию всеядной, получено: ${JSON.stringify(cats)}`);
});

test('витрина: производители резины и полиуретана попадают в РТИ', () => {
    assert.deepEqual(categorizeProducer(RTI_3TONN), ['РТИ']);
    assert.deepEqual(categorizeProducer(RTI_CS20), ['РТИ']);
});

test('витрина: металлообработка и арматура распознаются по профилю', () => {
    assert.ok(categorizeProducer(METAL).includes('Металл'));
    assert.ok(categorizeProducer(ARMATURA).includes('Трубопроводная арматура'));
});

test('витрина: непрофильная компания не попадает никуда', () => {
    assert.deepEqual(categorizeProducer(NOISE), []);
});

test('витрина: описание без подтверждения в специализации категорию не даёт', () => {
    // Единственное упоминание в маркетинговом тексте — не основание показывать
    // завод в витрине категории.
    const vague = { company: 'ООО Общее', specialization: '', products: '', about: 'Поставляем в том числе прокладки и уплотнения для наших станков.' };
    assert.deepEqual(categorizeProducer(vague), []);
});

test('витрина: профиль по двум направлениям сохраняет оба', () => {
    const both = {
        company: 'ООО Двойной',
        specialization: 'Металлообработка и трубопроводная арматура',
        products: 'фланцы, задвижки, токарная обработка',
        about: '',
    };
    const cats = categorizeProducer(both);
    assert.ok(cats.includes('Металл'), `нет Металла: ${JSON.stringify(cats)}`);
    assert.ok(cats.includes('Трубопроводная арматура'), `нет арматуры: ${JSON.stringify(cats)}`);
});

test('витрина: пустой профиль и мусор на входе не роняют', () => {
    assert.deepEqual(categorizeProducer({}), []);
    assert.deepEqual(categorizeProducer(null), []);
});

test('витрина: имена категорий совпадают с теми, что в базе', () => {
    assert.deepEqual([...CATEGORY_NAMES].sort(), ['Металл', 'РТИ', 'Трубопроводная арматура', 'Электрооборудование'].sort());
});
