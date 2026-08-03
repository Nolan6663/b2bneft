# Подсказки в форме заявки и тур по кабинету — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Человек, впервые попавший в кабинет, понимает, что писать в каждом поле заявки и что будет после публикации, а интерфейс кабинета объясняет себя сам за пять шагов.

**Architecture:** Тексты подсказок — один модуль `assets/onboarding-hints.js`, обе формы (модалка кабинета и гостевой мастер) помечают поля атрибутом `data-hint` и вызывают `applyFieldHints`. Тур — самостоятельный модуль `assets/tour.js` с оверлеем, подсветкой по селектору и карточкой; маршруты описаны данными, движок ничего не знает про конкретные страницы.

**Tech Stack:** Ванильный JS без сборки (как весь фронт проекта), CSS в `assets/theme-v2.css` и новый `assets/tour.css`, тесты — Playwright (`tests/e2e`).

**Спека:** `docs/superpowers/specs/2026-08-03-onboarding-hints-tour-design.md`

## Global Constraints

- Никаких сборщиков и зависимостей: скрипты подключаются тегом `<script>`, стили — `<link>`.
- Комментарии и тексты интерфейса — по-русски, тон как в остальном проекте: объясняем последствие, а не описываем поле.
- Без «💡», эмодзи-иконок и жёлтых плашек: `.form-hint` — 12px, `var(--text-secondary)`.
- Тур не блокирует интерфейс и ничего не пишет в базу.
- Пропущенный якорь не роняет тур: шаг молча пропускается.
- Проверка вёрстки обязательно и на 390px — в этом проекте мобильная раскладка ломалась отдельно от десктопной.

---

### Task 1: Модуль подсказок

**Files:**
- Create: `assets/onboarding-hints.js`
- Modify: `assets/theme-v2.css` (стиль `.form-hint`)

**Interfaces:**
- Produces: `window.ORDER_FIELD_HINTS` — объект `{ name, category, quantity, deadline, city, description, drawing }` со строками; `window.ORDER_NEXT_STEPS` — массив из трёх строк; `window.applyFieldHints(root)` — вставляет подсказки в переданном поддереве, возвращает число вставленных.

- [ ] **Step 1: Написать модуль**

```js
'use strict';
/* Подсказки к полям заявки. Один источник на обе формы: модалку кабинета
   (index.html) и гостевой мастер (zayavka.html). Тексты объясняют
   последствие — что изменится для заказчика, если поле заполнить плохо. */
const ORDER_FIELD_HINTS = {
  name: 'По названию завод решает, открывать заявку или пролистать. Пишите как в заявке снабженца: изделие, тип, размер.',
  category: 'Определяет, каким заводам заявка попадёт в подборку.',
  quantity: 'Партия целиком. От объёма зависит цена и возьмётся ли завод.',
  deadline: 'Реальный срок поставки. Слишком близкий отсекает часть производств.',
  city: 'Регион поставки. Влияет на подбор: логистика часто решает больше, чем цена.',
  description: 'Материал, ГОСТ, допуски, покрытие, приёмка, условия поставки. Чем точнее, тем меньше уточняющих вопросов и точнее цена.',
  drawing: 'PDF, DWG или STEP. Без чертежа заводы считают по описанию и закладывают запас в цену.',
};

const ORDER_NEXT_STEPS = [
  'Заявка уйдёт заводам, подходящим по специализации и региону.',
  'Отклики придут в раздел «КП» — там цена, срок и файл от завода.',
  'Переписка с заводом идёт в чате внутри платформы.',
];

function applyFieldHints(root) {
  const scope = root || document;
  let inserted = 0;
  scope.querySelectorAll('[data-hint]').forEach((el) => {
    const text = ORDER_FIELD_HINTS[el.dataset.hint];
    if (!text) return;
    if (el.nextElementSibling && el.nextElementSibling.classList.contains('form-hint')) return;
    const hint = document.createElement('div');
    hint.className = 'form-hint';
    hint.textContent = text;
    el.insertAdjacentElement('afterend', hint);
    inserted += 1;
  });
  return inserted;
}

window.ORDER_FIELD_HINTS = ORDER_FIELD_HINTS;
window.ORDER_NEXT_STEPS = ORDER_NEXT_STEPS;
window.applyFieldHints = applyFieldHints;
```

