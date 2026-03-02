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
const LOG_FILE = path.join(DATA_DIR, 'app.log');

// Memória temporária para acompanhar últimos alertas e status
const statusMemoria = {};

function log(message, level = 'INFO') {
    const timestamp = new Date().toLocaleString('pt-BR');
    const fullMessage = `[${timestamp}] [${level}] ${message}`;
    console.log(fullMessage);
    try {
        fs.appendFileSync(LOG_FILE, fullMessage + '\n');
    } catch (e) { }
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


// --- Estabilização Docker Chromium ---
function limparLocksChromium(dir) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.lstatSync(fullPath).isDirectory()) {
            limparLocksChromium(fullPath);
        } else if (file === 'SingletonLock' || file === 'SingletonCookie' || file === 'SingletonSocket') {
            try {
                fs.unlinkSync(fullPath);
                console.log(`[DOCKER-FIX] Removido: ${fullPath}`);
            } catch (e) { }
        }
    }
}

// Limpa recursivamente na inicialização
console.log('[DOCKER-FIX] Iniciando limpeza de travas do Chromium...');
limparLocksChromium(DATA_DIR);

function salvarAlertas(alertas) {
    fs.writeFileSync(ALERTAS_FILE, JSON.stringify(alertas, null, 2));
}

// --- WhatsApp Client ---
const waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, 'session') }),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--no-zygote',
            '--single-process' // Recomendado para containers pequenos
        ],
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
    log(`Iniciando verificação: ${posto.nome}`);
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
        await pgClient.query("SET client_encoding TO 'LATIN1';");

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

        // Parâmetros configuráveis
        const limiteTempoMin = parseInt(posto.alerta_tempo || 60, 10);
        const limiteGFID = parseInt(posto.alerta_gfid || 50000, 10);
        const limiteTempoMs = limiteTempoMin * 60 * 1000;

        let alertasMsg = [];
        let temAtraso = false;

        for (const row of res.rows) {
            const atraso = Number(row.atraso);
            const tsDate = new Date(row.ts);
            const diffMs = Math.max(0, dataAtual - tsDate);

            const atrasoTempoUltrapassado = diffMs > limiteTempoMs;
            const atrasoGFIDUltrapassado = atraso > limiteGFID;
            const estaAtrasado = atrasoTempoUltrapassado || atrasoGFIDUltrapassado;

            if (estaAtrasado) {
                log(`[ALERT-DEBUG] ${posto.nome} - ${row.nome || 'Host'}: RED por ${atrasoTempoUltrapassado ? 'Tempo' : 'GFID'}. Atraso: ${atraso} (limite ${limiteGFID}), Tempo: ${Math.floor(diffMs / 60000)}min (limite ${limiteTempoMin}min)`, 'WARNING');
            }

            const icon = estaAtrasado ? '🔴' : '🟢';
            const dataHora = tsDate.toLocaleString('pt-BR');
            const atrasoNum = atraso.toLocaleString('pt-BR');
            alertasMsg.push(`${icon} *${(row.nome || 'Terminal').toUpperCase()}* | Atraso: ${atrasoNum} | Data: ${dataHora} .-`);

            if (estaAtrasado) temAtraso = true;
            row.online = !estaAtrasado;
        }

        if (temAtraso && waReady) {
            // Controle de envio de mensagens para não floodar
            const agora = Date.now();
            const memorialPosto = statusMemoria[posto.id] || { ultimoAlerta: 0 };
            const freqMs = (parseInt(posto.frequencia, 10) || 5) * 60 * 1000;

            // Verificação de Janela de Silêncio
            const agoraHora = new Date().toLocaleTimeString('pt-BR', { hour12: false, hour: '2-digit', minute: '2-digit' });
            const inicio = posto.alerta_inicio || "00:00";
            const fim = posto.alerta_fim || "23:59";

            const estaNaJanela = (inicio <= fim)
                ? (agoraHora >= inicio && agoraHora <= fim) // Janela no mesmo dia (ex: 08:00 as 22:00)
                : (agoraHora >= inicio || agoraHora <= fim); // Janela vira o dia (ex: 22:00 as 06:00)

            if (agora - memorialPosto.ultimoAlerta >= freqMs) {
                if (!estaNaJanela) {
                    log(`[SILENCE] ${posto.nome}: Alerta reprimido (Horário: ${agoraHora}, Janela: ${inicio}-${fim})`);
                    return { success: true, alertas: temAtraso ? 1 : 0 };
                }

                // Formato organizado: Uma linha por terminal com bolinha e data completa
                const msg = `🚨 *${posto.nome.toUpperCase()}*\nUltima Sincronia em:\n\n${alertasMsg.join('\n')}`;

                const numbers = posto.alertas || [];
                log(`[WA-SEND] ${posto.nome}: Enviando para ${numbers.length} destinatários específicos: ${numbers.join(', ')}`);

                for (const n of numbers) {
                    let num = n.replace(/\D/g, ''); // Limpa tudo que não é número
                    if (!num) continue;

                    // Adição automática de 55 para DDDs brasileiros (10 ou 11 dígitos)
                    if (num.length >= 10 && num.length <= 11 && !num.startsWith('55')) {
                        num = '55' + num;
                    }

                    try {
                        const contactId = await waClient.getNumberId(num);
                        const formattedNum = contactId ? contactId._serialized : `${num}@c.us`;
                        await waClient.sendMessage(formattedNum, msg);
                    } catch (err) {
                        log(`Erro ao enviar alerta para ${n}: ${err.message}`, 'ERROR');
                    }
                }
                memorialPosto.ultimoAlerta = agora;
                memorialPosto.ultimoAlertaString = new Date().toLocaleTimeString('pt-BR');
                statusMemoria[posto.id] = memorialPosto;
            }
        }

        io.emit('status_posto', {
            id: posto.id,
            status: temAtraso ? 'atrasado' : 'ok',
            lastCheck: new Date().toLocaleString('pt-BR'),
            ultimoAlerta: statusMemoria[posto.id]?.ultimoAlertaString || null,
            hosts: res.rows.map(row => ({
                nome: row.nome || 'Host',
                ts: row.ts,
                atraso: row.atraso,
                online: row.online
            }))
        });
        log(`Sucesso na monitoria: ${posto.nome} (${temAtraso ? 'ATRASADO' : 'OK'})`, temAtraso ? 'WARNING' : 'INFO');
        return { success: true, alertas: temAtraso ? 1 : 0 };
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
    const pgClient = new PgClient({
        user, host, database, password,
        port: parseInt(port, 10),
        connectionTimeoutMillis: 5000
    });

    try {
        await pgClient.connect();
        await pgClient.query("SET client_encoding TO 'LATIN1';");
        await pgClient.end();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
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
const CREDENTIALS = { user: 'office', pass: '@Office820439La' };
app.post('/api/login', (req, res) => {
    const { user, pass } = req.body;
    if (user === CREDENTIALS.user && pass === CREDENTIALS.pass) {
        const token = Buffer.from(`${user}:${pass}`).toString('base64');
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }
});

// --- Endpoints Alertas ---
app.get('/api/alertas', (req, res) => res.json(lerAlertas()));
app.post('/api/alertas', (req, res) => {
    const { numero } = req.body;
    let alertas = lerAlertas();
    let num = numero.replace(/\D/g, '');

    // Se o usuário digitou DDD + número (10 ou 11 dígitos), coloca o 55
    if (num.length >= 10 && num.length <= 11) {
        num = '55' + num;
    }

    if (num && !alertas.includes(num)) {
        alertas.push(num);
        salvarAlertas(alertas);
    }
    res.json({ success: true, alertas });
});
app.delete('/api/alertas', (req, res) => {
    const { numero } = req.body;
    let alertas = lerAlertas().filter(n => n !== numero);
    salvarAlertas(alertas);
    res.json({ success: true, alertas });
});

// --- Endpoints WhatsApp Control ---
app.post('/api/wa/disconnect', async (req, res) => {
    try {
        await waClient.logout();
        waReady = false;
        qrCodeData = null;
        io.emit('wa_status', { ready: false });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/wa/send-test', async (req, res) => {
    const { numero } = req.body;
    if (!waReady) return res.status(400).json({ error: 'WhatsApp não está conectado' });

    let num = numero.replace(/\D/g, '');
    if (num.length >= 10 && num.length <= 11) {
        num = '55' + num;
    }

    try {
        const contactId = await waClient.getNumberId(num);
        if (!contactId) return res.status(404).json({ error: 'Número não encontrado no WhatsApp' });

        await waClient.sendMessage(contactId._serialized, '✅ *Teste de Conexão Sinc Autosystem*\nSeu sistema de monitoria está configurado corretamente.');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/wa/reset', async (req, res) => {
    try {
        await waClient.destroy();
        waReady = false;
        qrCodeData = null;
        await waClient.initialize();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- Inicialização ---
io.on('connection', (socket) => {
    if (qrCodeData) socket.emit('qr', qrCodeData);
    if (waReady) socket.emit('wa_status', { ready: true, number: waClient.info?.wid?.user });
    socket.emit('postos', lerPostos());
});

server.listen(PORT, async () => {
    log(`Servidor rodando na porta ${PORT}`);
    waClient.initialize();

    // Verificação inicial
    const postos = lerPostos();
    for (const p of postos) verificarPosto(p);
});

// Monitoria agendada
const ultimasVerificacoes = {};
async function executarMonitoriaAgendada() {
    const postos = lerPostos();
    const agora = Date.now();

    for (const p of postos) {
        const freqMs = (parseInt(p.frequencia, 10) || 5) * 60 * 1000;
        const ultima = ultimasVerificacoes[p.id] || 0;

        if (agora - ultima >= freqMs) {
            log(`Executando monitoria agendada para: ${p.nome}`);
            await verificarPosto(p);
            ultimasVerificacoes[p.id] = agora;
        }
    }
}

cron.schedule('* * * * *', executarMonitoriaAgendada);
