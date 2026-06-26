'use strict';
require('dotenv').config();

module.exports = {
    apps: [{
        name: 'neft',
        script: 'server.js',
        env: process.env,
    }],
};
