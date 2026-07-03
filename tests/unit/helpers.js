'use strict';

const express = require('express');

/**
 * Хелперы для юнит-тестов роутеров без БД.
 * Роутеры — фабрики createXRouter(deps): подсовываем фейковый pool и auth.
 */

// Фейковый pool: массив правил [{ match: RegExp, rows | fn(sql, params) => rows }].
// Первое совпавшее правило отвечает; несовпавший запрос — ошибка (тест должен описать все запросы).
function fakePool(rules) {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            for (const rule of rules) {
                if (rule.match.test(sql)) {
                    const rows = typeof rule.rows === 'function' ? rule.rows(sql, params) : rule.rows;
                    return { rows: rows || [] };
                }
            }
            throw new Error('fakePool: непредусмотренный запрос: ' + sql.slice(0, 120).replace(/\s+/g, ' '));
        },
    };
}

// Фейковый requireAuth: кладёт заданного пользователя в req.user.
function fakeAuth(user) {
    return (req, res, next) => { req.user = user; next(); };
}

// deps.requireRole — фабрика middleware, как в server.js
function fakeRequireRole() {
    return (role) => (req, res, next) => {
        if (req.user.role !== role && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Недостаточно прав' });
        }
        next();
    };
}

// Поднимает express-приложение с роутером на случайном порту.
// Возвращает { url, close, request } — request(path, opts) → { status, json, text, headers }.
async function serve(mountPath, router) {
    const app = express();
    app.use(express.json());
    app.use(mountPath, router);
    // единый обработчик ошибок как в server.js
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const url = `http://127.0.0.1:${server.address().port}`;

    async function request(path, opts = {}) {
        const res = await fetch(url + path, {
            method: opts.method || 'GET',
            headers: opts.body ? { 'Content-Type': 'application/json' } : {},
            body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
        const buf = Buffer.from(await res.arrayBuffer());
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* не JSON — ок */ }
        return { status: res.status, json, buf, headers: res.headers };
    }

    return { url, request, close: () => new Promise(r => server.close(r)) };
}

const noop = () => {};
const asyncNoop = async () => {};

const passthrough = (req, res, next) => next();

// Базовый набор deps-заглушек: всё, что роутеры зовут «в фоне» (почта, пуши, сокеты).
function baseDeps(overrides = {}) {
    return {
        requireAuth: fakeAuth({ id: 1, company: 'ООО Заказчик', role: 'customer', email: 'c@t.ru' }),
        requireRole: fakeRequireRole(),
        requireVerifiedEmail: passthrough,
        optionalAuth: passthrough,
        handleKPUpload: passthrough,
        handleDrawingUpload: passthrough,
        handlePhotoUpload: passthrough,
        persistUpload: async () => null,
        deleteDrawingFile: asyncNoop,
        storage: { isRemote: () => true, existsLocally: () => false, streamToResponse: asyncNoop, photoPublicUrl: (n) => '/photos/' + n },
        canAccessOrderDrawing: async () => true,
        canAccessOrderThread: async () => true,
        getOrderAccessRow: async () => null,
        rowToOrder: (r) => r,
        rowToProposal: (r) => r,
        rowToCompany: (r) => r,
        rowToMessage: (r) => r,
        rowToNotification: (r) => r,
        enrichCompany: async (c) => c,
        geocodeCity: async () => null,
        computeMatchScore: () => 0,
        computeMatchReasons: () => [],
        matchedProducers: async () => [],
        computePriceBenchmark: async () => null,
        notifyCompanyEmail: asyncNoop,
        registryInviter: { onNewOrder: asyncNoop },
        addNotification: asyncNoop,
        getCompanyEmail: async () => null,
        sendEmail: asyncNoop,
        getUserIdsByCompany: async () => [],
        sendPush: noop,
        sendTelegramNotification: noop,
        emitRealtime: noop,
        emitDashboardRefresh: noop,
        triggerIntegrations: asyncNoop,
        logOrderEvent: asyncNoop,
        plainTitle: (s) => String(s || ''),
        htmlEscape: (s) => String(s || ''),
        withTransaction: async (fn) => fn(overrides.pool),
        getIo: () => null,
        APP_URL: 'https://test.local',
        ...overrides,
    };
}

module.exports = { fakePool, fakeAuth, fakeRequireRole, serve, baseDeps };
