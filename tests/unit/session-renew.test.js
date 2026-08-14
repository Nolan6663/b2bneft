'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { renewAccessToken } = require('../../lib/session-renew');
const { JWT_SECRET, ACCESS_COOKIE, REFRESH_COOKIE } = require('../../lib/auth-tokens');
const { fakePool } = require('./helpers');

/* Продление сессии сервером.

   Access-кука живёт час и исчезает; apiFetch это переживает сам, а прямая
   ссылка на файл — нет. Проверяем то, на чём такой обмен ломается: чужой или
   протухший refresh не продлевает ничего, refresh-токен не меняется (иначе
   разлогинятся соседние вкладки), а на POST продления нет вовсе. */

const USER = { id: 3, role: 'producer', company: 'ООО Завод' };
const LIVE_TOKEN = 'a'.repeat(96);

function ctx({ method = 'GET', cookie = `${REFRESH_COOKIE}=${LIVE_TOKEN}`, tokenRows = [{ id: 11, user_id: 3 }], userRows = [USER] } = {}) {
    const pool = fakePool([
        { match: /SELECT \* FROM refresh_tokens/i, rows: tokenRows },
        { match: /SELECT \* FROM users/i, rows: userRows },
        { match: /UPDATE refresh_tokens SET last_used_at/i, rows: [] },
    ]);
    const cookies = [];
    const res = { cookie: (name, value, opts) => cookies.push({ name, value, opts }) };
    const req = { method, headers: { cookie } };
    return { pool, res, req, cookies };
}

test('живой refresh продлевает сессию и не трогает сам refresh-токен', async () => {
    const { pool, req, res, cookies } = ctx();
    const user = await renewAccessToken({ pool, req, res });

    assert.deepEqual(user, USER, 'дальше по цепочке уходит настоящий пользователь');

    const access = cookies.find(c => c.name === ACCESS_COOKIE);
    assert.ok(access, 'новая access-кука не выставлена — тогда следующий запрос снова упрётся в отказ');
    const payload = jwt.verify(access.value, JWT_SECRET);
    assert.equal(payload.userId, 3);
    assert.equal(payload.company, 'ООО Завод');
    assert.equal(access.opts.httpOnly, true, 'кука с токеном не должна быть видна скриптам');

    const refresh = cookies.find(c => c.name === REFRESH_COOKIE);
    assert.equal(refresh.value, LIVE_TOKEN, 'ротации нет: смена токена разлогинила бы соседние вкладки');

    const lookup = pool.calls.find(c => /SELECT \* FROM refresh_tokens/i.test(c.sql));
    assert.match(lookup.sql, /expires_at > NOW\(\)/i, 'протухший токен не должен считаться живым');
    assert.deepEqual(lookup.params, [LIVE_TOKEN]);
});

test('разовый вход продлевается такими же сессионными куками', async () => {
    const { pool, req, res, cookies } = ctx({ tokenRows: [{ id: 11, user_id: 3, persistent: false }] });
    await renewAccessToken({ pool, req, res });

    for (const cookie of cookies) {
        assert.equal(cookie.opts.maxAge, undefined,
            `${cookie.name} со сроком пережил бы браузер — продление втихую сделало бы вход постоянным`);
    }
});

test('POST не продлевается: cookie-авторизацию не расширяем на то, что меняет данные', async () => {
    const { pool, req, res, cookies } = ctx({ method: 'POST' });
    assert.equal(await renewAccessToken({ pool, req, res }), null);
    assert.equal(cookies.length, 0);
    assert.equal(pool.calls.length, 0, 'до базы дело доходить не должно');
});

test('без refresh-куки продлевать нечего', async () => {
    const { pool, req, res } = ctx({ cookie: '' });
    assert.equal(await renewAccessToken({ pool, req, res }), null);
    assert.equal(pool.calls.length, 0);
});

test('отозванный или истёкший refresh не пускает', async () => {
    const { pool, req, res, cookies } = ctx({ tokenRows: [] });
    assert.equal(await renewAccessToken({ pool, req, res }), null);
    assert.equal(cookies.length, 0, 'отказ не должен оставлять после себя новую куку');
});

test('удалённый пользователь с живым токеном не воскресает', async () => {
    const { pool, req, res, cookies } = ctx({ userRows: [] });
    assert.equal(await renewAccessToken({ pool, req, res }), null);
    assert.equal(cookies.length, 0);
});
