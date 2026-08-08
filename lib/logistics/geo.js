'use strict';

// Разрешение города в коды перевозчиков.
//
// Зачем слой вообще: справочники у перевозчиков свои и несовместимые. ПЭК ждёт
// собственный числовой id (Москва — «-446»), Деловые Линии — код КЛАДР, СДЭК —
// свои коды, Почта — индекс. Отдать перевозчику строку «Москва» нельзя.
//
// Вторая причина — то, что лежит в companies.city. Это свободный текст, который
// заполняли люди: «СПб», «г. Санкт-Петербург», «Санкт-Петербург» — для нас один
// город, для базы три разные строки. Поэтому поиск идёт не по названию, а по
// нормализованному ключу.
//
// Принцип: не угадывать. В справочнике ПЭК 4810 населённых пунктов, и 307
// названий встречаются больше одного раза: «Белый Яр» есть под Абаканом и под
// Сургутом, между ними 2500 км. Поэтому resolveCity возвращает не город, а
// исход: нашли / не нашли / нашли несколько. В последнем случае выбирает
// человек. Неверный терминал хуже отсутствия расчёта — цену до чужого города
// человек увидит и ей поверит.

// Разговорные формы, которые люди реально пишут в профиле компании.
// Ключ — уже нормализованная строка (после замены дефисов на пробелы).
const CITY_ALIASES = {
    'спб': 'санкт петербург',
    'с пб': 'санкт петербург',
    'питер': 'санкт петербург',
    'петербург': 'санкт петербург',
    'ленинград': 'санкт петербург',
    'мск': 'москва',
    'екб': 'екатеринбург',
    'ебург': 'екатеринбург',
    'нн': 'нижний новгород',
    'нижний': 'нижний новгород',
    'новосиб': 'новосибирск',
    'ростов дон': 'ростов на дону',
};

// Префиксы вида «г.», «пос.», «пгт» срезаются только в начале строки: внутри
// названия одиночная буква — часть имени, а не сокращение («Старый Оскол»).
const SETTLEMENT_PREFIX = /^(?:г|гор|город|пос|пгт|рп|п|с|село|д|дер|деревня|ст|станица|х|хутор|мкр)\.?\s+/;

/**
 * Приводит написанное человеком название города к ключу поиска.
 * «Белый Яр (Алтайский р-н)» → «белый яр», «г. Ростов-на-Дону» → «ростов на дону».
 */
function normalizeCityName(raw) {
    let s = String(raw == null ? '' : raw).toLowerCase().replace(/ё/g, 'е');
    s = s.replace(/\([^)]*\)/g, ' ');           // уточнение района в скобках
    s = s.replace(/[-–—]/g, ' ');     // Ростов-на-Дону ≡ Ростов на Дону
    s = s.replace(/[^a-zа-я0-9 .]/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    // «г. пос. Северный» — редкость, но два прохода дешевле разбирательств
    for (let i = 0; i < 2 && SETTLEMENT_PREFIX.test(s); i += 1) {
        s = s.replace(SETTLEMENT_PREFIX, '');
    }
    s = s.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
    return CITY_ALIASES[s] || s;
}

/** Уточнение из скобок: «Белый Яр (Алтайский р-н)» → «Алтайский р-н». */
function extractQualifier(name) {
    const m = /\(([^)]*)\)/.exec(String(name == null ? '' : name));
    return m ? m[1].trim() : '';
}

/**
 * Разбирает справочник ПЭК (https://pecom.ru/ru/calc/towns.php).
 * Формат: { "<хаб>": { "<id>": "<название>" } }. Отрицательный id — сам хаб,
 * положительный — населённый пункт в его зоне обслуживания. На 2026-08-08:
 * 225 хабов, 4810 записей, ровно один отрицательный id на группу.
 */
function parsePecomTowns(payload) {
    const out = [];
    if (!payload || typeof payload !== 'object') return out;
    for (const [hub, towns] of Object.entries(payload)) {
        if (!towns || typeof towns !== 'object') continue;
        for (const [id, name] of Object.entries(towns)) {
            const searchKey = normalizeCityName(name);
            if (!searchKey) continue;
            out.push({
                name: String(name).trim(),
                qualifier: extractQualifier(name),
                searchKey,
                pecomId: String(id),
                pecomHub: String(hub),
                isHub: String(id).startsWith('-'),
            });
        }
    }
    return out;
}

function rowToPoint(row) {
    return {
        id: row.id,
        name: row.name,
        qualifier: row.qualifier || '',
        hub: row.pecom_hub || '',
        isHub: Boolean(row.is_hub),
        codes: {
            pecom: row.pecom_id || null,
            dellin: row.dellin_code || null,
        },
    };
}

