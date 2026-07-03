# Contract + Specification PDF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Кнопка на странице сделки генерирует PDF «Договор поставки + Спецификация» из данных принятого КП; реквизиты сторон берутся из профиля компании (новые поля в settings).

**Architecture:** Серверная генерация через существующий `export-pdf.js` (pdfkit + JetBrains Mono + рамка/title-block). Новый endpoint в `routes/proposals.js`. Существующие ФЕЙКОВЫЕ формы реквизитов в `settings.html` подключаются к БД (сейчас их «Сохранить» = `showAlert()` без сохранения). Спека: `docs/superpowers/specs/2026-07-03-contract-pdf-design.md`.

**Tech Stack:** Node.js/Express, PostgreSQL (pg), pdfkit, vanilla JS фронт.

## Global Constraints

- Пустое поле реквизита → в PDF строка `___________________` (не пустота, не «null»).
- Endpoint доступен ТОЛЬКО участникам сделки; КП должно быть в статусе `Выигран`.
- `payment` ∈ `prepay100 | split5050 | postpay`; дефолт `split5050`.
- Номер договора: `ТЗ-<текущий год>-<proposalId>`.
- Кириллица в PDF — только шрифты `TZ`/`TZ-Bold` (Helvetica ломает кириллицу).
- Не трогать `drawTitleBlocks` — он уже чинит пустые страницы (`margins.bottom=0`).
- Никаких новых npm-зависимостей.
- Коммиты в feature-ветку `feature/contract-pdf`, не в main (push в main = автодеплой).

---

### Task 0: Ветка

- [ ] **Step 1: Создать ветку**

```bash
cd "C:/Users/Админ/source/repos"
git checkout -b feature/contract-pdf
```

---

### Task 1: БД + rowToCompany + PUT route

**Files:**
- Modify: `db.js` (блок ALTER TABLE, рядом со строкой 266 `invites_sent`)
- Modify: `server.js:158-187` (`rowToCompany`)
- Modify: `routes/companies.js:75-142` (PUT `/:id`)

**Interfaces:**
- Produces: колонки `companies.kpp, legal_address, bank_name, bank_account, bank_bik, bank_corr` (TEXT NOT NULL DEFAULT ''); API-поля `kpp, legalAddress, bankName, bankAccount, bankBik, bankCorr` в объекте компании (GET и PUT `/api/companies/:id`).

- [ ] **Step 1: Миграция в db.js**

После строки `ALTER TABLE companies ADD COLUMN IF NOT EXISTS invites_sent INTEGER NOT NULL DEFAULT 0;` добавить:

```sql
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS kpp TEXT NOT NULL DEFAULT '';
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS legal_address TEXT NOT NULL DEFAULT '';
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS bank_name TEXT NOT NULL DEFAULT '';
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS bank_account TEXT NOT NULL DEFAULT '';
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS bank_bik TEXT NOT NULL DEFAULT '';
        ALTER TABLE companies ADD COLUMN IF NOT EXISTS bank_corr TEXT NOT NULL DEFAULT '';
```

- [ ] **Step 2: rowToCompany в server.js**

В объект после `ogrn: r.ogrn || '', director: r.director || '',` добавить:

```js
        kpp: r.kpp || '',
        legalAddress: r.legal_address || '',
        bankName: r.bank_name || '',
        bankAccount: r.bank_account || '',
        bankBik: r.bank_bik || '',
        bankCorr: r.bank_corr || '',
```

- [ ] **Step 3: PUT в routes/companies.js**

В деструктуризацию `req.body` (строка 82-85) добавить `kpp, legalAddress, bankName, bankAccount, bankBik, bankCorr`. После строки `if (director !== undefined) f('director', str(director, 150));` добавить:

```js
            if (kpp !== undefined)         f('kpp', str(kpp, 9));
            if (legalAddress !== undefined) f('legal_address', str(legalAddress, 300));
            if (bankName !== undefined)     f('bank_name', str(bankName, 200));
            if (bankAccount !== undefined)  f('bank_account', str(bankAccount, 20));
            if (bankBik !== undefined)      f('bank_bik', str(bankBik, 9));
            if (bankCorr !== undefined)     f('bank_corr', str(bankCorr, 20));
```

- [ ] **Step 4: Проверка синтаксиса**

```bash
node -e "require('./db.js'); require('./routes/companies.js'); console.log('OK')"
```
Expected: `OK` (без подключения к БД db.js только экспортирует — если он коннектится при require, вместо этого `node --check db.js && node --check routes/companies.js && node --check server.js`).

- [ ] **Step 5: Commit**

```bash
git add db.js server.js routes/companies.js
git commit -m "feat: company requisites columns for contract generation"
```

