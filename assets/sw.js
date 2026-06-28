'use strict';

self.addEventListener('push', (event) => {
    if (!event.data) return;
    let payload;
    try { payload = event.data.json(); }
    catch { payload = { title: 'ТехЗаказ', body: event.data.text(), url: '/' }; }

    event.waitUntil(
        self.registration.showNotification(payload.title || 'ТехЗаказ', {
            body: payload.body || '',
            icon: '/favicon.svg',
            badge: '/favicon.svg',
            data: { url: payload.url || '/' },
            requireInteraction: false,
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url || '/';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            for (const client of list) {
                if (client.url === url && 'focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow(url);
        })
    );
});
