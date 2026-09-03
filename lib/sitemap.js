'use strict';

/* Сборка карты сайта.
 *
 * Вынесено из server.js ради одного правила, которое там было нарушено: до сих
 * пор всем адресам проставлялась сегодняшняя дата. Робот получал ежедневное
 * «обновилось всё», а значит — ничего: сигнал, которым нельзя отличить правку
 * профиля от простоя, не стоит ничего.
 *
 * Правило теперь такое: lastmod ставится там, где у нас есть настоящая дата
 * изменения, и не ставится нигде больше. Тег необязательный, и отсутствие
 * честнее выдумки. Отсюда же следует, что даты нет у статических страниц —
 * лендинга, категорийных, юридических: их содержимое меняется деплоем, а не
 * данными, и притворяться, что мы это отслеживаем, незачем.
 */

function xmlEscape(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Дата в формате W3C-даты, который понимает sitemaps.org: YYYY-MM-DD.
 *  Всё, что не разбирается в дату, считается отсутствующей датой, а не «сегодня». */
function isoDay(value) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}

/** Самая свежая из дат. Для страниц-списков (регион, операция, карта) lastmod —
 *  это дата последней правки среди тех предприятий, которые на ней показаны:
 *  список меняется тогда же, когда меняется любой его элемент. */
function latest(values) {
    let best = null;
    for (const v of values || []) {
        const d = v instanceof Date ? v : (v ? new Date(v) : null);
        if (!d || Number.isNaN(d.getTime())) continue;
        if (!best || d > best) best = d;
    }
    return best;
}

/**
 * @param {string} base — адрес сайта без завершающего слэша.
 * @param {Array<{url: string, priority?: string, changefreq?: string, lastmod?: Date|string|null}>} entries
 */
function renderSitemap(base, entries) {
    const root = String(base || '').replace(/\/$/, '');
    const body = (entries || []).map(entry => {
        const lines = [`    <loc>${xmlEscape(root + entry.url)}</loc>`];
        const day = isoDay(entry.lastmod);
        if (day) lines.push(`    <lastmod>${day}</lastmod>`);
        if (entry.changefreq) lines.push(`    <changefreq>${entry.changefreq}</changefreq>`);
        if (entry.priority) lines.push(`    <priority>${entry.priority}</priority>`);
        return `  <url>\n${lines.join('\n')}\n  </url>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`;
}

module.exports = { renderSitemap, isoDay, latest, xmlEscape };
