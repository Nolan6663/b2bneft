'use strict';
const { createRegistryInviter } = require('../lib/registry-invites.js');
const inv = createRegistryInviter({ pool: null, sendEmail: null, appUrl: 'https://x', jwtSecret: 'test-secret' });

const order = { title: 'Уплотнение РТИ DN150', category: 'РТИ и уплотнения', description: 'кольца резиновые' };
const checks = [
    ['матч по продукции', inv.matchScoreStub(order, { specialization: '', products: 'кольца резиновые; манжеты' }) >= 2],
    ['матч по специализации', inv.matchScoreStub(order, { specialization: 'РТИ и уплотнения', products: '' }) >= 2],
    ['нет матча', inv.matchScoreStub(order, { specialization: 'кабельная продукция', products: '' }) === 0],
    ['короткие слова игнорируются', inv.matchScoreStub({ title: 'и на по для', category: '', description: '' }, { specialization: 'и на по для', products: '' }) === 0],
    ['токен детерминирован', inv.optoutToken('7701234567') === inv.optoutToken('7701234567')],
    ['токен верифицируется', inv.verifyOptoutToken('7701234567', inv.optoutToken('7701234567')) === true],
    ['чужой токен не проходит', inv.verifyOptoutToken('7701234567', inv.optoutToken('9999999999')) === false],
    ['капс-предлоги не матчатся', inv.matchScoreStub({ title: 'КОЛЬЦА И МАНЖЕТЫ НА ЗАКАЗ', category: '', description: '' }, { specialization: 'ПРОИЗВОДСТВО ТРУБ НА ЭКСПОРТ И ПРОДАЖУ', products: '' }) === 0],
    ['акроним РТИ матчится', inv.matchScoreStub({ title: 'РТИ кольца', category: '', description: '' }, { specialization: 'РТИ разные', products: '' }) >= 1],
];
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? 'PASS' : 'FAIL') + ': ' + name); if (!pass) ok = false; }
process.exit(ok ? 0 : 1);
