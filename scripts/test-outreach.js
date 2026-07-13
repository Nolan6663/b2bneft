'use strict';
const { createOutreach, buildUserPrompt, fallbackLetter, shortCompanyName } = require('../lib/outreach.js');

const o = createOutreach({ pool: null, transport: null, appUrl: 'https://x', jwtSecret: 'test-secret', emailFrom: 'a@b', replyTo: '' });
const stub = { id: 1, company: 'Завод "РТИ-Прогресс"', inn: '7701234567', city: 'Пермь', specialization: 'РТИ', products: 'кольца, манжеты', contact_email: 'z@z.ru' };

const html = o.renderHtml(stub, { subject: 'т', paragraphs: ['Абзац про <script>alert(1)</script> завод', 'Второй'] });
const prompt = buildUserPrompt(stub);
const fb = fallbackLetter(stub);

const checks = [
    ['html-инъекция из абзацев экранируется', !html.includes('<script>') && html.includes('&lt;script&gt;')],
    ['есть ссылка отписки с токеном', /optout\?inn=7701234567&token=[0-9a-f]{32}/.test(html)],
    ['есть claim-ссылка с ИНН', html.includes('claim=7701234567')],
    ['есть utm-метка outreach', html.includes('utm_source=outreach')],
    ['оба абзаца в письме', html.includes('завод') && html.includes('Второй')],
    ['промпт содержит город и продукцию', prompt.includes('Пермь') && prompt.includes('манжеты')],
    ['промпт без пустых строк', !buildUserPrompt({ company: 'X' }).includes('\n\n')],
    ['фолбэк: тема не пустая и не длиннее 80', fb.subject.length > 0 && fb.subject.length <= 80],
    ['фолбэк: есть абзацы', Array.isArray(fb.paragraphs) && fb.paragraphs.length >= 2],
    ['имя: срезает АО и кавычки, капс -> нормальный', shortCompanyName('АКЦИОНЕРНОЕ ОБЩЕСТВО "АБС ЗЭИМ АВТОМАТИЗАЦИЯ"') === 'АБС ЗЭИМ Автоматизация'],
    ['имя: ООО срезается', shortCompanyName('ООО «Ромашка»') === 'Ромашка'],
    ['имя: ПАО капсом', shortCompanyName('ПАО АВТОВАЗ') === 'Автоваз'],
    ['имя: нормальное не трогаем', shortCompanyName('Завод РТИ-Прогресс') === 'Завод РТИ-Прогресс'],
    ['имя: пустое не падает', shortCompanyName('') === ''],
    ['фолбэк: длинное имя не режется посреди слова', fallbackLetter({ company: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ ОЧЕНЬ ДЛИННОЕ НАЗВАНИЕ ПРЕДПРИЯТИЯ ИМЕНИ ПЯТИЛЕТКИ' }).subject === 'Прямые заказы для вашего предприятия на ТехЗаказ'],
];
let ok = true;
for (const [name, pass] of checks) { console.log((pass ? 'PASS' : 'FAIL') + ': ' + name); if (!pass) ok = false; }
process.exit(ok ? 0 : 1);
