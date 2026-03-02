const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { Client: PgClient } = require('pg');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.WEB_PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const POSTOS_FILE = path.join(DATA_DIR, 'postos.json');
const ALERTAS_FILE = path.join(DATA_DIR, 'alertas.json');
const LOG_FILE = path.join(DATA_DIR, 'app.log');

function log(message, level = 'INFO') {
    const timestamp = new Date().toLocaleString('pt-BR');
    const fullMessage = `[${timestamp}] [${level}] ${message}`;
    console.log(fullMessage);
    fs.appendFileSync(LOG_FILE, fullMessage + '\n');
    io.emit('log', fullMessage);
}

// --- Gerenciamento de Postos ---
function lerPostos() {
    try {
        const data = fs.readFileSync(POSTOS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return [];
    }
}

function salvarPostos(postos) {
    fs.writeFileSync(POSTOS_FILE, JSON.stringify(postos, null, 2));
}

function lerAlertas() {
    try {
        if (!fs.existsSync(ALERTAS_FILE)) return [];
        const data = fs.readFileSync(ALERTAS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return [];
    }
}

function salvarAlertas(alertas) {
    fs.writeFileSync(ALERTAS_FILE, JSON.stringify(alertas, null, 2));
}

// --- WhatsApp Client ---
const waClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        headless: true,
    }
});

let qrCodeData = null;
let waReady = false;

waClient.on('qr', (qr) => {
    qrCodeData = qr;
    waReady = false;
    log('QR Code gerado. Aguardando leitura no Dashboard.');
    io.emit('qr', qr);
});

waClient.on('ready', () => {
    qrCodeData = null;
    waReady = true;
    const number = waClient.info.wid.user;
    log(`✅ WhatsApp conectado! Número: ${number}`);
    io.emit('wa_status', { ready: true, number: number });
});

waClient.on('auth_failure', (msg) => {
    log(`Falha na autenticação WA: ${msg}`, 'ERROR');
});

// --- Lógica de Sincronia ---
async function verificarPosto(posto) {
    const pgClient = new PgClient({
        user: posto.user,
        host: posto.host,
        database: posto.database,
        password: posto.password,
        port: parseInt(posto.port, 10),
        connectionTimeoutMillis: 5000,
    });

    try {
        await pgClient.connect();
        const QUERY_SYNC = `
            SELECT 
                (select nome_reduzido from pessoa where grid=h.pessoa) as nome, 
                fs.ts,
                (select last_value from pgd_fid_seq) - fs.gfid as atraso
            FROM pgd_flow_sync fs 
            JOIN pgd_hosts h ON (fs.sid = h.sid) 
            WHERE fs.sid >= 0 
            ORDER BY fs.gfid desc, fs.sid;
        `;
        const res = await pgClient.query(QUERY_SYNC);
        const dataAtual = new Date();

        let alertas = [];
        for (const row of res.rows) {
            const atraso = Number(row.atraso);
            const diffMs = dataAtual - new Date(row.ts);
            if (atraso > 50000 || diffMs > 3600000) {
                alertas.push(`*${row.nome || 'Host'}*: Atraso ${atraso} | Tempo ${Math.floor(diffMs / 60000)}min`);
            }
        }

        if (alertas.length > 0 && waReady) {
            const msg = `🚨 *ALERTA: ${posto.nome}* 🚨\n\n${alertas.join('\n')}`;
            const numbers = lerAlertas();
            for (const n of numbers) {
                if (n.trim()) {
                    try {
                        await waClient.sendMessage(n.trim(), msg);
                    } catch (err) {
                        log(`Erro ao enviar alerta para ${n}: ${err.message}`, 'ERROR');
                    }
                }
            }
        }

        io.emit('status_posto', {
            id: posto.id,
            status: alertas.length > 0 ? 'atrasado' : 'ok',
            lastCheck: new Date().toLocaleString('pt-BR'),
            hosts: res.rows.map(row => ({
                nome: row.nome || 'Host',
                ts: row.ts,
                atraso: row.atraso,
                online: (Number(row.atraso) <= 50000 && (dataAtual - new Date(row.ts)) <= 3600000)
            }))
        });
        return { success: true, alertas: alertas.length };
    } catch (e) {
        log(`Erro no posto ${posto.nome}: ${e.message}`, 'ERROR');
        io.emit('status_posto', { id: posto.id, status: 'erro', error: e.message });
        return { success: false, error: e.message };
    } finally {
        await pgClient.end();
    }
}

// --- Endpoints API ---
app.get('/api/postos', (req, res) => res.json(lerPostos()));

app.post('/api/test-connection', async (req, res) => {
    const { user, host, database, password, port } = req.body;

    const dbConfig = {
        user: user,
        host: host,
        database: database,
        password: password,
        port: parseInt(port, 10),
        connectionTimeoutMillis: 5000
    };

    const pgClient = new PgClient(dbConfig);

    try {
        log(`Testando conexão para: ${host}:${port || 5432} (Banco: ${database}, Usuário: ${user})`);
        await pgClient.connect();
        await pgClient.end();
        res.json({ success: true });
    } catch (e) {
        log(`Erro detalhado no teste de conexão: ${e.message} (Código: ${e.code})`, 'ERROR');

        let userMessage = e.message;

        // Identificação de erros comuns do PostgreSQL
        if (e.code === '28P01' || e.message.includes('password authentication')) {
            userMessage = '❌ Senha ou Usuário incorretos.';
        } else if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED' || e.message.includes('getaddrinfo')) {
            userMessage = '❌ Host ou Porta inacessíveis. Verifique o endereço do servidor.';
        } else if (e.code === '3D000' || (e.message.includes('database') && e.message.includes('does not exist'))) {
            userMessage = '❌ O Banco de Dados especificado não existe.';
        } else if (e.message.includes('timeout')) {
            userMessage = '❌ Tempo limite esgotado. Verifique se o host e porta estão corretos e se há firewall bloqueando.';
        }

        res.status(500).json({ success: false, error: userMessage });
    }
});