---

### Task 2: Оживить формы реквизитов в settings.html

**Files:**
- Modify: `settings.html` (карточки «Реквизиты компании» ~строка 118, «Адреса» ~167, «Банковские реквизиты» ~207; скрипт `saveCompanyDetails` ~842)

**Interfaces:**
- Consumes: PUT `/api/companies/:id` c полями из Task 1; `_companyId` уже вычисляется в `loadCapacity()` (строка 1644-1656).

- [ ] **Step 1: Убрать фейковые поля**

Из карточки «Реквизиты компании» удалить form-group ОКПО (`companyOkpo`), «Дата регистрации» (`companyRegDate`), ОКВЭД (`companyOkved`) — для них нет колонок, сохранять некуда, показывать нечестно. Из карточки «Адреса» удалить «Фактический адрес» (`addrActual`), «Регион» (`addrRegion`), «Почтовый индекс» (`addrPostal`) — остаётся только «Юридический адрес» (`addrLegal`).

- [ ] **Step 2: Поля naming/inn — read-only**

`companyFullName` и `companyInn` получают атрибут `readonly` и `style="opacity:.65;cursor:not-allowed;"` + подпись в label «(из профиля)». Название компании — ключ связей в БД, ИНН — ключ claim; менять из этой формы нельзя.

- [ ] **Step 3: Кнопки сохранения**

- «Реквизиты компании»: `onclick="saveRequisites('companyAlert')"` (было `saveCompanyDetails()`)
- «Адреса»: `onclick="saveRequisites('addrAlert')"` (было `showAlert('addrAlert')`)
- «Банковские реквизиты»: `onclick="saveRequisites('bankAlert')"` (было `showAlert('bankAlert')`)

- [ ] **Step 4: JS — загрузка и сохранение**

Заменить тело `saveCompanyDetails()` и добавить загрузку. `myCompany` и `apiFetch` уже есть в файле; `_companyId` уже определён (строка 1644).

```js
        async function loadRequisites() {
            try {
                const r = await apiFetch(`${SERVER_URL}/companies`);
                if (!r.ok) return;
                const mine = (await r.json()).find(c => c.company === myCompany);
                if (!mine) return;
                _companyId = mine.id;
                const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
                set('companyFullName', mine.company);
                set('companyInn', mine.inn);
                set('companyOgrn', mine.ogrn);
                set('companyKpp', mine.kpp);
                set('addrLegal', mine.legalAddress);
                set('bankName', mine.bankName);
                set('bankBik', mine.bankBik);
                set('bankKs', mine.bankCorr);
                set('bankRs', mine.bankAccount);
            } catch { /* тихо */ }
        }

        async function saveRequisites(alertId) {
            if (!_companyId) { showToast('Профиль компании не загружен', 'error'); return; }
            const val = id => (document.getElementById(id) || {}).value || '';
            const digits = (id, len, name) => {
                const v = val(id).trim();
                if (v && !new RegExp(`^\\d{${len}}$`).test(v)) showToast(`${name}: обычно ${len} цифр — проверьте`, 'warn');
                return v;
            };
            const body = {
                ogrn: val('companyOgrn').trim(),
                kpp: digits('companyKpp', 9, 'КПП'),
                legalAddress: val('addrLegal').trim(),
                bankName: val('bankName').trim(),
                bankBik: digits('bankBik', 9, 'БИК'),
                bankCorr: digits('bankKs', 20, 'Корр. счёт'),
                bankAccount: digits('bankRs', 20, 'Расчётный счёт'),
            };
            try {
                const r = await apiFetch(`${SERVER_URL}/companies/${_companyId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (r.ok) showAlert(alertId);
                else showToast((await r.json()).error || 'Ошибка сохранения', 'error');
            } catch { showToast('Ошибка сети', 'error'); }
        }
