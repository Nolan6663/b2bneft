'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const createAuthRouter = require('../../routes/auth');
const { hashPassword, ACCESS_COOKIE, REFRESH_COOKIE } = require('../../lib/auth-tokens');
const { fakePool, serve } = require('./helpers');

/* Галочка «запомнить меня».

   До неё выбора не было вовсе: любой вход помнили месяц, в том числе с чужого
   компьютера. Смысл снятой галочки — вход, который кончается вместе с
   браузером, поэтому проверяем не саму галочку, а три места, где она обязана
   сработать: куки без срока, короткая запись в базе и продление, которое не
   должно втихую сделать такой вход постоянным. */

const USER = {
    id: 4, email: 'z@t.ru', role: 'producer', company: 'ООО Завод',
    password: hashPassword('secret12'), email_verified: true, totp_enabled: false,
};

function setCookies(res) {
    const raw = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie') || ''];
    const out = {};
    for (const line of raw) {
        const name = line.split('=')[0];
        out[name] = line;
    }
    return out;
}

function authApp({ tokenRows } = {}) {
    const pool = fakePool([
        { match: /SELECT \* FROM users WHERE LOWER\(email\)/i, rows: [USER] },
        { match: /INSERT INTO refresh_tokens/i, rows: [] },
        { match: /SELECT \* FROM refresh_tokens/i, rows: tokenRows || [] },
        { match: /SELECT \* FROM users WHERE id/i, rows: [USER] },
        { match: /UPDATE refresh_tokens SET last_used_at/i, rows: [] },
    ]);
    const router = createAuthRouter({
        pool, crypto,
        speakeasy: { totp: { verify: () => true } },
        QRCode: { toDataURL: async () => '' },
        requireAuth: (req, res, next) => next(),
        withTransaction: async (fn) => fn(pool),
        sendEmail: async () => {},
        sendPush: () => {},
        sendTelegramNotification: () => {},
        getUserIdsByCompany: async () => [],
        sendVerificationEmail: async () => {},
        APP_URL: 'https://test.local',
        rowToOrder: (r) => r,
        matchedProducers: async () => [],
    });
    return { pool, router };
}

test('галочка снята — куки без срока и короткая запись в базе', async () => {
    const { pool, router } = authApp();
    const srv = await serve('/api/auth', router);
    try {
        const res = await srv.request('/api/auth/login', {
            method: 'POST',
            body: { email: 'z@t.ru', password: 'secret12', remember: false },
        });
        assert.equal(res.status, 200);
        assert.equal(res.json.remembered, false, 'клиенту нужно знать, что вход разовый');

        const cookies = setCookies(res);
        assert.doesNotMatch(cookies[ACCESS_COOKIE], /Max-Age|Expires/i,
            'кука со сроком переживёт закрытие браузера — тогда галочка ничего не значит');
        assert.doesNotMatch(cookies[REFRESH_COOKIE], /Max-Age|Expires/i);
        assert.match(cookies[REFRESH_COOKIE], /HttpOnly/i);

        const insert = pool.calls.find(c => /INSERT INTO refresh_tokens/i.test(c.sql));
        assert.equal(insert.params[4], 12, 'запись в базе живёт 12 часов, а не месяц');
        assert.equal(insert.params[5], false, 'флаг нужен продлению сессии');
    } finally { await srv.close(); }
});

test('галочка стоит — прежнее поведение: месяц', async () => {
    const { pool, router } = authApp();
    const srv = await serve('/api/auth', router);
    try {
        const res = await srv.request('/api/auth/login', {
            method: 'POST',
            body: { email: 'z@t.ru', password: 'secret12', remember: true },
        });
        assert.equal(res.json.remembered, true);

        const cookies = setCookies(res);
        assert.match(cookies[REFRESH_COOKIE], /Max-Age=2592000/i, '30 дней, как было');

        const insert = pool.calls.find(c => /INSERT INTO refresh_tokens/i.test(c.sql));
        assert.equal(insert.params[4], 720);
        assert.equal(insert.params[5], true);
    } finally { await srv.close(); }
});

test('старый клиент без поля remember помнится по-прежнему', async () => {
    const { pool, router } = authApp();
    const srv = await serve('/api/auth', router);
    try {
        // Мобильное приложение и любой внешний клиент про галочку не знают —
        // молча превратить их вход в разовый значило бы сломать их на ровном месте.
        const res = await srv.request('/api/auth/login', {
            method: 'POST',
            body: { email: 'z@t.ru', password: 'secret12' },
        });
        assert.equal(res.json.remembered, true);
        const insert = pool.calls.find(c => /INSERT INTO refresh_tokens/i.test(c.sql));
        assert.equal(insert.params[5], true);
    } finally { await srv.close(); }
});

test('продление разового входа не делает его постоянным', async () => {
    const { router } = authApp({ tokenRows: [{ id: 9, user_id: 4, persistent: false }] });
    const srv = await serve('/api/auth', router);
    try {
        const res = await srv.request('/api/auth/refresh', {
            method: 'POST',
            headers: { Cookie: `${REFRESH_COOKIE}=${'b'.repeat(96)}` },
        });
        assert.equal(res.status, 200);
        const cookies = setCookies(res);
        assert.doesNotMatch(cookies[ACCESS_COOKIE], /Max-Age|Expires/i,
            'продление обязано сохранить характер входа, иначе галочка обходится сама собой');
        assert.doesNotMatch(cookies[REFRESH_COOKIE], /Max-Age|Expires/i);
    } finally { await srv.close(); }
});
