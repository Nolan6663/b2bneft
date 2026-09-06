'use strict';

/* Город предприятия по ИНН — через справочник организаций DaData.
 *
 * Зачем отдельный модуль рядом с lib/logistics/dadata: тот отвечает на вопрос
 * «куда везём», этот — «где стоит завод». Ключ и суточная квота общие (10 000
 * запросов), поэтому массовый проход по каталогу считает их так же, как расчёт
 * доставки, и живёт в скрипте с ограничением скорости.
 *
 * Почему вообще нужен внешний источник: в колонке city у двух третей карточек
 * стоит регион, а не город, — реестр ГИСП пишет туда «Удмуртская Республика».
 * Достать город из этой строки нельзя, его там нет. По ИНН он находится
 * однозначно, и это не догадка, а адрес из ЕГРЮЛ.
 */

const PARTY_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';
const TIMEOUT_MS = 8000;

/* Города федерального значения приезжают регионом, а не городом: у Москвы
   region = «Москва», а city — пусто. Без этого списка треть каталога осталась
   бы без города именно там, где предприятий больше всего. */
const FEDERAL_CITIES = new Set(['Москва', 'Санкт-Петербург', 'Севастополь']);

function isConfigured() {
    return Boolean((process.env.DADATA_API_KEY || '').trim());
}

function clean(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

/**
 * Достаёт город из адреса организации.
 *
 * Порядок не случайный: город, потом населённый пункт, потом город
 * федерального значения. Посёлок — это тоже ответ на вопрос «где завод», а
 * регион ответом не является: подставлять его сюда значило бы вернуть ту же
 * строку, из-за которой всё и затевалось.
 */
/* Не всякий населённый пункт — название места, которое можно поставить в
   заголовок. Живой ответ по одному заводу: «Автодорога Рязань-Спасск
   (с Дубровичи)». Формально это поле settlement, фактически — описание участка
   трассы, и в выдаче «завод — металлообработка, Автодорога Рязань-Спасск» это
   выглядит поломкой, а не адресом. Тот же урок уже был с промзоной Зеленограда:
   когда мы не уверены, что перед нами город, честнее не знать города вовсе. */
const NOT_A_TOWN = /автодорог|шоссе|километр|\bкм\b|промзон|промышленн|территор|массив|снт|днп|гск|участок/i;

function looksLikeTown(value) {
    return Boolean(value) && value.length <= 28 && !value.includes('(') && !NOT_A_TOWN.test(value);
}

function pickTown(address) {
    const d = (address && address.data) || {};
    const city = clean(d.city);
    if (looksLikeTown(city)) return city;
    const settlement = clean(d.settlement);
    if (looksLikeTown(settlement)) return settlement;
    const region = clean(d.region);
    return FEDERAL_CITIES.has(region) ? region : '';
}

/** Город по ИНН. Пустая строка означает «не нашли», а не «ошибка»: у ликвидированных
 *  и у не найденных в справочнике предприятий города просто нет. */
async function townByInn(inn, { fetchImpl = fetch } = {}) {
    const query = clean(inn);
    if (!isConfigured() || !/^\d{10}$|^\d{12}$/.test(query)) return '';

    const res = await fetchImpl(PARTY_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Token ${(process.env.DADATA_API_KEY || '').trim()}`,
        },
        body: JSON.stringify({ query, count: 1 }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
        const err = new Error(`DaData HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }

    const data = await res.json();
    const first = (data.suggestions || [])[0];
    return first ? pickTown(first.data && first.data.address) : '';
}

module.exports = { isConfigured, pickTown, townByInn };