```

Удалить старую `saveCompanyDetails()`. Вызвать `loadRequisites()` там же, где при инициализации зовётся `loadCapacity()` (найти вызов `loadCapacity()` и добавить рядом `loadRequisites();`). ВАЖНО: `loadRequisites` не должен затирать `_companyId`-логику `loadCapacity` — обе присваивают одно и то же значение, конфликтов нет.

- [ ] **Step 5: Ручная проверка**

Локально: `node server.js`, открыть settings.html, заполнить КПП/адрес/банк, сохранить, перезагрузить страницу — значения на месте.

- [ ] **Step 6: Commit**

```bash
git add settings.html
git commit -m "feat: wire requisites forms in settings to real API (was fake UI)"
```

---

### Task 3: buildContractPdf в export-pdf.js + smoke

**Files:**
- Modify: `export-pdf.js` (новые функции перед `module.exports`, экспорт)
- Modify: `scripts/pdf-smoke.js` (второй прогон для договора)

**Interfaces:**
- Produces: `buildContractPdf(data, res)` где `data = { proposalId, payment, order: {title, category, quantity, description, drawing}, proposal: {price, days}, customer: <companyRow-объект из rowToCompany>, supplier: <same> }`. `res` — Express response (или write stream в smoke).

- [ ] **Step 1: Сумма прописью (рубли)**

Добавить в export-pdf.js:

```js
const NUM_UNITS = [
  ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
   'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать',
   'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'],
  ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
   'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать',
   'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'],
];
const NUM_TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const NUM_HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
const NUM_SCALES = [null, ['тысяча', 'тысячи', 'тысяч', 1], ['миллион', 'миллиона', 'миллионов', 0], ['миллиард', 'миллиарда', 'миллиардов', 0]];

function pluralRu(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function tripletToWords(n, gender) {
  const words = [];
  if (NUM_HUNDREDS[Math.floor(n / 100)]) words.push(NUM_HUNDREDS[Math.floor(n / 100)]);
  const rest = n % 100;
  if (rest < 20) { if (NUM_UNITS[gender][rest]) words.push(NUM_UNITS[gender][rest]); }
  else {
    words.push(NUM_TENS[Math.floor(rest / 10)]);
    if (NUM_UNITS[gender][rest % 10]) words.push(NUM_UNITS[gender][rest % 10]);
  }
  return words;
}

function rublesInWords(amount) {
  const rub = Math.floor(Math.abs(Number(amount) || 0));
  const kop = Math.round((Math.abs(Number(amount) || 0) - rub) * 100);
  if (rub === 0) return `ноль рублей ${String(kop).padStart(2, '0')} копеек`;
  const groups = [];
  let n = rub;
  while (n > 0) { groups.push(n % 1000); n = Math.floor(n / 1000); }
  const words = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g === 0) continue;
    const gender = NUM_SCALES[i] ? NUM_SCALES[i][3] : 0;
    words.push(...tripletToWords(g, gender));
    if (NUM_SCALES[i]) words.push(pluralRu(g, NUM_SCALES[i][0], NUM_SCALES[i][1], NUM_SCALES[i][2]));
  }
  const rubWord = pluralRu(rub, 'рубль', 'рубля', 'рублей');
  return `${words.join(' ')} ${rubWord} ${String(kop).padStart(2, '0')} ${pluralRu(kop, 'копейка', 'копейки', 'копеек')}`;
}
```

- [ ] **Step 2: buildContractPdf**

```js
const DASH = '___________________';

const PAYMENT_CLAUSES = {
  prepay100: '2.3. Покупатель производит предоплату в размере 100% Цены договора в течение 5 (пяти) банковских дней с даты подписания настоящего Договора.',
  split5050: '2.3. Покупатель производит авансовый платёж в размере 50% Цены договора в течение 5 (пяти) банковских дней с даты подписания настоящего Договора. Оставшиеся 50% Покупатель оплачивает в течение 5 (пяти) банковских дней с даты приёмки Продукции.',
  postpay: '2.3. Покупатель оплачивает 100% Цены договора в течение 10 (десяти) банковских дней с даты приёмки Продукции.',
};

const DELIVERY_START = {
  prepay100: 'с даты поступления предоплаты',
  split5050: 'с даты поступления авансового платежа',
  postpay: 'с даты подписания настоящего Договора',
};

function req(v) { return (v && String(v).trim()) ? String(v).trim() : DASH; }

function partyBlock(c, label) {
  return [
    [label, req(c && c.company)],
    ['ИНН', req(c && c.inn)], ['КПП', req(c && c.kpp)], ['ОГРН', req(c && c.ogrn)],
    ['Юр. адрес', req(c && c.legalAddress)],
    ['Банк', req(c && c.bankName)],
    ['Р/с', req(c && c.bankAccount)], ['К/с', req(c && c.bankCorr)], ['БИК', req(c && c.bankBik)],
    ['Руководитель', req(c && c.director)],
  ];
}

