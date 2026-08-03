'use strict';

/* Подсказки к полям заявки. Один источник на обе формы — модалку кабинета
   (index.html) и гостевой мастер (zayavka.html). Тексты объясняют последствие:
   что изменится для заказчика, если поле заполнить плохо. */

const ORDER_FIELD_HINTS = {
    name:        'По названию завод решает, открывать заявку или пролистать. Пишите как в заявке снабженца: изделие, тип, размер.',
    category:    'Определяет, каким заводам заявка попадёт в подборку.',
    quantity:    'Партия целиком. От объёма зависит цена и возьмётся ли завод.',
    deadline:    'Реальный срок поставки. Слишком близкий отсекает часть производств.',
    city:        'Регион поставки. Влияет на подбор: логистика часто решает больше, чем цена.',
    description: 'Материал, ГОСТ, допуски, покрытие, приёмка, условия поставки. Чем точнее, тем меньше уточняющих вопросов и точнее цена.',
    drawing:     'PDF, DWG или STEP. Без чертежа заводы считают по описанию и закладывают запас в цену.',
};

const ORDER_NEXT_STEPS = [
    'Заявка уйдёт заводам, подходящим по специализации и региону.',
    'Отклики придут в раздел «КП» — там цена, срок и файл от завода.',
    'Переписка с заводом идёт в чате внутри платформы.',
];

/* Вставляет подсказку последней в группе поля. Именно в конец группы, а не
   сразу после элемента: <select> подменяется кастомным виджетом, который
   рисуется следом, и подсказка иначе оказывается выше самого поля.
   Группа — .form-group в кабинете и .ob-field в мастере; если её нет,
   встаём сразу после элемента. */
function applyFieldHints(root) {
    const scope = root || document;
    let inserted = 0;
    scope.querySelectorAll('[data-hint]').forEach((el) => {
        const text = ORDER_FIELD_HINTS[el.dataset.hint];
        if (!text) return;
        const group = el.closest('.form-group, .ob-field');
        if ((group || el.parentElement || document).querySelector(':scope > .form-hint')) return;
        const hint = document.createElement('div');
        hint.className = 'form-hint';
        hint.textContent = text;
        if (group) group.appendChild(hint);
        else el.insertAdjacentElement('afterend', hint);
        inserted += 1;
    });
    return inserted;
}

window.ORDER_FIELD_HINTS = ORDER_FIELD_HINTS;
window.ORDER_NEXT_STEPS = ORDER_NEXT_STEPS;
window.applyFieldHints = applyFieldHints;
