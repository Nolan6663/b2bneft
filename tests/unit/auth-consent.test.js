'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createAuthRouter = require('../../routes/auth');
const { fakePool, serve, baseDeps } = require('./helpers');
const { DOC_VERSION } = require('../../scripts/legal-data');

function authRouter() {
    const deps = baseDeps({ pool: fakePool([]) });
    return createAuthRouter(deps);
}

test('регистрация: без согласия — 400, до обращения к базе', async () => {
    const srv = await serve('/api/auth', authRouter());
    try {
        const res = await srv.request('/api/auth/register', {
            method: 'POST',
            body: { email: 'a@b.ru', password: 'password1', company: 'ООО Тест', role: 'customer' },
        });
        assert.equal(res.status, 400);
        assert.match(res.json.error, /соглас/i);
    } finally { await srv.close(); }
});

test('регистрация: consent=false трактуется как отсутствие согласия', async () => {
    const srv = await serve('/api/auth', authRouter());
    try {
        const res = await srv.request('/api/auth/register', {
            method: 'POST',
            body: { email: 'a@b.ru', password: 'password1', company: 'ООО Тест', role: 'customer', consent: false },
        });
        assert.equal(res.status, 400);
        assert.match(res.json.error, /соглас/i);
    } finally { await srv.close(); }
});

test('регистрация: успешная запись пишет consent_at и consent_version в users', async () => {
    const pool = fakePool([
        // Проверка «email уже занят» — до транзакции.
        { match: /FROM users WHERE LOWER\(email\)/i, rows: [] },
        // Проверка занятой компании (LIMIT 1) — до транзакции, компании ещё нет.
        { match: /FROM companies WHERE company = \$1 AND role = \$2 AND claimed = true LIMIT 1/i, rows: [] },
        // INSERT самого пользователя — то, что мы проверяем.
        {
            match: /INSERT INTO users/i,
            rows: (sql, params) => [{ id: 99, email: params[0], role: params[2], company: params[3] }],
        },
        // Повторная проверка компании внутри транзакции — говорим, что компания уже существует,
        // чтобы не пришлось описывать ветку «усыновления»/создания компании.
        { match: /FROM companies WHERE company = \$1 AND role = \$2 AND claimed = true/i, rows: [{ id: 1 }] },
        { match: /INSERT INTO refresh_tokens/i, rows: [] },
    ]);
    const deps = baseDeps({ pool, sendVerificationEmail: async () => {} });
    const srv = await serve('/api/auth', createAuthRouter(deps));
    try {
        const res = await srv.request('/api/auth/register', {
            method: 'POST',
            body: { email: 'a@b.ru', password: 'password1', company: 'ООО Тест', role: 'customer', consent: true },
        });
        assert.equal(res.status, 201);

        const insertUser = pool.calls.find(c => /INSERT INTO users/i.test(c.sql));
        assert.ok(insertUser, 'ожидался INSERT INTO users');
        assert.match(insertUser.sql, /consent_at/i);
        assert.match(insertUser.sql, /consent_version/i);
        assert.ok(
            insertUser.params.includes(DOC_VERSION),
            'DOC_VERSION должен быть среди параметров INSERT INTO users'
        );
    } finally { await srv.close(); }
});