app.post('/api/postos', (req, res) => {
    const postos = lerPostos();
    const novoPosto = { ...req.body, id: Date.now().toString() };
    postos.push(novoPosto);
    salvarPostos(postos);
    res.json(novoPosto);
});

app.put('/api/postos/:id', (req, res) => {
    const postos = lerPostos();
    const index = postos.findIndex(p => p.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Posto não encontrado' });

    postos[index] = { ...req.body, id: req.params.id };
    salvarPostos(postos);
    res.json(postos[index]);
});

app.delete('/api/postos/:id', (req, res) => {
    let postos = lerPostos();
    postos = postos.filter(p => p.id !== req.params.id);
    salvarPostos(postos);
    res.json({ success: true });
});

// --- Segurança ---
const CREDENTIALS = {
    user: 'office',
    pass: '@Office820439La'
};

app.post('/api/login', (req, res) => {
    const { user, pass } = req.body;
    if (user === CREDENTIALS.user && pass === CREDENTIALS.pass) {
        res.json({ success: true, token: Buffer.from(`${user}:${pass}`).toString('base64') });
    } else {
        res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }
});

// --- Endpoints Alertas ---
app.get('/api/alertas', (req, res) => res.json(lerAlertas()));

app.post('/api/alertas', (req, res) => {
    const { numero } = req.body;
    if (!numero) return res.status(400).json({ error: 'Número é obrigatório' });

    let alertas = lerAlertas();
    if (!alertas.includes(numero)) {
        alertas.push(numero);
        salvarAlertas(alertas);
    }
    res.json({ success: true, alertas });
});

app.delete('/api/alertas', (req, res) => {
    const { numero } = req.body;
    let alertas = lerAlertas();
    alertas = alertas.filter(n => n !== numero);
    salvarAlertas(alertas);
    res.json({ success: true, alertas });
});

// --- Endpoints WhatsApp Control ---
app.post('/api/wa/disconnect', async (req, res) => {
    try {
        log('Solicitação de desconexão do WhatsApp recebida.');
        await waClient.logout();
        waReady = false;
        qrCodeData = null;
        io.emit('wa_status', { ready: false });
        res.json({ success: true });
    } catch (e) {
        log(`Erro ao desconectar WhatsApp: ${e.message}`, 'ERROR');
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/wa/reset', async (req, res) => {
    try {
        log('Solicitação de reset/novo QR Code recebida.');
        // Para forçar um novo QR Code sem necessariamente dar logout (caso esteja preso)
        // O ideal é destruir e reinicializar se estiver falhando
        await waClient.destroy();
        waReady = false;
        qrCodeData = null;
        await waClient.initialize();
        res.json({ success: true });
    } catch (e) {
        log(`Erro ao resetar WhatsApp: ${e.message}`, 'ERROR');
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- Inicialização ---
io.on('connection', (socket) => {
    if (qrCodeData) socket.emit('qr', qrCodeData);
    if (waReady) socket.emit('wa_status', { ready: true, number: waClient.info?.wid?.user });

    const postos = lerPostos();
    socket.emit('postos', postos);

    // Disparar verificação imediata para atualizar o dashboard do novo usuário conectado
    postos.forEach(p => verificarPosto(p));
});

server.listen(PORT, async () => {
    log(`Servidor rodando na porta ${PORT}`);
    waClient.initialize();

    waClient.on('disconnected', (reason) => {
        log(`WhatsApp desconectado: ${reason}`);
        waReady = false;
        qrCodeData = null;
        io.emit('wa_status', { ready: false });
    });

    // Verificação inicial de todos os postos ao subir o servidor
    const postos = lerPostos();
    if (postos.length > 0) {
        log(`Executando verificação inicial para ${postos.length} postos...`);
        for (const p of postos) {
            verificarPosto(p); // Rodar em background (sem await para não travar o boot)
        }
    }
});

// Registro de última verificação para controle de frequência
const ultimasVerificacoes = {};

// Função de monitoramento com controle de frequência individual
async function executarMonitoriaAgendada() {
    const postos = lerPostos();
    const agora = Date.now();

    for (const p of postos) {
        const freqMs = (parseInt(p.frequencia, 10) || 5) * 60 * 1000;
        const ultima = ultimasVerificacoes[p.id] || 0;

        if (agora - ultima >= freqMs) {
            log(`Iniciando verificação para ${p.nome} (Frequência: ${p.frequencia}min)`);
            await verificarPosto(p);
            ultimasVerificacoes[p.id] = agora;
        }
    }
}

// Cron a cada 1 minuto para checar quem precisa ser verificado
cron.schedule('* * * * *', executarMonitoriaAgendada);
