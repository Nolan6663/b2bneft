'use strict';

/**
 * Регионы для страниц вида /zakupki/region/<slug>.
 *
 * `name` — значение колонки `city` в таблице companies: реестр ГИСП пишет туда
 * регион, а не город, поэтому группировка идёт по точному совпадению строки.
 * Список — регионы, где в каталоге больше сорока предприятий: на меньших числах
 * страница получается пустой витриной, которую незачем звать в индекс.
 *
 * `where` — предложный падеж для заголовков («поставщики в Свердловской области»).
 */
const REGIONS = [
    { slug: 'moskva',            name: 'Москва',                           where: 'в Москве' },
    { slug: 'sankt-peterburg',   name: 'Санкт-Петербург',                  where: 'в Санкт-Петербурге' },
    { slug: 'moskovskaya',       name: 'Московская область',               where: 'в Московской области' },
    { slug: 'sverdlovskaya',     name: 'Свердловская область',             where: 'в Свердловской области' },
    { slug: 'nizhegorodskaya',   name: 'Нижегородская область',            where: 'в Нижегородской области' },
    { slug: 'chelyabinskaya',    name: 'Челябинская область',              where: 'в Челябинской области' },
    { slug: 'tatarstan',         name: 'Республика Татарстан (Татарстан)', where: 'в Татарстане', short: 'Татарстан' },
    { slug: 'ivanovskaya',       name: 'Ивановская область',               where: 'в Ивановской области' },
    { slug: 'rostovskaya',       name: 'Ростовская область',               where: 'в Ростовской области' },
    { slug: 'permskiy',          name: 'Пермский край',                    where: 'в Пермском крае' },
    { slug: 'samarskaya',        name: 'Самарская область',                where: 'в Самарской области' },
    { slug: 'krasnodarskiy',     name: 'Краснодарский край',               where: 'в Краснодарском крае' },
    { slug: 'bashkortostan',     name: 'Республика Башкортостан',          where: 'в Башкортостане', short: 'Башкортостан' },
    { slug: 'novosibirskaya',    name: 'Новосибирская область',            where: 'в Новосибирской области' },
    { slug: 'leningradskaya',    name: 'Ленинградская область',            where: 'в Ленинградской области' },
    { slug: 'altayskiy',         name: 'Алтайский край',                   where: 'в Алтайском крае' },
    { slug: 'chuvashiya',        name: 'Чувашская Республика - Чувашия',   where: 'в Чувашии', short: 'Чувашия' },
    { slug: 'ryazanskaya',       name: 'Рязанская область',                where: 'в Рязанской области' },
    { slug: 'yaroslavskaya',     name: 'Ярославская область',              where: 'в Ярославской области' },
    { slug: 'penzenskaya',       name: 'Пензенская область',               where: 'в Пензенской области' },
    { slug: 'vladimirskaya',     name: 'Владимирская область',             where: 'во Владимирской области' },
    { slug: 'krasnoyarskiy',     name: 'Красноярский край',                where: 'в Красноярском крае' },
    { slug: 'udmurtiya',         name: 'Удмуртская Республика',            where: 'в Удмуртии', short: 'Удмуртия' },
    { slug: 'saratovskaya',      name: 'Саратовская область',              where: 'в Саратовской области' },
    { slug: 'tverskaya',         name: 'Тверская область',                 where: 'в Тверской области' },
    { slug: 'belgorodskaya',     name: 'Белгородская область',             where: 'в Белгородской области' },
    { slug: 'omskaya',           name: 'Омская область',                   where: 'в Омской области' },
    { slug: 'kirovskaya',        name: 'Кировская область',                where: 'в Кировской области' },
    { slug: 'stavropolskiy',     name: 'Ставропольский край',              where: 'в Ставропольском крае' },
    { slug: 'voronezhskaya',     name: 'Воронежская область',              where: 'в Воронежской области' },
];

/** Короткое имя для крошек и ссылок: у республик оно отличается от значения в базе. */
function regionLabel(region) {
    return region.short || region.name;
}

function regionBySlug(slug) {
    return REGIONS.find(r => r.slug === String(slug || '').toLowerCase()) || null;
}

module.exports = { REGIONS, regionBySlug, regionLabel };
