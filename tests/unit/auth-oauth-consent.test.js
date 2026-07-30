'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createAuthRouter = require('../../routes/auth');
const { fakePool, serve, baseDeps } = require('./helpers');
const { DOC_VERSION } = require('../../scripts/legal-data');

// Второй путь создания пользователя — колбэк Яндекс OAuth. Форма регистрации
// требует галочку согласия явно, здесь согласие даётся текстом на экране входа,
// но записать его в users нужно так же: иначе у части аккаунтов согласия нет вовсе.
function oauthDeps() {
    const pool = fakePool([
        { match: /SELECT \* FROM users WHERE LOWER\(email\)/i, rows: [] },
        { match: /INSERT INTO users/i, rows: (sql, params) => [{ id: 77, email: params[0], role: 'customer', company: params[2], email_verified: false }] },
        { match: /SELECT 1 FROM companies/i, rows: [] },
        { match: /INSERT INTO companies/i, rows: [] },
        { match: /INSERT INTO refresh_tokens/i, rows: [] },
    ]);
    // crypto роутер получает из deps (routes/auth.js:19) — в baseDeps его нет,
    // а OAuth-ветка генерирует им случайный пароль для беспарольного аккаунта.
    return baseDeps({ pool, crypto: require('crypto') });
}

function stubYandex() {
    const original = global.fetch;
    global.fetch = async (url, opts) => {
        if (String(url).includes('oauth.yandex.ru/token')) {
            return { json: async () => ({ access_token: 'test-token' }) };
        }
        if (String(url).includes('login.yandex.ru/info')) {
            return { json: async () => ({ default_email: 'oauth@example.com', real_name: 'ООО Тест ОАуth' }) };
        }
        // Всё прочее — это сам тест стучится к поднятому серверу, пропускаем.
        return original(url, opts);
    };
    return () => { global.fetch = original; };
}

test('OAuth: новый пользователь получает consent_at и версию документов', async () => {
    const prevId = process.env.YANDEX_CLIENT_ID;
    const prevSecret = process.env.YANDEX_CLIENT_SECRET;
    process.env.YANDEX_CLIENT_ID = 'test-id';
    process.env.YANDEX_CLIENT_SECRET = 'test-secret';
    const restoreFetch = stubYandex();

    const deps = oauthDeps();
    const srv = await serve('/api/auth', createAuthRouter(deps));
    try {
        // redirect: 'manual' — иначе клиент пойдёт по редиректу на /login.html,
        // которого в тестовом приложении нет, и мы увидим 404 вместо ответа роутера.
        const res = await fetch(`${srv.url}/api/auth/yandex/callback?code=test-code`, { redirect: 'manual' });
        assert.equal(res.status, 302, 'колбэк должен закончиться редиректом');
        const location = res.headers.get('location');
        assert.match(location, /oauth_ok=1/, 'вход не состоялся: ' + location);
        assert.match(location, /new=1/, 'новый пользователь должен помечаться флагом new');

        const insert = deps.pool.calls.find(c => /INSERT INTO users/i.test(c.sql));
        assert.ok(insert, 'пользователь не создавался');
        assert.match(insert.sql, /consent_at/i, 'в INSERT нет consent_at');
        assert.match(insert.sql, /consent_version/i, 'в INSERT нет consent_version');
        assert.ok(insert.params.includes(DOC_VERSION), `версия документов не попала в параметры: ${JSON.stringify(insert.params)}`);
    } finally {
        await srv.close();
        restoreFetch();
        if (prevId === undefined) delete process.env.YANDEX_CLIENT_ID; else process.env.YANDEX_CLIENT_ID = prevId;
        if (prevSecret === undefined) delete process.env.YANDEX_CLIENT_SECRET; else process.env.YANDEX_CLIENT_SECRET = prevSecret;
    }
});
