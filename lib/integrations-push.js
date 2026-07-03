'use strict';

/**
 * Push принятого КП во внешние CRM/ERP заказчика (Bitrix24, AmoCRM, SAP B1/S4).
 * Вынесено из server.js; triggerIntegrations зовётся из lib/proposal-accept и роутеров,
 * sapB1Login дополнительно нужен routes/integrations.js для теста подключения.
 */
function createIntegrationsPush({ pool }) {
    // ── Push helpers ──────────────────────────────────────────────────────────
    
    async function pushToBitrix24(config, proposal, order) {
        const url = (config.webhookUrl || '').trim().replace(/\/?$/, '/');
        if (!url) return;
        try {
            await fetch(`${url}crm.deal.add.json`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fields: {
                        TITLE:       order.title,
                        OPPORTUNITY: proposal.price || 0,
                        CURRENCY_ID: 'RUB',
                        STAGE_ID:    'WON',
                        COMMENTS:    `Поставщик: ${proposal.company}. Срок поставки: ${proposal.days} дн. Источник: ТЕХЗАКАЗ.`,
                        SOURCE_ID:   'OTHER',
                    },
                }),
            });
        } catch (e) {
            console.error('[bitrix24 push]', e.message);
        }
    }
    
    async function pushToAmoCRM(config, proposal, order) {
        const { subdomain, accessToken } = config;
        if (!subdomain || !accessToken) return;
        try {
            await fetch(`https://${subdomain}.amocrm.ru/api/v4/leads`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                },
                body: JSON.stringify([{
                    name:  order.title,
                    price: proposal.price || 0,
                    _embedded: {
                        tags: [{ name: 'ТЕХЗАКАЗ' }],
                    },
                    custom_fields_values: [{
                        field_code: 'COMMENTS',
                        values: [{ value: `Поставщик: ${proposal.company}. Срок: ${proposal.days} дн.` }],
                    }],
                }]),
            });
        } catch (e) {
            console.error('[amocrm push]', e.message);
        }
    }
    
    // ── SAP Business One (Service Layer) ──────────────────────────────────────
    
    async function sapB1Login(config) {
        const { serverUrl, companyDB, username, password } = config;
        const r = await fetch(`${serverUrl}/b1s/v1/Login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ CompanyDB: companyDB, UserName: username, Password: password }),
        });
        if (!r.ok) throw new Error(`SAP B1 login failed: ${r.status}`);
        const cookie = r.headers.get('set-cookie') || '';
        const sessionMatch = cookie.match(/B1SESSION=([^;]+)/);
        if (!sessionMatch) throw new Error('SAP B1: no session cookie');
        return sessionMatch[1];
    }
    
    async function pushToSapB1(config, proposal, order) {
        try {
            const session = await sapB1Login(config);
            const dateStr = new Date().toISOString().split('T')[0];
            await fetch(`${config.serverUrl}/b1s/v1/PurchaseOrders`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': `B1SESSION=${session}`,
                },
                body: JSON.stringify({
                    DocDate:   dateStr,
                    DocDueDate: dateStr,
                    Comments:  `ТЕХЗАКАЗ #${order.id}: ${order.title}. Поставщик: ${proposal.company}. Срок: ${proposal.days} дн.`,
                    DocumentLines: [{
                        ItemDescription: order.title,
                        Quantity:        order.quantity || 1,
                        UnitPrice:       proposal.price || 0,
                        Currency:        'RUB',
                        WarehouseCode:   config.warehouseCode || '01',
                    }],
                }),
            });
        } catch (e) {
            console.error('[sap-b1 push]', e.message);
        }
    }
    
    // ── SAP S/4HANA (OData v2) ────────────────────────────────────────────────
    
    async function pushToSapS4(config, proposal, order) {
        const { host, username, password, companyCode } = config;
        try {
            const auth = Buffer.from(`${username}:${password}`).toString('base64');
            const base = `${host}/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV`;
    
            // Fetch CSRF token
            const tokenRes = await fetch(`${base}/$metadata`, {
                headers: { 'Authorization': `Basic ${auth}`, 'x-csrf-token': 'fetch' },
            });
            const csrfToken = tokenRes.headers.get('x-csrf-token') || '';
            const cookies   = tokenRes.headers.get('set-cookie') || '';
    
            await fetch(`${base}/A_PurchaseOrder`, {
                method: 'POST',
                headers: {
                    'Authorization':   `Basic ${auth}`,
                    'Content-Type':    'application/json',
                    'Accept':          'application/json',
                    'x-csrf-token':    csrfToken,
                    'Cookie':          cookies,
                },
                body: JSON.stringify({
                    PurchaseOrderType:       'NB',
                    CompanyCode:             companyCode || '1000',
                    PurchasingOrganization:  config.purchasingOrg || '1000',
                    PurchasingGroup:         config.purchasingGroup || '001',
                    Supplier:                config.defaultVendor || '',
                    to_PurchaseOrderItem: { results: [{
                        PurchaseOrderItem:     '00010',
                        PurchaseOrderItemText: order.title.slice(0, 40),
                        Plant:                 config.plant || '1000',
                        OrderQuantity:         String(order.quantity || 1),
                        PurchaseOrderQuantityUnit: 'PC',
                        NetPriceAmount:        String(proposal.price || 0),
                        NetPriceCurrency:      'RUB',
                    }]},
                }),
            });
        } catch (e) {
            console.error('[sap-s4 push]', e.message);
        }
    }
    
    async function triggerIntegrations(customerCompany, proposal, order) {
        try {
            const { rows } = await pool.query(
                "SELECT * FROM integrations WHERE company = $1 AND enabled = true",
                [customerCompany]
            );
            await Promise.all(rows.map(row => {
                if (row.provider === 'bitrix24') return pushToBitrix24(row.config, proposal, order);
                if (row.provider === 'amocrm')   return pushToAmoCRM(row.config, proposal, order);
                if (row.provider === 'sap-b1')   return pushToSapB1(row.config, proposal, order);
                if (row.provider === 'sap-s4')   return pushToSapS4(row.config, proposal, order);
            }));
        } catch (e) {
            console.error('[integrations trigger]', e.message);
        }
    }
    
    // ── 1С CommerceML XML export ───────────────────────────────────────────────
    

    return { triggerIntegrations, sapB1Login };
}

module.exports = createIntegrationsPush;