function buildContractPdf(data, res) {
  const { proposalId, payment, order, proposal, customer, supplier } = data;
  const year = new Date().getFullYear();
  const docNo = `ТЗ-${year}-${proposalId}`;
  const price = Number(proposal.price) || 0;
  const clause = PAYMENT_CLAUSES[payment] || PAYMENT_CLAUSES.split5050;
  const delStart = DELIVERY_START[payment] || DELIVERY_START.split5050;
  const L = 40, W_TEXT = 515; // margin и ширина текста A4

  pipePdf(res, `dogovor-${docNo}.pdf`, (doc) => {
    const h = (t) => doc.moveDown(0.8).font('TZ-Bold').fontSize(10).fillColor(TZ_INK).text(t, L, undefined, { width: W_TEXT }).moveDown(0.3);
    const p = (t) => doc.font('TZ').fontSize(8.5).fillColor(TZ_INK).text(t, L, undefined, { width: W_TEXT, align: 'justify', lineGap: 1.5 });

    // Шапка
    doc.font('TZ-Bold').fontSize(13).fillColor(TZ_INK)
      .text(`ДОГОВОР ПОСТАВКИ № ${docNo}`, L, 50, { width: W_TEXT, align: 'center' });
    doc.moveDown(0.5).font('TZ').fontSize(8.5)
      .text(`${req(customer && customer.city) === DASH ? 'г. ' + DASH : 'г. ' + customer.city}`, L, undefined, { width: W_TEXT / 2, continued: false });
    doc.text(fmtDate(new Date()), L + W_TEXT / 2, doc.y - doc.currentLineHeight(), { width: W_TEXT / 2, align: 'right' });
    doc.moveDown(0.8);
    p(`${req(customer && customer.company)}, именуемое в дальнейшем «Покупатель», в лице руководителя ${req(customer && customer.director)}, действующего на основании Устава, с одной стороны, и ${req(supplier && supplier.company)}, именуемое в дальнейшем «Поставщик», в лице руководителя ${req(supplier && supplier.director)}, действующего на основании Устава, с другой стороны, совместно именуемые «Стороны», заключили настоящий Договор о нижеследующем:`);

    h('1. ПРЕДМЕТ ДОГОВОРА');
    p('1.1. Поставщик обязуется изготовить и поставить, а Покупатель — принять и оплатить продукцию (далее — «Продукция»), наименование, количество, цена и сроки поставки которой определены в Спецификации (Приложение № 1), являющейся неотъемлемой частью настоящего Договора.');
    p('1.2. Продукция изготавливается в соответствии с технической документацией (чертежами, техническим заданием), переданной Покупателем через платформу ТехЗаказ (texzakaz.ru).');

    h('2. ЦЕНА ДОГОВОРА И ПОРЯДОК ОПЛАТЫ');
    p(`2.1. Цена Договора составляет ${fmtNum(price)} руб. (${rublesInWords(price)}), НДС — в соответствии с применяемой Поставщиком системой налогообложения.`);
    p('2.2. Оплата производится безналичным перечислением на расчётный счёт Поставщика, указанный в разделе 8 настоящего Договора.');
    p(clause);

    h('3. СРОКИ И УСЛОВИЯ ПОСТАВКИ');
    p(`3.1. Срок изготовления и поставки Продукции — ${proposal.days || DASH} календарных дней ${delStart}.`);
    p('3.2. Условия доставки, грузополучатель и адрес поставки согласуются Сторонами в Спецификации либо дополнительно в письменной форме (в том числе в чате сделки на платформе ТехЗаказ).');

    h('4. КАЧЕСТВО И ПРИЁМКА');
    p('4.1. Качество Продукции должно соответствовать Спецификации, чертежам и техническому заданию Покупателя, а также применимым ГОСТ/ТУ, указанным в Спецификации.');
    p('4.2. Приёмка Продукции по количеству и качеству производится Покупателем в течение 10 (десяти) рабочих дней с даты получения. О выявленных недостатках Покупатель уведомляет Поставщика письменно в указанный срок.');
    p('4.3. При обнаружении недостатков Поставщик обязан за свой счёт устранить их либо заменить Продукцию в согласованный Сторонами срок.');

    h('5. ОТВЕТСТВЕННОСТЬ СТОРОН');
    p('5.1. За нарушение сроков поставки Покупатель вправе требовать уплаты неустойки в размере 0,1% от стоимости непоставленной в срок Продукции за каждый день просрочки, но не более 10% от Цены Договора.');
    p('5.2. За нарушение сроков оплаты Поставщик вправе требовать уплаты неустойки в размере 0,1% от неоплаченной суммы за каждый день просрочки, но не более 10% от Цены Договора.');
    p('5.3. Во всём ином Стороны несут ответственность в соответствии с законодательством Российской Федерации.');

    h('6. РАЗРЕШЕНИЕ СПОРОВ');
    p('6.1. Споры разрешаются путём переговоров. Претензионный порядок обязателен: срок ответа на претензию — 30 (тридцать) календарных дней с даты получения.');
    p('6.2. При недостижении согласия спор передаётся в арбитражный суд по месту нахождения истца.');

    h('7. ПРОЧИЕ УСЛОВИЯ');
    p('7.1. Договор вступает в силу с даты подписания обеими Сторонами и действует до полного исполнения обязательств.');
    p('7.2. Договор составлен в двух экземплярах, имеющих равную юридическую силу, по одному для каждой из Сторон. Стороны признают юридическую силу документов, переданных по электронной почте (сканированных копий), до момента обмена оригиналами.');
    p('7.3. Настоящий Договор сформирован на основании данных сделки платформы ТехЗаказ (texzakaz.ru).');

    h('8. РЕКВИЗИТЫ И ПОДПИСИ СТОРОН');
    const colW = W_TEXT / 2 - 10;
    const startY = doc.y;
    const drawParty = (rows, x) => {
      let y = startY;
      rows.forEach(([k, v]) => {
        doc.font('TZ-Bold').fontSize(7.5).fillColor(TZ_GRAPHITE).text(k + ':', x, y, { width: 90, lineBreak: false });
        doc.font('TZ').fontSize(7.5).fillColor(TZ_INK).text(v, x + 92, y, { width: colW - 92 });
        y = Math.max(y + 11, doc.y + 2);
      });
      doc.font('TZ').fontSize(8).text('Подпись: ______________ М.П.', x, y + 14, { width: colW });
      return y + 30;
    };
    const yLeft = drawParty(partyBlock(customer, 'ПОКУПАТЕЛЬ'), L);
    const yRight = drawParty(partyBlock(supplier, 'ПОСТАВЩИК'), L + colW + 20);
    doc.y = Math.max(yLeft, yRight);

    // ── Приложение № 1: Спецификация ──
    doc.addPage();
    doc.font('TZ-Bold').fontSize(11).fillColor(TZ_INK)
      .text(`ПРИЛОЖЕНИЕ № 1 к Договору поставки № ${docNo} от ${fmtDate(new Date())}`, L, 50, { width: W_TEXT, align: 'center' });
    doc.moveDown(0.3).fontSize(12).text('СПЕЦИФИКАЦИЯ', L, undefined, { width: W_TEXT, align: 'center' });
    doc.moveDown(1);

    const qty = Number(order.quantity) || 0;
    const unitPrice = qty > 0 ? price / qty : null;
    const rows = [
      ['Наименование', plainText(order.title)],
      ['Категория', order.category || '—'],
      ['Количество', qty > 0 ? `${fmtNum(qty)} шт` : '—'],
      ['Цена за единицу', unitPrice != null ? `${fmtNum(Math.round(unitPrice * 100) / 100)} руб.` : '—'],
      ['Сумма', `${fmtNum(price)} руб. (${rublesInWords(price)})`],
      ['Срок поставки', `${proposal.days || DASH} календарных дней ${delStart}`],
      ['Чертёж / ТЗ', order.drawing ? drawingName(order.drawing) : '—'],
    ];
    let ty = doc.y;
    rows.forEach(([k, v]) => {
      doc.rect(L, ty, 150, 22).lineWidth(0.6).strokeColor(TZ_INK).stroke();
      doc.rect(L + 150, ty, W_TEXT - 150, 22).stroke();
      doc.font('TZ-Bold').fontSize(8).fillColor(TZ_INK).text(k, L + 6, ty + 7, { width: 138, lineBreak: false });
      doc.font('TZ').fontSize(8).text(String(v).slice(0, 120), L + 156, ty + 7, { width: W_TEXT - 162, lineBreak: false });
      ty += 22;
    });
    doc.y = ty + 10;

    if (order.description) {
      doc.font('TZ-Bold').fontSize(9).text('Техническое задание / описание:', L, undefined, { width: W_TEXT });
      doc.moveDown(0.3).font('TZ').fontSize(8).fillColor(TZ_INK)
        .text(plainText(order.description).slice(0, 2500), L, undefined, { width: W_TEXT, align: 'justify', lineGap: 1.5 });
    }

    doc.moveDown(2);
    const sigY = doc.y;
    doc.font('TZ-Bold').fontSize(8).text('ПОКУПАТЕЛЬ:', L, sigY, { width: colW });
    doc.font('TZ').fontSize(8).text(`${req(customer && customer.company)}\n\nПодпись: ______________ М.П.`, L, sigY + 12, { width: colW });
    doc.font('TZ-Bold').fontSize(8).text('ПОСТАВЩИК:', L + colW + 20, sigY, { width: colW });
    doc.font('TZ').fontSize(8).text(`${req(supplier && supplier.company)}\n\nПодпись: ______________ М.П.`, L + colW + 20, sigY + 12, { width: colW });
  }, { docNo });
}

