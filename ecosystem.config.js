'use strict';

module.exports = {
    apps: [{
        name: 'neft',
        script: 'server.js',
        env: {
            // Только эта переменная не работает через dotenv/.env (Node читает её
            // строго при старте процесса) — поэтому она здесь, а не в .env.
            // Все остальные переменные (.env) подхватываются через dotenv в server.js
            // на каждом обычном "pm2 restart neft" — никакого env $(cat .env...) не нужно.
            NODE_EXTRA_CA_CERTS: '/var/www/neft/certs/russian_trusted_root_ca.pem',
        },
    }],
};