/**
 * Выбор среди совпавших по ключу. Чистая функция — вся логика «не угадывать»
 * живёт здесь и проверяется тестами без базы.
 *
 * Хаб побеждает населённый пункт: у него есть терминал, и когда человек пишет
 * «Дубровка», он почти наверняка имеет в виду ту, где терминал. Два хаба или
 * два одинаковых посёлка — неоднозначность, выбирает человек.
 */
function pickCity(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) return { status: 'not_found', point: null, candidates: [] };

    const hubs = list.filter((r) => r.is_hub);
    if (hubs.length === 1) return { status: 'ok', point: rowToPoint(hubs[0]), candidates: [] };
    if (hubs.length === 0 && list.length === 1) return { status: 'ok', point: rowToPoint(list[0]), candidates: [] };

    const candidates = (hubs.length > 1 ? hubs : list).map(rowToPoint);
    return { status: 'ambiguous', point: null, candidates };
}

/**
 * Город → точка с кодами перевозчиков.
 * Возвращает { status: 'ok' | 'not_found' | 'ambiguous', point, candidates }.
 */
async function resolveCity(pool, query) {
    const key = normalizeCityName(query);
    if (!key) return { status: 'not_found', point: null, candidates: [] };
    const { rows } = await pool.query(
        `SELECT id, name, qualifier, pecom_id, pecom_hub, dellin_code, is_hub
           FROM logistics_cities
          WHERE search_key = $1
          ORDER BY is_hub DESC, id ASC`,
        [key]
    );
    return pickCity(rows);
}

/** Подсказки для поля ввода: хабы вперёд, они интереснее по терминалам. */
async function suggestCities(pool, query, limit = 10) {
    const key = normalizeCityName(query);
    if (key.length < 2) return [];
    const { rows } = await pool.query(
        `SELECT id, name, qualifier, pecom_id, pecom_hub, dellin_code, is_hub
           FROM logistics_cities
          WHERE search_key LIKE $1
          ORDER BY is_hub DESC, length(search_key) ASC, name ASC
          LIMIT $2`,
        [key + '%', Math.min(Number(limit) || 10, 50)]
    );
    return rows.map(rowToPoint);
}

/**
 * Дописывает городу код Деловых Линий, если его ещё нет.
 *
 * Справочник ПЭК отдаётся целиком одним файлом, а у Деловых Линий такого файла
 * нет — код добывается их же поиском по одному городу. Поэтому лениво:
 * спросили один раз при первом расчёте по этому городу и запомнили.
 *
 * lookup передаётся снаружи, чтобы гео-слой не зависел от модуля перевозчика и
 * проверялся без сети. Не нашли — не беда: перевозчик просто не посчитает этот
 * маршрут, а остальные посчитают.
 */
async function fillDellinCode(pool, point, lookup) {
    if (!point || !point.id || (point.codes && point.codes.dellin)) return point;
    let code = null;
    try {
        code = await lookup(point.name);
    } catch {
        return point;   // поиск недоступен — считаем без Деловых Линий
    }
    if (!code) return point;
    await pool.query(
        'UPDATE logistics_cities SET dellin_code = $1, updated_at = NOW() WHERE id = $2',
        [code, point.id]
    );
    point.codes.dellin = code;
    return point;
}

/**
 * Складывает разобранный справочник в таблицу. Возвращает число записей.
 *
 * Пишем пачками: 4810 городов по запросу на каждый — это тысячи round-trip
 * до базы там, где хватает десятка. Конфликт держится по pecom_id: search_key
 * не уникален намеренно (см. комментарий к таблице в db.js).
 */
async function saveCities(pool, cities, chunkSize = 500) {
    const list = Array.isArray(cities) ? cities : [];
    for (let i = 0; i < list.length; i += chunkSize) {
        const chunk = list.slice(i, i + chunkSize);
        const values = [];
        const params = [];
        chunk.forEach((city, n) => {
            const base = n * 6;
            values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, NOW())`);
            params.push(city.name, city.qualifier || '', city.searchKey, city.pecomId, city.pecomHub, city.isHub);
        });
        await pool.query(
            `INSERT INTO logistics_cities (name, qualifier, search_key, pecom_id, pecom_hub, is_hub, updated_at)
             VALUES ${values.join(', ')}
             ON CONFLICT (pecom_id) DO UPDATE
                SET name = EXCLUDED.name,
                    qualifier = EXCLUDED.qualifier,
                    search_key = EXCLUDED.search_key,
                    pecom_hub = EXCLUDED.pecom_hub,
                    is_hub = EXCLUDED.is_hub,
                    updated_at = NOW()`,
            params
        );
    }
    return list.length;
}

module.exports = {
    normalizeCityName,
    extractQualifier,
    parsePecomTowns,
    pickCity,
    resolveCity,
    suggestCities,
    fillDellinCode,
    saveCities,
    CITY_ALIASES,
};