function plainText(s) { return String(s || '').replace(/<[^>]*>/g, '').trim(); }
function drawingName(drawing) {
  try { const d = typeof drawing === 'string' ? JSON.parse(drawing) : drawing; return d.originalName || d.storedName || '—'; }
  catch { return typeof drawing === 'string' ? drawing.slice(0, 80) : '—'; }
}
```

Экспорт дополнить:

```js
module.exports = { buildOrdersPdf, buildProposalsPdf, buildCompareKpPdf, buildContractPdf, rublesInWords };
```

- [ ] **Step 3: Smoke-тест (сначала падает)**

Дописать в `scripts/pdf-smoke.js` после существующего прогона (перестроить: обернуть прогоны в функцию, выйти по итогам двух). Итоговый файл:

```js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildOrdersPdf, buildContractPdf, rublesInWords } = require('../export-pdf.js');

function fakeRes(outPath) {
  const out = fs.createWriteStream(outPath);
  out.setHeader = () => {};
  out.status = () => out;
  return out;
}

function checkPdf(outPath, minPages, minSize) {
  const buf = fs.readFileSync(outPath);
  const hasFont = buf.includes('FontFile2');
  const m = buf.toString('latin1').match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/);
  const pages = m ? Number(m[1]) : -1;
  console.log(outPath, buf.length, 'bytes; font:', hasFont, '; pages:', pages);
  return hasFont && pages >= minPages && buf.length > minSize;
}

