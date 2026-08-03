'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVkPoster } = require('../../lib/vk-poster');

/* Автопостинг в сообщество. Проверяем то, что дорого стоит в проде: рубильник
   действительно глушит отправку, тестовые закупки не попадают в живую ленту,
   в посте есть ссылка на страницу заявки, а сбой ВК не роняет запись
   навсегда — она возвращается в очередь до исчерпания попыток. */

function fakePool(rows = []) {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
            if (/SELECT id, order_id, attempts FROM vk_posts/i.test(sql)) return { rows };
            if (/SELECT \* FROM orders WHERE id/i.test(sql)) {
                return { rows: [{ id: 5, title: 'Манжеты', category: 'РТИ', quantity: 200, deadline: '2026-09-01', description: 'полиуретан, ГОСТ' }] };
            }
            return { rows: [] };
        },
    };
}

const env = (vals) => {
    const saved = {};
    for (const [k, v] of Object.entries(vals)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return () => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    };
};

test('рубильник VK_AUTOPOST_ENABLED=0 не даёт постить', async () => {
    const restore = env({ VK_AUTOPOST_ENABLED: '0', VK_ACCESS_TOKEN: 'x', VK_GROUP_ID: '1' });
    try {
        const pool = fakePool([{ id: 1, order_id: 5, attempts: 0 }]);
        let called = false;
        const poster = createVkPoster({ pool, fetchImpl: async () => { called = true; } });
        assert.equal(poster.isEnabled(), false);
        assert.equal(await poster.tick(), 0);
        assert.equal(called, false, 'к ВК ходить не должны');
        assert.equal(pool.calls.length, 0, 'очередь читать тоже незачем');
    } finally { restore(); }
});

test('без токена воркер не стартует', () => {
    const restore = env({ VK_AUTOPOST_ENABLED: undefined, VK_ACCESS_TOKEN: undefined, VK_GROUP_ID: '1' });
    try {
        const poster = createVkPoster({ pool: fakePool() });
        assert.equal(poster.isEnabled(), false);
        assert.equal(poster.start(), null);
    } finally { restore(); }
});

test('тестовые закупки в очередь не попадают', async () => {
    const pool = fakePool();
    const poster = createVkPoster({ pool });
    assert.equal(await poster.enqueue({ id: 1, company: 'ООО ТестПоставщик' }), false);
    assert.equal(await poster.enqueue({ id: 2, company: 'E2E проверка' }), false);
    assert.equal(pool.calls.length, 0, 'INSERT быть не должно');

    assert.equal(await poster.enqueue({ id: 3, company: 'ООО Нефтемаш' }), true);
    assert.match(pool.calls[0].sql, /INSERT INTO vk_posts/);
    assert.match(pool.calls[0].sql, /ON CONFLICT \(order_id\) DO NOTHING/, 'дедупликация должна быть в самом запросе');
});

test('в тексте поста есть суть заявки и ссылка на её страницу', () => {
    const poster = createVkPoster({ pool: fakePool(), appUrl: 'https://texzakaz.ru/' });
    const msg = poster.buildMessage({
        id: 42, title: 'Манжеты уплотнительные', category: 'РТИ', quantity: 200,
        deadline: '2026-09-01', description: 'полиуретан, рабочая среда — нефть',
    });
    assert.match(msg, /Манжеты уплотнительные/);
    assert.match(msg, /Категория: РТИ/);
    assert.match(msg, /Количество: 200 шт\./);
    assert.match(msg, /https:\/\/texzakaz\.ru\/zakupka\/42/);
    assert.ok(!msg.includes('//zakupka'), 'слэш в конце APP_URL не должен удваиваться');
});

test('длинное описание обрезается, а не улетает целиком', () => {
    const poster = createVkPoster({ pool: fakePool() });
    const msg = poster.buildMessage({ id: 1, title: 'Заявка', description: 'а'.repeat(1200) });
    assert.ok(msg.includes('…'), 'должен стоять признак обрезки');
    assert.ok(msg.length < 900, `пост слишком длинный: ${msg.length}`);
});

test('сбой ВК возвращает запись в очередь, после пяти попыток — в failed', async () => {
    const restore = env({ VK_AUTOPOST_ENABLED: '1', VK_ACCESS_TOKEN: 'x', VK_GROUP_ID: '1' });
    try {
        const pool = fakePool([{ id: 1, order_id: 5, attempts: 0 }]);
        const poster = createVkPoster({
            pool,
            fetchImpl: async () => ({ json: async () => ({ error: { error_code: 214, error_msg: 'Access to adding post denied' } }) }),
        });
        await poster.tick();
        const upd = pool.calls.find(c => /UPDATE vk_posts SET status = \$1/.test(c.sql));
        assert.ok(upd, 'статус должен обновиться');
        assert.equal(upd.params[0], 'pending', 'первая неудача возвращает в очередь');
        assert.equal(upd.params[1], 1);
        assert.match(upd.params[2], /Access to adding post denied/);

        const poolLast = fakePool([{ id: 1, order_id: 5, attempts: 4 }]);
        const poster2 = createVkPoster({
            pool: poolLast,
            fetchImpl: async () => ({ json: async () => ({ error: { error_code: 214, error_msg: 'denied' } }) }),
        });
        await poster2.tick();
        const updLast = poolLast.calls.find(c => /UPDATE vk_posts SET status = \$1/.test(c.sql));
        assert.equal(updLast.params[0], 'failed', 'после пятой попытки долбить ВК прекращаем');
    } finally { restore(); }
});

