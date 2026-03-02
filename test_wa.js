const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

console.log('Iniciando teste de conexão WhatsApp...');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true,
    }
});

client.on('qr', (qr) => {
    console.log('QR Code recebido! (A sessão atual parece ter expirado ou é inválida)');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp pronto!');
    process.exit(0);
});

client.on('auth_failure', msg => {
    console.error('❌ Falha na autenticação:', msg);
    process.exit(1);
});

client.on('disconnected', (reason) => {
    console.log('❌ WhatsApp desconectado:', reason);
});

setTimeout(() => {
    console.log('Tempo limite de 60s atingido. Encerrando teste.');
    process.exit(0);
}, 60000);

client.initialize().catch(err => {
    console.error('Erro ao inicializar:', err);
    process.exit(1);
});