// проверка суммы прописью
const w = rublesInWords(1234567.5);
console.log('words:', w);
const wordsOk = w === 'один миллион двести тридцать четыре тысячи пятьсот шестьдесят семь рублей 50 копеек';

const p1 = path.join(os.tmpdir(), 'tz-pdf-smoke.pdf');
const r1 = fakeRes(p1);
buildOrdersPdf([{ id: 1, title: 'Тест: Уплотнение РТИ DN150 ГОСТ 9833-73', category: 'РТИ и уплотнения', status: 'Открыта', deadline: '2026-07-10', proposals: 2, created_at: new Date().toISOString() }], r1);

r1.on('finish', () => {
  const ok1 = checkPdf(p1, 1, 5000);

  const company = (over) => Object.assign({
    company: 'ООО «Тест»', inn: '7203000000', kpp: '720301001', ogrn: '1027200000000',
    legalAddress: '625000, г. Тюмень, ул. Республики, 42', director: 'Иванов И.И.', city: 'Тюмень',
    bankName: 'ПАО Сбербанк', bankAccount: '40702810500000012345', bankBik: '047102651', bankCorr: '30101810800000000651',
  }, over || {});

  const runContract = (name, data, cb) => {
    const p = path.join(os.tmpdir(), name);
    const r = fakeRes(p);
    buildContractPdf(data, r);
    r.on('finish', () => cb(checkPdf(p, 2, 8000)));
  };

  runContract('tz-contract-full.pdf', {
    proposalId: 42, payment: 'split5050',
    order: { title: 'Манжеты 2-100х125 ГОСТ 8752-79', category: 'РТИ и уплотнения', quantity: 200, description: 'Резина НБР, твёрдость 75 ShA, поставка партиями', drawing: JSON.stringify({ originalName: 'manzheta.pdf' }) },
    proposal: { price: 1234567.5, days: 14 },
    customer: company(), supplier: company({ company: 'АО «Завод РТИ»' }),
  }, (ok2) => {
    runContract('tz-contract-empty.pdf', {
      proposalId: 43, payment: 'nonsense',
      order: { title: 'Тест без данных', category: '', quantity: 0, description: '', drawing: null },
      proposal: { price: 0, days: null },
      customer: null, supplier: { company: 'ООО «Пусто»' },
    }, (ok3) => {
      console.log('orders:', ok1, '| contract full:', ok2, '| contract empty:', ok3, '| words:', wordsOk);
      process.exit(ok1 && ok2 && ok3 && wordsOk ? 0 : 1);
    });
  });
});
```

- [ ] **Step 4: Запустить — убедиться, что падает без реализации, затем проходит с ней**

```bash
node scripts/pdf-smoke.js
```
Expected до реализации: exit 1 / TypeError (buildContractPdf is not a function). После: `orders: true | contract full: true | contract empty: true | words: true`, exit 0.

- [ ] **Step 5: Открыть tz-contract-full.pdf глазами** — кириллица читаемая, рамка есть, 2+ страницы, прочерков нет; в tz-contract-empty.pdf прочерки на месте реквизитов.

- [ ] **Step 6: Commit**

```bash
git add export-pdf.js scripts/pdf-smoke.js
git commit -m "feat: contract+specification PDF builder with rubles-in-words"
```

---

### Task 4: Endpoint GET /api/proposals/:proposalId/contract.pdf

**Files:**
- Modify: `routes/proposals.js` (новый route после `/:proposalId/file`, строка ~55)

**Interfaces:**
- Consumes: `buildContractPdf` из Task 3; `canAccessProposal` из deps (уже в списке deps? НЕТ — есть в `routesDeps` server.js:1185, в деструктуризации routes/proposals.js:15 УЖЕ есть `canAccessProposal`). `rowToCompany` тоже уже в deps (строка 18).
- Produces: `GET /api/proposals/:proposalId/contract.pdf?payment=prepay100|split5050|postpay` → PDF attachment; 404 нет КП; 403 не участник; 400 КП не в статусе «Выигран».

- [ ] **Step 1: Route**

В начало файла: `const { buildContractPdf } = require('../export-pdf');`
После route `/:proposalId/file` добавить:

```js
    router.get('/:proposalId/contract.pdf', requireAuth, async (req, res, next) => {
        try {
            const proposalId = Number(req.params.proposalId);
            const { rows: [row] } = await pool.query(`
                SELECT p.*, o.company AS order_company, o.title AS o_title, o.category AS o_category,
                       o.quantity AS o_quantity, o.description AS o_description, o.drawing AS o_drawing
                FROM proposals p
                JOIN orders o ON o.id = p.order_id
                WHERE p.id = $1
            `, [proposalId]);
            if (!row) return res.status(404).json({ error: 'Предложение не найдено' });
            if (!canAccessProposal(req.user, row)) return res.status(403).json({ error: 'Нет доступа к этой сделке' });
            if (row.status !== 'Выигран') return res.status(400).json({ error: 'Договор доступен только по принятому КП' });

            const payment = ['prepay100', 'split5050', 'postpay'].includes(req.query.payment)
                ? req.query.payment : 'split5050';

            const { rows: companies } = await pool.query(
                'SELECT * FROM companies WHERE company = ANY($1::text[])',
                [[row.order_company, row.company]]
            );
            const byName = new Map(companies.map(c => [c.company, rowToCompany(c)]));

            buildContractPdf({
                proposalId,
                payment,
                order: { title: row.o_title, category: row.o_category, quantity: row.o_quantity, description: row.o_description, drawing: row.o_drawing },
                proposal: { price: row.price, days: row.days },
                customer: byName.get(row.order_company) || { company: row.order_company },
                supplier: byName.get(row.company) || { company: row.company },
            }, res);
        } catch (e) { next(e); }
    });
