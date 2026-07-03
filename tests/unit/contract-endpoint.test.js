'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createProposalsRouter = require('../../routes/proposals');
const { fakePool, fakeAuth, serve, baseDeps } = require('./helpers');

function canAccessProposal(user, row) {
    if (!user || !row) return false;
    if (user.role === 'admin') return true;
    return row.company === user.company || row.order_company === user.company;
}

const WON_ROW = {
    id: 42, order_id: 7, company: 'АО Завод', status: 'Выигран',
    price: '150000', days: 14,
    order_company: 'ООО Заказчик', o_title: 'Манжеты ГОСТ 8752-79',
    o_category: 'РТИ', o_quantity: 200, o_description: 'НБР 75 ShA', o_drawing: null,
};

function makeDeps({ proposalRow, companies = [], user }) {
    const pool = fakePool([
        { match: /FROM proposals p\s+JOIN orders o/i, rows: proposalRow ? [proposalRow] : [] },
        { match: /FROM companies WHERE company = ANY/i, rows: companies },
    ]);
    return baseDeps({
        pool,
        requireAuth: fakeAuth(user),
        canAccessProposal,
        rowToCompany: (r) => r, // тестовые строки уже в форме API-объекта
    });
}

test('contract.pdf: 404 когда КП не существует', async () => {
    const deps = makeDeps({ proposalRow: null, user: { company: 'ООО Заказчик', role: 'customer' } });
    const srv = await serve('/api/proposals', createProposalsRouter(deps));
    try {
        const r = await srv.request('/api/proposals/42/contract.pdf');
        assert.equal(r.status, 404);
    } finally { await srv.close(); }
});

test('contract.pdf: 403 для компании, не участвующей в сделке', async () => {
    const deps = makeDeps({ proposalRow: WON_ROW, user: { company: 'ООО Чужие', role: 'customer' } });
    const srv = await serve('/api/proposals', createProposalsRouter(deps));
    try {
        const r = await srv.request('/api/proposals/42/contract.pdf');
        assert.equal(r.status, 403);
    } finally { await srv.close(); }
});

test('contract.pdf: 400 когда КП не в статусе «Выигран»', async () => {
    const deps = makeDeps({
        proposalRow: { ...WON_ROW, status: 'Ожидает ответа' },
        user: { company: 'ООО Заказчик', role: 'customer' },
    });
    const srv = await serve('/api/proposals', createProposalsRouter(deps));
    try {
        const r = await srv.request('/api/proposals/42/contract.pdf');
        assert.equal(r.status, 400);
    } finally { await srv.close(); }
});

test('contract.pdf: заказчик получает валидный PDF', async () => {
    const deps = makeDeps({
        proposalRow: WON_ROW,
        companies: [
            { company: 'ООО Заказчик', inn: '7203000001', director: 'Иванов', city: 'Тюмень' },
            { company: 'АО Завод', inn: '7203000002', director: 'Петров' },
        ],
        user: { company: 'ООО Заказчик', role: 'customer' },
    });
    const srv = await serve('/api/proposals', createProposalsRouter(deps));
    try {
        const r = await srv.request('/api/proposals/42/contract.pdf?payment=prepay100');
        assert.equal(r.status, 200);
        assert.equal(r.buf.subarray(0, 5).toString('latin1'), '%PDF-');
        assert.ok(r.buf.length > 8000, 'PDF подозрительно мал: ' + r.buf.length);
    } finally { await srv.close(); }
});

test('contract.pdf: поставщик сделки тоже имеет доступ', async () => {
    const deps = makeDeps({
        proposalRow: WON_ROW,
        user: { company: 'АО Завод', role: 'producer' },
    });
    const srv = await serve('/api/proposals', createProposalsRouter(deps));
    try {
        const r = await srv.request('/api/proposals/42/contract.pdf');
        assert.equal(r.status, 200);
        assert.equal(r.buf.subarray(0, 5).toString('latin1'), '%PDF-');
    } finally { await srv.close(); }
});
