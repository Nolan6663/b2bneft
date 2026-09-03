'use strict';

const crypto = require('crypto');

/* Журнал внутреннего поиска.
 *
 * Состав полей задан ТЗ маркетологов (раздел 8.1) и держится на простой мысли:
 * сама по себе фраза показывает только спрос. Нашёл ли человек нужное, видно
 * лишь по тому, что было дальше — открыл карточку, разместил заказ, ушёл ни с
 * чем. Поэтому в одной строке живут и запрос, и его исход.
 *
 * Ноль результатов — самая ценная строка в этой таблице: это спрос, которого у
 * нас в каталоге нет, и по нему решается, чего не хватает — страницы, синонима
 * или самого предприятия.
 *
 * Чего здесь намеренно нет: пользователя. Связывать поисковые фразы с личностью
 * нам незачем ни для одной задачи, а по ФЗ-152 лишние персональные данные —
 * лишний риск. Вместо этого псевдонимный ключ: он склеивает запрос с кликом
 * того же человека и ничего не говорит о том, кто это.
 */

const MAX_QUERY = 300;

/** Лексическая нормализация: регистр, ё, пунктуация, лишние пробелы.
 *
 *  Морфологию и опечатки здесь намеренно не трогаем, хотя ТЗ их упоминает:
 *  «валов» и «вал» сводит к одному кластеру редактор или стеммер на этапе
 *  разбора, а молчаливое обрезание окончаний в момент записи потеряет исходную
 *  формулировку — ровно то, ради чего рядом лежит query_raw. */
function normalizeQuery(raw) {
    return String(raw == null ? '' : raw)
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, MAX_QUERY);
}

/** Псевдонимный ключ сессии.
 *
 *  Соль обязательна: без неё хеш от короткого числового id восстанавливается
 *  перебором за секунды, и «псевдонимный» стало бы просто словом. */
function sessionKey(userId) {
    if (!userId) return '';
    const salt = process.env.JWT_SECRET || process.env.APP_URL || 'texzakaz';
    return crypto.createHash('sha256').update(`${userId}|${salt}`).digest('hex').slice(0, 32);
}

/** Роль в терминах ТЗ: заказчик, исполнитель, неизвестно. */
function roleOf(user) {
    if (!user) return 'unknown';
    if (user.role === 'customer') return 'customer';
    if (user.role === 'producer' || user.role === 'supplier') return 'producer';
    return 'unknown';
}

/**
 * Пишет запрос и возвращает id строки — по нему потом дописывается исход.
 *
 * Никогда не бросает: журнал — это наблюдение за поиском, а не часть поиска.
 * Упавшая запись в лог не должна отнимать у снабженца выдачу.
 */
async function logSearch(pool, { queryRaw, user, resultsCount, resultGroups, region }) {
    try {
        const normalized = normalizeQuery(queryRaw);
        if (!normalized) return null;
        const { rows: [row] } = await pool.query(
            `INSERT INTO search_queries
                (query_raw, query_normalized, role, region, results_count, result_groups, session_key)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [
                String(queryRaw || '').slice(0, MAX_QUERY),
                normalized,
                roleOf(user),
                String(region || '').slice(0, 120),
                Number(resultsCount) || 0,
                JSON.stringify(resultGroups || {}),
                sessionKey(user && user.id),
            ]
        );
        return row ? row.id : null;
    } catch (e) {
        console.warn('[search-log] запрос не записан:', e.message);
        return null;
    }
}

/**
 * Дописывает исход: что открыли и чем это кончилось.
 *
 * Ключ сессии здесь не для аналитики, а для права на запись: без него любой
 * авторизованный мог бы дописать исход чужому запросу, зная только его номер.
 */
async function recordOutcome(pool, { id, user, clickedEntity, conversion }) {
    try {
        const rowId = Number(id);
        if (!Number.isInteger(rowId) || rowId <= 0) return false;
        const key = sessionKey(user && user.id);
        if (!key) return false;
        const { rowCount } = await pool.query(
            `UPDATE search_queries
                SET clicked_entity = COALESCE($1, clicked_entity),
                    conversion     = COALESCE($2, conversion)
              WHERE id = $3 AND session_key = $4`,
            [
                clickedEntity ? String(clickedEntity).slice(0, 120) : null,
                conversion ? String(conversion).slice(0, 60) : null,
                rowId,
                key,
            ]
        );
        return rowCount > 0;
    } catch (e) {
        console.warn('[search-log] исход не записан:', e.message);
        return false;
    }
}

module.exports = { normalizeQuery, sessionKey, roleOf, logSearch, recordOutcome };
