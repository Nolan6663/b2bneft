/* Тарифная сетка ТехЗаказ — единый источник для UI и будущего биллинга */
window.TZ_TARIFFS = {
    /** Пока true — оплата не взимается, всем поставщикам полный доступ */
    launchMode: true,

    customerAlwaysFree: true,

    earlyAdopterNote:
        'Компании, зарегистрированные в период раннего доступа, получат льготные условия при запуске платных тарифов.',

    plans: {
        launch: {
            id: 'launch',
            name: 'Ранний доступ',
            priceMonthly: 0,
            priceYearly: 0,
            tagline: 'Полный доступ · период запуска',
            features: [
                { ok: true, text: 'Все функции платформы без ограничений' },
                { ok: true, text: 'Отклики на закупки и чаты' },
                { ok: true, text: 'Профиль компании и каталог' },
                { ok: true, text: 'Аналитика и экспорт' },
                { ok: true, text: 'Верификация (по заявке)' },
                { ok: true, text: 'Приоритетная поддержка на старте' },
            ],
        },
        start: {
            id: 'start',
            name: 'Старт',
            priceMonthly: 0,
            priceYearly: 0,
            tagline: 'После запуска · для небольших производств',
            features: [
                { ok: true, text: 'Профиль в каталоге' },
                { ok: true, text: 'До 10 откликов в месяц' },
                { ok: true, text: 'Сообщения с заказчиками' },
                { ok: true, text: 'Базовая аналитика' },
                { ok: false, text: 'Приоритет в каталоге' },
                { ok: false, text: 'API-интеграция' },
            ],
        },
        business: {
            id: 'business',
            name: 'Бизнес',
            priceMonthly: 4990,
            priceYearly: 49900,
            tagline: 'в месяц · при оплате за год −17%',
            popular: true,
            features: [
                { ok: true, text: 'Неограниченные отклики' },
                { ok: true, text: 'Расширенный профиль + фото' },
                { ok: true, text: 'Полная аналитика и экспорт' },
                { ok: true, text: 'Приоритет верификации' },
                { ok: true, text: 'Уведомления о новых закупках' },
                { ok: false, text: 'API / ERP-интеграция' },
            ],
        },
        enterprise: {
            id: 'enterprise',
            name: 'Корпоративный',
            priceMonthly: null,
            priceYearly: null,
            tagline: 'индивидуальные условия',
            features: [
                { ok: true, text: 'Всё из тарифа «Бизнес»' },
                { ok: true, text: 'API-интеграция с ERP / 1С' },
                { ok: true, text: 'Персональный менеджер' },
                { ok: true, text: 'Мультиаккаунт команды' },
                { ok: true, text: 'SLA и кастомные отчёты' },
                { ok: true, text: 'Поддержка 24/7' },
            ],
        },
    },
};
