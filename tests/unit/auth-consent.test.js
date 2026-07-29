'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createAuthRouter = require('../../routes/auth');
const { fakePool, serve, baseDeps } = require('./helpers');

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
    } finally { await srv.close(); }
});