- [ ] **Step 2: Стиль подсказки**

В `assets/theme-v2.css` рядом с другими стилями форм:

```css
.form-hint {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-secondary);
}
```

- [ ] **Step 3: Коммит**

```bash
git add assets/onboarding-hints.js assets/theme-v2.css
git commit -m "feat(onboarding): модуль подсказок к полям заявки"
```

---

### Task 2: Подсказки в модалке кабинета

**Files:**
- Modify: `index.html` (модалка `#orderModal`, строки ~307–370; подключение скрипта)

**Interfaces:**
- Consumes: `applyFieldHints`, `ORDER_NEXT_STEPS` из Task 1.

- [ ] **Step 1: Разметить поля**

Атрибуты на сами поля: `orderName` → `data-hint="name"`, `orderCategory` → `category`, `orderQuantity` → `quantity`, `orderDeadline` → `deadline`, `orderDescription` → `description`, `orderFile` → `drawing`.

- [ ] **Step 2: Блок «Что дальше»**

Перед `.modal-actions`:

```html
<div class="order-next-steps" id="orderNextSteps">
    <div class="order-next-title">Что будет после публикации</div>
    <ol id="orderNextList"></ol>
</div>
```

Стиль в `theme-v2.css`: рамка `1px solid var(--inner-border)`, скругление 8px, отступ 12px, текст 12px `var(--text-secondary)`, нумерация без акцентного цвета.

- [ ] **Step 3: Подключить и заполнить**

`<script src="assets/onboarding-hints.js"></script>` перед основным скриптом страницы. В инициализации:

```js
applyFieldHints(document.getElementById('orderModal'));
const nextList = document.getElementById('orderNextList');
if (nextList) nextList.innerHTML = ORDER_NEXT_STEPS.map(s => `<li>${escapeHtml(s)}</li>`).join('');
```

- [ ] **Step 4: Проверить глазами**

Открыть модалку на десктопе и на 390px: под каждым полем строка, блок «Что будет после публикации» перед кнопками, модалка не растёт за экран.

- [ ] **Step 5: Коммит**

```bash
git add index.html assets/theme-v2.css
git commit -m "feat(onboarding): подсказки и блок «что дальше» в форме закупки"
```

---

### Task 3: Подсказки в гостевом мастере

**Files:**
- Modify: `zayavka.html` (шаги 01–02, поля `title`, `category`, `quantity`, `deadline`, `city`, `description`, `drawingInput`)

**Interfaces:**
- Consumes: `applyFieldHints` из Task 1.

- [ ] **Step 1: Разметить поля**

`title` → `data-hint="name"`, `category` → `category`, `quantity` → `quantity`, `deadline` → `deadline`, `city` → `city`, `description` → `description`, `drawingInput` → `drawing`.

- [ ] **Step 2: Подключить модуль**

`<script src="assets/onboarding-hints.js"></script>` и вызов `applyFieldHints(document)` при загрузке — шаги мастера уже есть в разметке, просто скрыты `hidden`.

- [ ] **Step 3: Проверить**

Пройти мастер до шага 02 на 390px: подсказки видны, шаги не разъезжаются.

- [ ] **Step 4: Коммит**

```bash
git add zayavka.html
git commit -m "feat(onboarding): подсказки к полям в мастере заявки"
```

---

### Task 4: Движок тура

**Files:**
- Create: `assets/tour.js`, `assets/tour.css`

**Interfaces:**
- Produces: `window.startTour(steps, options)` — `steps` это массив `{ selectors: string[], title: string, text: string }`, `options` = `{ onFinish }`; `window.isTourAvailable(steps)` — есть ли хоть один видимый якорь.

- [ ] **Step 1: Написать движок**

Ключевые решения, которые нельзя потерять:

```js
/* Якорь ищем по списку селекторов: на телефоне боковое меню превращается в
   нижнюю панель, часть элементов скрыта — берём первый видимый. */
function findAnchor(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}
```

