require('dotenv').config();

const config = {
    db: {
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'autosystem',
        password: process.env.DB_PASSWORD || '',
        port: parseInt(process.env.DB_PORT || '5432', 10),
    },
    wa: {
        numbers: (process.env.ALERT_NUMBERS || '').split(',').map(n => n.trim()).filter(n => n.length > 0),
    },
    cron: {
        schedule: process.env.CRON_SCHEDULE || '0 7-19 * * *',
    },
    thresholds: {
        critico: 500000,
        alto: 100000,
        aviso: 50000,
        tempoMs: 3600000, // 1 hora
    }
};

module.exports = config;
