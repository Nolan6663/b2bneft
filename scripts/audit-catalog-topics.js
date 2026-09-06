#!/usr/bin/env node
'use strict';

// Отчёт: сколько предприятий каталога относится к теме площадки.
//
//   npm run audit:topics
//
// Ничего не меняет. Только считает и показывает примеры.
//
// Зачем. Реестр ГИСП по постановлению № 719 — это вся обрабатывающая
// промышленность России, а не наша ниша. Импортировали мы его целиком, и в
// каталоге рядом с механообработкой лежат спецодежда, светильники, щебень,
// мебель и протезы. Для площадки прямых закупок по чертежу это чужие темы, а
// для поисковика — размытая тематика домена: он оценивает сайт целиком.
//
// Правила ниже — измерительный прибор, а не фильтр. Они грубые и намеренно
// консервативные: задача отчёта — показать масштаб и дать примеры, чтобы
// решение о том, что пускать в индекс, принимал человек.

require('dotenv').config();

const { pool } = require('../db');
const { categorizeProducer } = require('../lib/producer-categories');
const { OPERATIONS, producerHasOperation } = require('../seo/operations-data');

/* Темы, которые точно не про изготовление по чертежу. Список не полный и полным
   быть не может: он ловит крупные однородные группы, найденные по частотам в
   живом каталоге. Всё остальное честно уходит в «не опознано». */
const FOREIGN = {
    'спецодежда и обувь': /костюм|куртк|брюк|сапог|ботинк|спецодежд|перчатк|рукавиц|халат|комбинезон/i,
    'транспорт и спецтехника': /снегоболотоход|шасси|прицеп|автомобил|трактор|вагон|катер|лодк|автогрейдер|бульдозер/i,
    'стройматериалы и лес': /щебень|пиломатериал|бетон|кирпич|цемент|песок строит|фанер|брус |утеплител/i,
    'ткани и текстиль': /ткан|полотно|нитк|пряж|трикотаж|брезент/i,
    'мебель': /кресл|тумб|мебел|стеллаж|стол письмен|диван/i,
    'химия, лаки, краски': /дезинфиц|эмаль|краск|лак |грунтовк|растворител|моющее|антисептик/i,
    'медицина': /протез|медицинск|имплант|ортопед|стоматолог|шприц|бинт/i,
    'освещение': /светильник|светодиод|лампа |прожектор|люстр/i,
    'пищевое': /хлеб|молок|консерв|кондитер|мясн|напитк|мука |крупа/i,
};

function profileOf(row) {
    return {
        company: row.company,
        specialization: row.specialization || '',
        products: row.products || '',
        about: row.about || '',
        equipment: row.equipment || '',
    };
}

function classify(row) {
    const p = profileOf(row);
    if (categorizeProducer(p).length) return 'наша тема';
    if (OPERATIONS.some(op => producerHasOperation(p, op))) return 'наша тема';
    const text = `${p.specialization} ${p.products} ${p.about}`;
    for (const [name, re] of Object.entries(FOREIGN)) if (re.test(text)) return name;
    return 'не опознано';
}

async function main() {
    const { rows } = await pool.query(`
        SELECT id, company, specialization, products, about, equipment
          FROM companies
         WHERE role = 'producer' AND status <> 'Отклонено'
           AND (COALESCE(products, '') <> '' OR COALESCE(specialization, '') <> '' OR COALESCE(about, '') <> '')
    `);

    const counts = new Map();
    const samples = new Map();
    for (const row of rows) {
        const bucket = classify(row);
        counts.set(bucket, (counts.get(bucket) || 0) + 1);
        if (!samples.has(bucket)) samples.set(bucket, []);
        const list = samples.get(bucket);
        if (list.length < 5) list.push(`${row.company} — ${String(row.products || row.specialization || '').slice(0, 70)}`);
    }

    const total = rows.length;
    const share = (n) => `${Math.round((n / total) * 100)}%`;

    console.log(`Карточек в индексируемом каталоге: ${total}\n`);
    for (const [bucket, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`${String(n).padStart(5)}  ${share(n).padStart(4)}  ${bucket}`);
        for (const s of samples.get(bucket)) console.log(`               · ${s}`);
    }

    const ours = counts.get('наша тема') || 0;
    console.log(`\nПо теме площадки: ${ours} из ${total} (${share(ours)}).`);
    console.log('Остальные карточки открыты для индексации наравне с профильными.');
    console.log('Ничего не изменено: это только отчёт.');

    await pool.end();
}

main().catch((e) => {
    console.error('Ошибка:', e.message);
    process.exit(1);
});
