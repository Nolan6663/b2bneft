'use strict';

const express = require('express');

function createIntegrationsRouter(deps) {
    const {
        pool,
        requireAuth,
        sapB1Login,
    } = deps;

    const router = express.Router();

    // ── CRUD ──────────────────────────────────────────────────────────────────
    
    router.get('/', requireAuth, async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                'SELECT provider, enabled, created_at, config FROM integrations WHERE company = $1',
                [req.user.company]
            );
            res.json(rows.map(r => ({
                provider: r.provider,
                enabled:  r.enabled,
                connectedAt: r.created_at,
                preview: previewConfig(r.provider, r.config),
            })));
        } catch (e) { next(e); }
    });
    
    function previewConfig(provider, config) {
        if (provider === 'bitrix24') {
            const url = config.webhookUrl || '';
            return url ? url.replace(/\/rest\/.*/, '/rest/…') : '';
        }
        if (provider === 'amocrm')  return config.subdomain  ? `${config.subdomain}.amocrm.ru` : '';
        if (provider === 'sap-b1')  return config.serverUrl  ? `${config.serverUrl} / ${config.companyDB}` : '';
        if (provider === 'sap-s4')  return config.host       ? config.host.replace(/^https?:\/\//, '') : '';
        return '';
    }
    
    router.post('/:provider', requireAuth, async (req, res, next) => {
        try {
            const { provider } = req.params;
            if (!['bitrix24', 'amocrm', 'sap-b1', 'sap-s4'].includes(provider))
                return res.status(400).json({ error: 'Неизвестный провайдер' });
    
            let config = {};
            if (provider === 'bitrix24') {
                const { webhookUrl } = req.body;
                if (!webhookUrl?.trim()) return res.status(400).json({ error: 'Укажите webhook URL' });
                try { new URL(webhookUrl.trim()); } catch { return res.status(400).json({ error: 'Неверный URL' }); }
                if (!webhookUrl.includes('/rest/')) return res.status(400).json({ error: 'URL должен содержать /rest/' });
                config = { webhookUrl: webhookUrl.trim() };
            }
            if (provider === 'amocrm') {
                const { subdomain, accessToken } = req.body;
                if (!subdomain?.trim() || !accessToken?.trim())
                    return res.status(400).json({ error: 'Укажите поддомен и токен доступа' });
                config = { subdomain: subdomain.trim().replace(/\.amocrm\.ru$/, ''), accessToken: accessToken.trim() };
            }
            if (provider === 'sap-b1') {
                const { serverUrl, companyDB, username, password, warehouseCode } = req.body;
                if (!serverUrl?.trim() || !companyDB?.trim() || !username?.trim() || !password?.trim())
                    return res.status(400).json({ error: 'Укажите URL сервера, базу данных, логин и пароль' });
                try { new URL(serverUrl.trim()); } catch { return res.status(400).json({ error: 'Неверный URL сервера' }); }
                config = { serverUrl: serverUrl.trim().replace(/\/$/, ''), companyDB: companyDB.trim(), username: username.trim(), password: password.trim(), warehouseCode: warehouseCode?.trim() || '01' };
            }
            if (provider === 'sap-s4') {
                const { host, username, password, companyCode, purchasingOrg, purchasingGroup, plant, defaultVendor } = req.body;
                if (!host?.trim() || !username?.trim() || !password?.trim())
                    return res.status(400).json({ error: 'Укажите хост, логин и пароль' });
                try { new URL(host.trim()); } catch { return res.status(400).json({ error: 'Неверный URL хоста' }); }
                config = {
                    host:           host.trim().replace(/\/$/, ''),
                    username:       username.trim(),
                    password:       password.trim(),
                    companyCode:    companyCode?.trim()    || '1000',
                    purchasingOrg:  purchasingOrg?.trim()  || '1000',
                    purchasingGroup:purchasingGroup?.trim() || '001',
                    plant:          plant?.trim()           || '1000',
                    defaultVendor:  defaultVendor?.trim()   || '',
                };
            }
    
            await pool.query(
                `INSERT INTO integrations (company, provider, config)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (company, provider) DO UPDATE SET config = $3, enabled = true, created_at = NOW()`,
                [req.user.company, provider, JSON.stringify(config)]
            );
            res.json({ ok: true, preview: previewConfig(provider, config) });
        } catch (e) { next(e); }
    });
    
    router.post('/:provider/test', requireAuth, async (req, res, next) => {
        try {
            const { provider } = req.params;
            const { rows: [row] } = await pool.query(
                'SELECT config FROM integrations WHERE company = $1 AND provider = $2',
                [req.user.company, provider]
            );
            if (!row) return res.status(404).json({ error: 'Интеграция не подключена' });
    
            if (provider === 'bitrix24') {
                const url = (row.config.webhookUrl || '').trim().replace(/\/?$/, '/');
                const r = await fetch(`${url}profile.json`);
                const data = await r.json();
                if (!r.ok || data.error) return res.status(400).json({ error: data.error_description || 'Ошибка соединения с Bitrix24' });
                return res.json({ ok: true, info: data.result?.NAME || 'Подключено' });
            }
            if (provider === 'amocrm') {
                const { subdomain, accessToken } = row.config;
                const r = await fetch(`https://${subdomain}.amocrm.ru/api/v4/account`, {
                    headers: { 'Authorization': `Bearer ${accessToken}` },
                });
                const data = await r.json().catch(() => ({}));
                if (!r.ok) return res.status(400).json({ error: data.detail || 'Ошибка соединения с AmoCRM' });
                return res.json({ ok: true, info: data.name || subdomain });
            }
            if (provider === 'sap-b1') {
                try {
                    const session = await sapB1Login(row.config);
                    const r = await fetch(`${row.config.serverUrl}/b1s/v1/CompanyService_GetAdminInfo`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Cookie': `B1SESSION=${session}` },
                        body: '{}',
                    });
                    const data = await r.json().catch(() => ({}));
                    return res.json({ ok: true, info: data.CompanyName || row.config.companyDB });
                } catch (e) {
                    return res.status(400).json({ error: e.message });
                }
            }
            if (provider === 'sap-s4') {
                const { host, username, password } = row.config;
                const auth = Buffer.from(`${username}:${password}`).toString('base64');
                const r = await fetch(`${host}/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/$metadata`, {
                    headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/xml' },
                });
                if (!r.ok) return res.status(400).json({ error: `HTTP ${r.status} — проверьте хост и учётные данные` });
                return res.json({ ok: true, info: host.replace(/^https?:\/\//, '') });
            }
            res.status(400).json({ error: 'Тест не поддерживается' });
        } catch (e) { next(e); }
    });
    
    router.delete('/:provider', requireAuth, async (req, res, next) => {
        try {
            await pool.query(
                'DELETE FROM integrations WHERE company = $1 AND provider = $2',
                [req.user.company, req.params.provider]
            );
            res.json({ ok: true });
        } catch (e) { next(e); }
    });
    

    return router;
}

module.exports = createIntegrationsRouter;
