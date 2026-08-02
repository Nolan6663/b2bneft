'use strict';

/**
 * Старые адреса вида /delivery.html редиректятся на /delivery. Раньше редирект
 * собирался из одного пути, и query-строка терялась: ссылка
 * `delivery.html?id=1` превращалась в `/delivery` без идентификатора, страница
 * не находила сделку и уводила пользователя в «Заказы». Тем же путём ломались
 * `company-profile.html?id=`, `catalog.html?search=` и `producer.html?order=`.
 */
function withQuery(originalUrl, target) {
    const qs = String(originalUrl || '');
    const at = qs.indexOf('?');
    if (at === -1) return target;
    const query = qs.slice(at);
    return query.length > 1 ? target + query : target;
}

module.exports = { withQuery };
