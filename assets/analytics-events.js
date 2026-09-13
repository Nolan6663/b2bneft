'use strict';

/* Обязательные события платформы — ТЗ §12.1.
 *
 * Зачем отдельный слой, а не вызовы ym() по месту:
 *
 * 1. Согласие. После введения плашки счётчик не запускается, пока посетитель
 *    не нажал «Принять», и window.ym до этого не существует. Прямой вызов в
 *    таком состоянии — это исключение в обработчике клика, то есть сломанная
 *    кнопка. Здесь проверка одна и в одном месте.
 *
 * 2. Имена. ТЗ перечисляет пятнадцать событий с фиксированными именами и
 *    параметрами. Опечатка в имени не ломает ничего видимого — просто цель
 *    молча не набирает статистику, и обнаруживается это через месяц, когда
 *    маркетинг приходит за воронкой. Поэтому имена сверяются со списком.
 *
 * 3. Отправка ровно один раз. ТЗ §16.3 требует «все обязательные события
 *    фиксируются один раз с корректными параметрами». Счётчиков на странице
 *    два, и слать цель в оба — значит удвоить конверсии в отчётах.
 *
 * Совместимость: прежние цели (register, onboarding_*) продолжают работать как
 * раньше. Они уже настроены в интерфейсе Метрики и собирают данные —
 * переименование обнулило бы накопленное. Новые события идут рядом.
 */
(function (window) {
    if (window.tzEvent) return;

    /* Каталог из ТЗ §12.1. Значение — список ожидаемых параметров; он нужен не
       для проверки, а как документация рядом с кодом: когда через полгода
       понадобится добавить параметр, список скажет, какие уже есть. */
    var EVENTS = {
        landing_view:           ['page_type', 'entity_id', 'intent', 'source'],
        primary_cta_click:      ['page_type', 'cta', 'position'],
        drawing_upload_start:   ['page_type', 'file_type'],
        drawing_upload_success: ['file_type', 'file_size_bucket'],
        order_step_complete:    ['step', 'category', 'role'],
        order_created:          ['service_ids', 'product_ids', 'region'],
        company_filter:         ['filter_name', 'value', 'results_count'],
        company_compare:        ['company_count', 'topic'],
        company_invited:        ['company_id', 'order_id'],
        order_response:         ['order_id', 'company_id', 'source_page'],
        search_submit:          ['query_normalized', 'role', 'results_count'],
        search_result_click:    ['result_type', 'position'],
        case_submit:            ['company_id', 'entities_count'],
        case_published:         ['case_id', 'moderation_time'],
        order_subscription:     ['filters', 'notification_channel'],
    };

    /* Размер файла отправляем корзиной, а не байтами: точный размер чертежа —
       это характеристика конкретного документа заказчика, и складывать её в
       аналитику незачем. Корзина отвечает на вопрос «тяжёлые ли файлы грузят»,
       не рассказывая ничего о самом файле. */
    function sizeBucket(bytes) {
        var mb = Number(bytes) / (1024 * 1024);
        if (!isFinite(mb) || mb <= 0) return 'unknown';
        if (mb < 1) return '<1mb';
        if (mb < 5) return '1-5mb';
        if (mb < 20) return '5-20mb';
        return '>20mb';
    }

    function counterId() {
        // Один счётчик, а не оба: цель, отправленная дважды, удваивает
        // конверсию в отчётах и делает воронку бессмысленной.
        return window.__tzYmId || null;
    }

    /**
     * Отправить событие.
     * @param {string} name   имя из каталога выше
     * @param {object} params параметры события
     */
    function tzEvent(name, params) {
        if (!Object.prototype.hasOwnProperty.call(EVENTS, name)) {
            // Не молчим: неизвестное имя означает опечатку, а опечатка тихо
            // съедает статистику на месяцы вперёд.
            if (window.console) console.warn('tzEvent: неизвестное событие «' + name + '»');
            return false;
        }
        // Нет согласия — нет аналитики. Это не сбой, а нормальный режим работы:
        // посетитель отказался, и событий по нему быть не должно.
        if (!window.tzAnalytics || !window.tzAnalytics.granted()) return false;
        if (typeof window.ym !== 'function') return false;

        var id = counterId();
        if (!id) return false;

        try {
            if (params && Object.keys(params).length) {
                window.ym(id, 'reachGoal', name, params);
            } else {
                window.ym(id, 'reachGoal', name);
            }
            return true;
        } catch (e) {
            // Аналитика не должна ронять страницу: ошибка здесь не стоит
            // сломанной кнопки.
            return false;
        }
    }

    tzEvent.EVENTS = EVENTS;
    tzEvent.sizeBucket = sizeBucket;
    window.tzEvent = tzEvent;
})(window);
