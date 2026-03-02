const { Client } = require('pg');

const dbConfig = {
    user: 'postgres',
    host: 'node231575-redeitatiaia.sp1.br.saveincloud.net.br',
    database: 'autosystem',
    password: '@Office0312',
    port: 16463,
};

async function testConnection() {
    const client = new Client(dbConfig);
    try {
        console.log('Tentando conectar ao banco de dados...');
        await client.connect();
        console.log('Conexão bem sucedida!');
        const res = await client.query('SELECT current_timestamp');
        console.log('Hora do servidor:', res.rows[0].current_timestamp);
    } catch (err) {
        console.error('Erro na conexão:', err.message);
    } finally {
        await client.end();
    }
}

testConnection();