```

Примечание: одна компания может иметь две строки в companies (customer-строка и producer-строка с одним именем) — маловероятно, но Map возьмёт последнюю; для реквизитов это некритично (обе строки редактируются одной формой settings).

- [ ] **Step 2: Синтаксис**

```bash
node --check routes/proposals.js
```
Expected: без вывода, exit 0.

- [ ] **Step 3: Ручной тест локально**

`node server.js`; залогиниться заказчиком тестовой сделки; открыть `http://localhost:3000/api/proposals/<id принятого КП>/contract.pdf` — скачивается PDF. Под другой компанией — 403. По непринятому КП — 400.

- [ ] **Step 4: Commit**

```bash
git add routes/proposals.js
git commit -m "feat: contract PDF endpoint for accepted proposals"
```

---

### Task 5: Кнопка + модалка оплаты в deals.html

**Files:**
- Modify: `deals.html` (панель: кнопка после блока `ddpExport1cBtn`, ~строка 214; JS в `openPanel()` рядом с exportBtn-логикой, ~строка 543; модалка перед `</body>`)

**Interfaces:**
- Consumes: endpoint из Task 4. Auth для window.open работает через cookie (тот же паттерн, что `ddpExport1cBtn` → `/export/1c/`).

- [ ] **Step 1: Кнопка в панели**

После div `ddpExport1cBtn` (закрывающего) добавить:

```html
                <div id="ddpContractBtn" style="display:none;margin-top:8px;">
                    <button class="btn-secondary" style="width:100%;" onclick="openContractModal()">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px;vertical-align:middle;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                        Договор + спецификация (PDF)
                    </button>
                </div>
```

- [ ] **Step 2: Показ кнопки в openPanel()**

Рядом с логикой exportBtn (после блока `// 1С export button`) добавить:

```js
            // Contract PDF button
            const contractBtn = document.getElementById('ddpContractBtn');
            if (contractBtn) {
                contractBtn.style.display = (pid && (d.status === 'inwork' || d.status === 'completed' || d.status === 'active')) ? '' : 'none';
            }
```

