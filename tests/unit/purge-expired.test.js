'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { purgeExpiredTokens, TOKEN_TABLES } = require('../../lib/purge-expired');

/* Ночная уборка мёртвых токенов.

   Проверяем то, на чём такая уборка вредит: чтобы она не трогала живые строки
   и чтобы падение на одной таблице не отменяло остальные — это уборка, а не
   работа, и ронять из-за неё крон нельзя. */

function pool(behaviour = {}) {
    const calls = [];
    return {
        calls,
        async query(sql) {
            calls.push(sql);
            const table = TOKEN_TABLES.find(t => sql.includes(t));
            if (behaviour[table] instanceof Error) throw behaviour[table];
            return { rowCount: behaviour[table] ?? 0 };
        },
    };
}

test('удаляются только протухшие строки, во всех трёх таблицах', async () => {
    const p = pool({ refresh_tokens: 12, password_reset_tokens: 3, email_verification_tokens: 0 });
    const { removed, failed } = await purgeExpiredTokens(p);

    assert.deepEqual(removed, { refresh_tokens: 12, password_reset_tokens: 3 },
        'таблицы без мусора в отчёте не нужны');
    assert.deepEqual(failed, {});
    assert.equal(p.calls.length, 3);
    for (const sql of p.calls) {
        assert.match(sql, /expires_at < NOW\(\)/i, 'без условия уборка снесла бы живые сессии');
        assert.doesNotMatch(sql, /expires_at > NOW\(\)/i);
    }
});

test('падение на одной таблице не отменяет остальные', async () => {
    const p = pool({ refresh_tokens: new Error('нет прав'), password_reset_tokens: 5, email_verification_tokens: 1 });
    const { removed, failed } = await purgeExpiredTokens(p);

    assert.deepEqual(removed, { password_reset_tokens: 5, email_verification_tokens: 1 });
    assert.deepEqual(failed, { refresh_tokens: 'нет прав' });
});
