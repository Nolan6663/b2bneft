'use strict';

// Индивидуальный предприниматель — это физическое лицо, и его наименование в
// ЕГРИП/ГИСП есть ФИО живого человека, то есть персональные данные (152-ФЗ, ст. 3).
// Из этого следуют два ограничения, которые реестровые выгрузки не снимают:
//
//   • публикация. «Данные взяты из открытого реестра» не даёт права печатать их
//     у себя: распространение персональных данных — отдельное основание
//     (152-ФЗ, ст. 10.1), и открытость источника его не заменяет;
//   • рассылка. Реклама по сетям электросвязи допускается только с
//     предварительного согласия адресата (ФЗ-38 «О рекламе», ст. 18 ч. 1),
//     а доказывать наличие согласия обязан отправитель.
//
// Поэтому карточка ИП, которую предприниматель сам не забрал (claimed = false),
// не получает писем и показывается без полного ФИО. Забрал — значит прошёл
// регистрацию с согласием, и дальше это обычный пользователь без ограничений.
//
// Юрлица (ООО, АО, ПАО) под всё это не подпадают: название и ИНН организации
// персональными данными не являются.

const SOLE_TRADER_RE = /^(ИП|ИНДИВИДУАЛЬНЫЙ\s+ПРЕДПРИНИМАТЕЛЬ)(\s+|$)/i;

function isSoleTraderName(name) {
    return SOLE_TRADER_RE.test(String(name == null ? '' : name).trim());
}

/** row — строка companies или модель из rowToCompany: обе несут поле company. */
function isSoleTrader(row) {
    return !!row && isSoleTraderName(row.company);
}

function capitalize(word) {
    return word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : '';
}

/** «ИП НИКОЛЕНКО АНДРЕЙ ФЁДОРОВИЧ» → «ИП Николенко А. Ф.»
 *  Фамилии с инициалами хватает, чтобы предприниматель узнал свою карточку и
 *  забрал её, — а полное имя в выдачу и в JSON не уходит. */
function soleTraderShortName(name) {
    const rest = String(name == null ? '' : name).trim()
        .replace(SOLE_TRADER_RE, '').split(/\s+/).filter(Boolean);
    if (!rest.length) return 'Индивидуальный предприниматель';
    const [surname, ...names] = rest;
    const initials = names
        .filter(n => /[А-ЯЁA-Za-zа-яё]/.test(n))
        .map(n => `${n.charAt(0).toUpperCase()}.`)
        .join(' ');
    return `ИП ${capitalize(surname)}${initials ? ' ' + initials : ''}`;
}

/** Имя, которое разрешено показать наружу: анонимным посетителям, в JSON API,
 *  в мета-тегах. Для юрлиц и для забранных карточек — как есть. */
function publicCompanyName(row) {
    if (!row) return '';
    const name = String(row.company == null ? '' : row.company).trim();
    if (!isSoleTraderName(name)) return name;
    // claimed приходит из БД булевым, а из rowToCompany — как r.claimed !== false.
    if (row.claimed === true) return name;
    return soleTraderShortName(name);
}

/** Условие WHERE, выбирающее карточки ИП, которые завели мы из реестра и
 *  владелец их не подтвердил. Ровно эти строки нельзя ни публиковать, ни слать
 *  им письма — и ровно их чистит scripts/cleanup-sole-trader-pd.js.
 *
 *  alias — префикс таблицы («c» для `FROM companies c`), пустая строка для
 *  запросов без алиаса. Регулярка POSIX-совместимая, Postgres понимает \s. */
function unclaimedSoleTradersSql(alias) {
    const p = alias ? `${alias}.` : '';
    return `(${p}claimed = false AND ${p}company ~* '^(ИП|ИНДИВИДУАЛЬНЫЙ\\s+ПРЕДПРИНИМАТЕЛЬ)(\\s|$)')`;
}

/** То же условие со знаком «наоборот» — для выборок, которые уходят наружу.
 *  Держим одной строкой, чтобы запросы не разъехались по мере правок. */
function excludeUnclaimedSoleTradersSql(alias) {
    return `NOT ${unclaimedSoleTradersSql(alias)}`;
}

module.exports = {
    SOLE_TRADER_RE,
    isSoleTraderName,
    isSoleTrader,
    soleTraderShortName,
    publicCompanyName,
    unclaimedSoleTradersSql,
    excludeUnclaimedSoleTradersSql,
};