Примечание: на deals.html попадают только сделки с принятым КП (статусы active/inwork/completed после mapDealFromApi), поэтому показываем всегда при наличии pid.

- [ ] **Step 3: Модалка перед `</body>`**

Стиль тот же, что у `compareModal` (посмотреть его разметку в файле и переиспользовать классы):

```html
    <div id="contractModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1000;align-items:center;justify-content:center;">
        <div style="background:var(--card-bg,#fff);border:1px solid var(--inner-border,#e2e8f0);border-radius:12px;max-width:420px;width:92%;padding:24px;">
            <div style="font-weight:700;font-size:15px;margin-bottom:4px;">Договор + спецификация</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-bottom:14px;">Выберите порядок оплаты — он попадёт в раздел 2 договора. Документ формируется из данных сделки; реквизиты сторон — из настроек компаний.</div>
            <label style="display:block;font-size:13px;margin-bottom:8px;cursor:pointer;"><input type="radio" name="contractPayment" value="prepay100" style="margin-right:8px;">100% предоплата</label>
            <label style="display:block;font-size:13px;margin-bottom:8px;cursor:pointer;"><input type="radio" name="contractPayment" value="split5050" checked style="margin-right:8px;">50% аванс + 50% по приёмке</label>
            <label style="display:block;font-size:13px;margin-bottom:14px;cursor:pointer;"><input type="radio" name="contractPayment" value="postpay" style="margin-right:8px;">Постоплата после приёмки</label>
            <div id="contractReqWarn" style="display:none;font-size:12px;color:#f59e0b;margin-bottom:12px;">Реквизиты вашей компании не заполнены — в договоре будут прочерки. <a href="settings.html" style="color:inherit;text-decoration:underline;">Заполнить в настройках</a></div>
            <div style="display:flex;gap:10px;justify-content:flex-end;">
                <button class="btn-secondary" onclick="document.getElementById('contractModal').style.display='none'">Отмена</button>
                <button class="btn-primary" onclick="downloadContract()">Скачать PDF</button>
            </div>
        </div>
    </div>
```

- [ ] **Step 4: JS**

```js
        async function openContractModal() {
            if (!currentDeal) return;
            document.getElementById('contractModal').style.display = 'flex';
            // предупреждение про пустые реквизиты своей компании
            try {
                const r = await apiFetch(`${SERVER_URL}/companies`);
                if (r.ok) {
                    const mine = (await r.json()).find(c => c.company === myCompany);
                    const filled = mine && mine.kpp && mine.legalAddress && mine.bankAccount && mine.bankBik;
                    document.getElementById('contractReqWarn').style.display = filled ? 'none' : '';
                }
            } catch { /* тихо */ }
        }

        function downloadContract() {
            const pid = currentDeal && (currentDeal.proposalId || currentDeal.id);
            if (!pid) return;
            const payment = (document.querySelector('input[name="contractPayment"]:checked') || {}).value || 'split5050';
            window.open(`${SERVER_URL}/proposals/${pid}/contract.pdf?payment=${payment}`, '_blank');
            document.getElementById('contractModal').style.display = 'none';
        }
```

ПРОВЕРИТЬ: есть ли в deals.html переменная `myCompany` (в settings.html есть). Если нет — взять способ определения текущей компании, которым в deals.html пользуется остальной код (поискать `myCompany`/`currentUser`/`localStorage`), и использовать его; при отсутствии данных просто не показывать предупреждение.

- [ ] **Step 5: Ручной тест**

Локально: открыть deals.html под заказчиком с принятым КП → кнопка видна → модалка → «Скачать» → PDF открывается, вариант оплаты соответствует выбранному радио.

- [ ] **Step 6: readme.txt**

Добавить в readme.txt (раздел API/функционала — по образцу соседних записей): endpoint `GET /api/proposals/:id/contract.pdf?payment=...`, поля реквизитов companies, оживление форм settings.html (были fake). Убрать/обновить упоминание фейковых форм, если есть.

- [ ] **Step 7: Commit**

```bash
git add deals.html readme.txt
git commit -m "feat: contract PDF button with payment terms modal on deals page"
```

---

### Task 6: Финал

- [ ] **Step 1: Полный smoke**

```bash
node scripts/pdf-smoke.js && node --check server.js && node --check routes/proposals.js && node --check routes/companies.js
```
Expected: exit 0 везде.

- [ ] **Step 2: Пройти flow целиком локально** — реквизиты в settings → сохранить → перезагрузка → на месте → deals → договор → PDF с этими реквизитами.

- [ ] **Step 3: Показать пользователю** — юрист должен проверить текст договора ДО пуша в main (автодеплой). Merge в main только после отмашки пользователя.