- Оверлей `.tour-overlay` на весь экран, подсветка — отдельный `.tour-spot`, позиционируется по `getBoundingClientRect()` якоря и рисует затемнение через `box-shadow: 0 0 0 9999px rgba(0,0,0,.55)`.
- Карточка `.tour-card`: заголовок, текст, «Шаг N из M», кнопки «Пропустить» и «Далее» («Готово» на последнем).
- Позиция карточки: под якорем, если снизу есть место, иначе над ним; при ширине ≤720px — фиксировано внизу экрана.
- Перед показом шага — `scrollIntoView({ block: 'center', behavior: 'smooth' })`, пересчёт позиции после прокрутки.
- Шаг без видимого якоря пропускается; если якорей нет ни у одного шага, тур не открывается вовсе.
- Закрытие: «Пропустить», `Escape`, клик по затемнению. В любом случае зовётся `onFinish`.
- Пересчёт позиций на `resize` и `scroll`.

- [ ] **Step 2: Стили**

`assets/tour.css`: `.tour-overlay` (`position:fixed; inset:0; z-index:900`), `.tour-spot` (`position:absolute; border-radius:10px; transition:.2s`), `.tour-card` (карточка на `var(--card-bg)`, рамка `var(--card-border)`, ширина `min(340px, calc(100vw - 32px))`, `z-index:901`), мобильная ветка `@media (max-width:720px)`.

- [ ] **Step 3: Проверить на пустышке**

Временный вызов `startTour([{selectors:['.sidebar'],title:'Тест',text:'Тест'}])` в консоли на `index.html`: подсветка попадает по месту, карточка не уезжает за экран на 390px.

- [ ] **Step 4: Коммит**

```bash
git add assets/tour.js assets/tour.css
git commit -m "feat(onboarding): движок тура — оверлей, подсветка, карточка"
```

---

### Task 5: Маршруты тура и запуск

**Files:**
- Modify: `assets/app.js` (рядом с `initOnboarding`, `_initObChecklist`), `index.html` и `producer.html` (подключение `tour.js`/`tour.css`, `id` кнопке создания закупки)

**Interfaces:**
- Consumes: `startTour`, `isTourAvailable` из Task 4.
- Produces: `window.startCabinetTour()` — запуск тура для текущей роли.

- [ ] **Step 1: Дать якорю кнопки стабильный id**

В `index.html:139` кнопке `＋ Создать закупку` добавить `id="createOrderBtn"` — селектор по `onclick` хрупкий.

- [ ] **Step 2: Описать маршруты**

```js
const TOUR_STEPS = {
  customer: [
    { selectors: ['#createOrderBtn'], title: 'Отсюда начинается заявка',
      text: 'Опишите, что нужно изготовить. ТЗ можно собрать по описанию или по чертежу — платформа предложит формулировки.' },
    { selectors: ['#orders-table-body', '#ordersMobileList'], title: 'Ваши закупки',
      text: 'Здесь видно статус каждой заявки и сколько заводов откликнулось.' },
    { selectors: ['.sidebar a[href="proposals.html"]'], title: 'Отклики заводов',
      text: 'Коммерческие предложения приходят сюда: цена, срок и файл от завода.' },
    { selectors: ['.sidebar a[href="messages.html"]'], title: 'Переписка',
      text: 'Уточнения по заявке идут в чате внутри платформы, а не по почте.' },
    { selectors: ['.sidebar a[href^="company-profile.html"]', '#myProfileLink'], title: 'Профиль компании',
      text: 'Заполненный профиль повышает доверие: заводы видят, с кем работают.' },
  ],
  producer: [
    { selectors: ['#ordersList'], title: 'Лента заявок',
      text: 'Сюда попадают закупки, подходящие вашему производству.' },
    { selectors: ['#categoryFilter'], title: 'Фильтр по специализации',
      text: 'Отсекает чужое: оставьте свои категории, чтобы не листать лишнее.' },
    { selectors: ['#tabProposalsBtn'], title: 'Ваши предложения',
      text: 'Отправленные КП и их статусы собраны здесь.' },
    { selectors: ['.sidebar a[href="messages.html"]'], title: 'Переписка',
      text: 'Заказчик задаёт вопросы по заявке в чате платформы.' },
    { selectors: ['#myProfileLink', '.sidebar a[href^="company-profile.html"]'], title: 'Профиль',
      text: 'Специализация и оборудование влияют на то, какие заявки вам покажут.' },
  ],
};
```

