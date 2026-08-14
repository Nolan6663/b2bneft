'use strict';

/* Уборка мёртвых токенов.
 *
 * Все три таблицы читаются с условием expires_at > NOW(), то есть протухшая
 * строка ничего не открывает — но и не исчезает: до сих пор их не удалял
 * никто. Раньше это было почти незаметно (одна запись на вход, живущая
 * месяц), а после «запомнить меня» разовый вход живёт 12 часов, и строк
 * станет по одной на каждый вход с общей машины.
 *
 * Растёт от этого не только место: refresh_tokens просматривается на каждом
 * продлении сессии, а сессии в настройках человек читает глазами — мёртвые
 * строки там не нужны никому.
 *
 * Это уборка, а не работа: ошибка не должна ронять крон, поэтому таблицы
 * чистятся по отдельности и падение одной не отменяет остальные.
 */

// Имена таблиц — константы в коде и в запрос подставляются как есть:
// параметризовать идентификатор нельзя, а списка снаружи здесь нет.
const TOKEN_TABLES = ['refresh_tokens', 'password_reset_tokens', 'email_verification_tokens'];

async function purgeExpiredTokens(pool) {
    const removed = {};
    const failed = {};
    for (const table of TOKEN_TABLES) {
        try {
            const { rowCount } = await pool.query(`DELETE FROM ${table} WHERE expires_at < NOW()`);
            if (rowCount) removed[table] = rowCount;
        } catch (e) {
            failed[table] = e.message;
        }
    }
    return { removed, failed };
}

module.exports = { purgeExpiredTokens, TOKEN_TABLES };
