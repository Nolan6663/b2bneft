'use strict';

/* Согласие на аналитику — одно на весь сайт.
 *
 * Аналитические cookie ставятся с согласия посетителя, а не по факту захода, и
 * Вебвизор Метрики вдобавок записывает сессию целиком, включая ввод в формы.
 * Поэтому код счётчика на страницах не выполняется сам: он передаётся сюда
 * через tzAnalytics.push(...) и запускается только когда согласие есть.
 *
 * Файл грузится в <head> ДО сниппета счётчика и без defer: к моменту push
 * объект уже должен существовать. Пока согласия нет, к mc.yandex.ru не уходит
 * ни одного запроса.
 *
 * Хранилище — localStorage, ключ tzCookieConsent: 'accepted' | 'declined'.
 * Прежний ключ tzCookieAck не читаем намеренно: его выставляла плашка с
 * единственной кнопкой «Понятно», которая согласия не спрашивала, и засчитать
 * его задним числом нельзя.
 *
 * Плашка выбора живёт в футере (partials/footer.html) и по согласию зовёт
 * tzAnalytics.grant(). На страницах кабинета футера нет — там выбор уже сделан
 * раньше, и push() запускает счётчик сразу.
 */
(function (window) {
    // Страницы со счётчиком грузят файл в <head>, футер — ещё раз, для плашки.
    // Второй заход должен быть пустым: иначе он подменит объект и потеряет уже
    // отложенный код счётчика, и кнопка «Принять» ничего не запустит.
    if (window.tzAnalytics) return;

    var KEY = 'tzCookieConsent';

    function readConsent() {
        // Приватный режим и браузеры с запретом хранилища бросают на чтении.
        // Нет ответа — считаем, что согласия нет.
        try { return window.localStorage.getItem(KEY); } catch (e) { return null; }
    }

    function runSafely(fn) {
        // Счётчик не должен ронять страницу: он тут не главный.
        try { fn(); } catch (e) { /* аналитика не взлетела — не беда */ }
    }

    var pending = [];

    var tzAnalytics = {
        /** Есть ли согласие прямо сейчас. */
        granted: function () { return readConsent() === 'accepted'; },

        /** Ответил ли посетитель хоть что-нибудь (нужно футеру: показывать плашку или нет). */
        answered: function () { return readConsent() !== null; },

        /** Отложить код аналитики до согласия — или выполнить сразу, если оно есть. */
        push: function (fn) {
            if (typeof fn !== 'function') return;
            if (this.granted()) runSafely(fn);
            else pending.push(fn);
        },

        /** Согласие получено: запомнить и запустить всё отложенное. */
        grant: function () {
            try { window.localStorage.setItem(KEY, 'accepted'); } catch (e) { /* см. выше */ }
            var queued = pending;
            pending = [];
            for (var i = 0; i < queued.length; i++) runSafely(queued[i]);
        },

        /** Отказ: запомнить, отложенное не выполнять. */
        decline: function () {
            try { window.localStorage.setItem(KEY, 'declined'); } catch (e) { /* см. выше */ }
            pending = [];
        },
    };

    window.tzAnalytics = tzAnalytics;
})(window);