- [ ] **Step 3: Запуск**

```js
const _TOUR_DONE_KEY = 'ob_tour_done_v1';

function startCabinetTour() {
  const role = localStorage.getItem('userRole') || '';
  const steps = TOUR_STEPS[role];
  if (!steps || typeof window.startTour !== 'function') return;
  window.startTour(steps, { onFinish: () => localStorage.setItem(_TOUR_DONE_KEY, '1') });
}
```

Автозапуск — в `initOnboarding`, на главной странице роли, только если приветственное окно уже закрыто и `_TOUR_DONE_KEY` не стоит. Тур стартует с задержкой в один кадр после отрисовки списка, иначе якорь `#orders-table-body` пустой.

- [ ] **Step 4: Кнопка в чеклисте**

В разметку виджета «Начало работы», рядом с «Скрыть»:

```html
<button class="ob-cl-dismiss" onclick="startCabinetTour()">Как это работает</button>
```

- [ ] **Step 5: Подключить файлы**

`<link rel="stylesheet" href="assets/tour.css">` и `<script src="assets/tour.js"></script>` в `index.html` и `producer.html`.

- [ ] **Step 6: Проверить руками**

Сбросить `localStorage`, войти заказчиком: тур запускается после приветствия, пять шагов, «Пропустить» закрывает. Повторный вход — тура нет, кнопка в чеклисте запускает снова. То же под заводом на `producer.html`. Обязательно на 390px: на телефоне боковое меню внизу, шаги с ссылками должны находить якорь там.

- [ ] **Step 7: Коммит**

```bash
git add assets/app.js index.html producer.html
git commit -m "feat(onboarding): тур по кабинету для заказчика и завода"
```

---

### Task 6: Тесты

**Files:**
- Create: `tests/e2e/onboarding-tour.spec.js`, `tests/e2e/order-form-hints.spec.js`

- [ ] **Step 1: Тест подсказок**

```js
test('под каждым полем заявки есть подсказка', async ({ page }) => {
    await page.goto('/index.html');
    await page.click('#createOrderBtn');
    const fields = await page.$$('#orderModal [data-hint]');
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) {
        const hint = await f.evaluateHandle(el => el.nextElementSibling);
        const cls = await hint.evaluate(el => el && el.className);
        const text = await hint.evaluate(el => el && el.textContent.trim());
        expect(cls, 'после поля должна идти .form-hint').toContain('form-hint');
        expect(text.length).toBeGreaterThan(10);
    }
});
```

Второй тест: тексты в мастере `/zayavka` совпадают с `ORDER_FIELD_HINTS` — собрать пары `data-hint` → текст на обеих страницах и сравнить.

- [ ] **Step 2: Тест тура**

Проверки: тур открывается после первого входа; «Далее» двигает счётчик; «Пропустить» закрывает и ставит `ob_tour_done_v1`; после перезагрузки тур не появляется; кнопка «Как это работает» запускает снова; шаг с заведомо отсутствующим якорем пропускается, тур не падает.

- [ ] **Step 3: Прогнать**

```bash
E2E_BASE_URL=https://texzakaz.ru npx playwright test tests/e2e/order-form-hints.spec.js tests/e2e/onboarding-tour.spec.js
```

Против прода тесты красные до деплоя — это ожидаемо, зелёными они станут после выкатки.

- [ ] **Step 4: Коммит**

```bash
git add tests/e2e/order-form-hints.spec.js tests/e2e/onboarding-tour.spec.js
git commit -m "test(onboarding): подсказки в форме и тур по кабинету"
```

---

## Порядок

Задачи 1–3 дают работающую пользу сами по себе и выкатываются, не дожидаясь тура. Задачи 4–5 связаны: движок без маршрутов бесполезен. Задача 6 закрывает обе части.
