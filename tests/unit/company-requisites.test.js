'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createCompaniesRouter = require('../../routes/companies');
const { fakePool, fakeAuth, serve, baseDeps } = require('./helpers');

const OWNER = { id: 1, company: 'АО Завод', role: 'producer' };
const COMPANY_ROW = { id: 7, company: 'АО Завод', role: 'producer', city: 'Тюмень', equipment: '[]', iso_certificates: '[]', quality_certificates: '[]', capabilities: '[]', free_capacity: '[]' };

function makeDeps({ user, companyRow = COMPANY_ROW }) {
    const pool = fakePool([
        { match: /SELECT \* FROM companies WHERE id = \$1/i, rows: [companyRow] },
        { match: /UPDATE companies SET/i, rows: [] },
    ]);
    return { pool, deps: baseDeps({ pool, requireAuth: fakeAuth(user) }) };
}

test('PUT реквизитов: 403 для чужой компании', async () => {
    const { deps } = makeDeps({ user: { id: 2, company: 'ООО Чужие', role: 'producer' } });
    const srv = await serve('/api/companies', createCompaniesRouter(deps));
    try {
        const r = await srv.request('/api/companies/7', { method: 'PUT', body: { kpp: '720301001' } });
        assert.equal(r.status, 403);
    } finally { await srv.close(); }
});

test('PUT реквизитов: банк и КПП пишутся в свои колонки', async () => {
    const { deps, pool } = makeDeps({ user: OWNER });
    const srv = await serve('/api/companies', createCompaniesRouter(deps));
    try {
        const r = await srv.request('/api/companies/7', {
            method: 'PUT',
            body: {
                kpp: '720301001',
                legalAddress: '625000, г. Тюмень, ул. Республики, 42',
                bankName: 'ПАО Сбербанк',
                bankAccount: '40702810500000012345',
                bankBik: '047102651',
                bankCorr: '30101810800000000651',
            },
        });
        assert.equal(r.status, 200);
        const upd = pool.calls.find(c => /UPDATE companies SET/i.test(c.sql));
        assert.ok(upd, 'нет UPDATE');
        assert.match(upd.sql, /kpp = \$/);
        assert.match(upd.sql, /legal_address = \$/);
        assert.match(upd.sql, /bank_account = \$/);
        assert.match(upd.sql, /bank_bik = \$/);
        assert.match(upd.sql, /bank_corr = \$/);
        assert.ok(upd.params.includes('720301001'));
        assert.ok(upd.params.includes('40702810500000012345'));
    } finally { await srv.close(); }
});

test('PUT реквизитов: длинные значения обрезаются по лимитам колонок', async () => {
    const { deps, pool } = makeDeps({ user: OWNER });
    const srv = await serve('/api/companies', createCompaniesRouter(deps));
    try {
        const r = await srv.request('/api/companies/7', {
            method: 'PUT',
            body: { kpp: '1234567890123', bankAccount: '9'.repeat(40) },
        });
        assert.equal(r.status, 200);
        const upd = pool.calls.find(c => /UPDATE companies SET/i.test(c.sql));
        const kppIdx = upd.sql.match(/kpp = \$(\d+)/)[1];
        const accIdx = upd.sql.match(/bank_account = \$(\d+)/)[1];
        assert.equal(upd.params[kppIdx - 1].length, 9);
        assert.equal(upd.params[accIdx - 1].length, 20);
    } finally { await srv.close(); }
});

test('PUT: название компании и ИНН через этот endpoint не меняются', async () => {
    const { deps, pool } = makeDeps({ user: OWNER });
    const srv = await serve('/api/companies', createCompaniesRouter(deps));
    try {
        const r = await srv.request('/api/companies/7', {
            method: 'PUT',
            body: { company: 'ООО Подмена', inn: '0000000000', kpp: '720301001' },
        });
        assert.equal(r.status, 200);
        const upd = pool.calls.find(c => /UPDATE companies SET/i.test(c.sql));
        assert.ok(!/company = \$/.test(upd.sql), 'company не должен обновляться');
        assert.ok(!/\binn = \$/.test(upd.sql), 'inn не должен обновляться');
    } finally { await srv.close(); }
});