test('закрытая заявка и просроченный дедлайн в ленту не уходят', () => {
    const poster = createVkPoster({ pool: fakePool() });
    const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const past = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);

    assert.equal(poster.skipReason({ status: 'Активный', deadline: future }), null, 'живую заявку публикуем');
    assert.match(poster.skipReason({ status: 'Закрыта', deadline: future }), /статус/);
    assert.match(poster.skipReason({ status: 'Отменена', deadline: future }), /статус/);
    assert.match(poster.skipReason({ status: 'Активный', deadline: past }), /дедлайн/);
    assert.equal(poster.skipReason(null), 'закупка удалена');
});

test('пропущенная закупка помечается skipped, к ВК не ходим', async () => {
    const restore = env({ VK_AUTOPOST_ENABLED: '1', VK_ACCESS_TOKEN: 'x', VK_GROUP_ID: '1' });
    try {
        const pool = fakePool([{ id: 1, order_id: 5, attempts: 0 }]);
        /* закупка из fakePool закрыта дедлайном 2026-09-01 в прошлом или статусом */
        pool.query = (sql, params) => {
            pool.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
            if (/SELECT id, order_id, attempts FROM vk_posts/i.test(sql)) return Promise.resolve({ rows: [{ id: 1, order_id: 5, attempts: 0 }] });
            if (/SELECT \* FROM orders WHERE id/i.test(sql)) return Promise.resolve({ rows: [{ id: 5, title: 'Манжеты', status: 'Закрыта', deadline: '2027-01-01' }] });
            return Promise.resolve({ rows: [] });
        };
        let called = false;
        const poster = createVkPoster({ pool, fetchImpl: async () => { called = true; return { json: async () => ({ response: {} }) }; } });
        await poster.tick();
        assert.equal(called, false, 'к ВК ходить незачем');
        const upd = pool.calls.find(c => /status = 'skipped'/.test(c.sql));
        assert.ok(upd, 'запись должна помечаться пропущенной');
        assert.match(upd.params[0], /статус/);
    } finally { restore(); }
});

test('ВК отказал в карточке ссылки — постим без вложения, а не теряем публикацию', async () => {
    const restore = env({ VK_AUTOPOST_ENABLED: '1', VK_ACCESS_TOKEN: 'x', VK_GROUP_ID: '1' });
    try {
        const pool = fakePool([{ id: 1, order_id: 5, attempts: 0 }]);
        const attempts = [];
        const poster = createVkPoster({
            pool,
            fetchImpl: async (url, opts) => {
                const params = Object.fromEntries(new URLSearchParams(opts.body));
                attempts.push(params);
                if (params.attachments) {
                    return { json: async () => ({ error: { error_code: 100, error_msg: 'One of the parameters specified was missing or invalid: Violated: link_photo_sizing_rule. No photo given' } }) };
                }
                return { json: async () => ({ response: { post_id: 99 } }) };
            },
        });
        await poster.tick();

        assert.equal(attempts.length, 2, 'должно быть две попытки: с вложением и без');
        assert.ok(attempts[0].attachments, 'сначала пробуем с карточкой');
        assert.equal(attempts[1].attachments, undefined, 'потом без неё');
        assert.match(attempts[1].message, /zakupka\/5/, 'ссылка остаётся в тексте');

        const sent = pool.calls.find(c => /status = 'sent'/.test(c.sql));
        assert.ok(sent, 'публикация должна засчитаться');
        assert.equal(sent.params[0], 99);
    } finally { restore(); }
});

test('прочие ошибки ВК не превращаются в повтор без вложения', async () => {
    const restore = env({ VK_AUTOPOST_ENABLED: '1', VK_ACCESS_TOKEN: 'x', VK_GROUP_ID: '1' });
    try {
        const pool = fakePool([{ id: 1, order_id: 5, attempts: 0 }]);
        let calls = 0;
        const poster = createVkPoster({
            pool,
            fetchImpl: async () => {
                calls += 1;
                return { json: async () => ({ error: { error_code: 214, error_msg: 'Access to adding post denied' } }) };
            },
        });
        await poster.tick();
        assert.equal(calls, 1, 'на отказ в правах повторять бессмысленно');
        const upd = pool.calls.find(c => /UPDATE vk_posts SET status = \$1/.test(c.sql));
        assert.equal(upd.params[0], 'pending');
    } finally { restore(); }
});

test('успешная публикация помечается sent и сохраняет id поста', async () => {
    const restore = env({ VK_AUTOPOST_ENABLED: '1', VK_ACCESS_TOKEN: 'x', VK_GROUP_ID: '240643596' });
    try {
        const pool = fakePool([{ id: 1, order_id: 5, attempts: 0 }]);
        let sentParams = null;
        const poster = createVkPoster({
            pool,
            fetchImpl: async (url, opts) => {
                sentParams = Object.fromEntries(new URLSearchParams(opts.body));
                return { json: async () => ({ response: { post_id: 77 } }) };
            },
        });
        await poster.tick();
        assert.equal(sentParams.owner_id, '-240643596', 'постим от имени сообщества, id со знаком минус');
        assert.equal(sentParams.from_group, '1');
        const upd = pool.calls.find(c => /status = 'sent'/.test(c.sql));
        assert.ok(upd, 'запись должна помечаться отправленной');
        assert.equal(upd.params[0], 77);
    } finally { restore(); }
});
