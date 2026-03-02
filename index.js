const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { Client: PgClient } = require('pg');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// --- Sistema de Logs Simples ---
const LOG_FILE = path.join(__dirname, 'app.log');

function log(message, level = 'INFO') {
    const timestamp = new Date().toLocaleString('pt-BR');
    const fullMessage = `[${timestamp}] [${level}] ${message}`;
    console.log(fullMessage);
    fs.appendFileSync(LOG_FILE, fullMessage + '\n');
}

/**
 * Função de verificação do banco de dados.
 */
async function verificarSincronia(waClient) {
    const pgClient = new PgClient(config.db);

    let alertasCriticos = [];
    let alertasAltos = [];
    let alertasAviso = [];
    let hostsOK = 0;

    try {
        log('Iniciando verificação de sincronia...');
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

        if (res.rows.length === 0) {
            log('Nenhum host encontrado para verificar.', 'WARN');
            return;
        }

        for (const row of res.rows) {
            const atraso = Number(row.atraso);
            const nome = row.nome || 'Host Desconhecido';
            const dataObj = new Date(row.ts);

            // Formatação Visual
            const dataFormatada = dataObj.toLocaleString('pt-BR');

            // Cálculo de Tempo
            const diffMs = dataAtual - dataObj;
            const isAtrasadoMaisDeUmaHora = diffMs > config.thresholds.tempoMs;

            let detalheHost = `*Host:* ${nome} | *Atraso:* ${atraso} | *Data:* ${dataFormatada}`;

            if (isAtrasadoMaisDeUmaHora) {
                detalheHost += ` ⏳ (>1h)`;
            }

            // Classificação
            if (atraso > config.thresholds.critico) {
                alertasCriticos.push(detalheHost);
                log(`CRÍTICO: ${nome} (Atraso: ${atraso})`, 'ERROR');
            } else if (atraso >= config.thresholds.alto) {
                alertasAltos.push(detalheHost);
                log(`ALTO: ${nome} (Atraso: ${atraso})`, 'WARN');
            } else if (atraso >= config.thresholds.aviso || isAtrasadoMaisDeUmaHora) {
                alertasAviso.push(detalheHost);
                log(`AVISO: ${nome} (Atraso: ${atraso} ou Tempo > 1h)`, 'WARN');
            } else {
                hostsOK++;
            }
        }

        if (alertasCriticos.length > 0 || alertasAltos.length > 0 || alertasAviso.length > 0) {
            let mensagemFinal = "🚨 *MONITORAMENTO DE SINCRONIA* 🚨\n\nForam detectados os seguintes atrasos:\n";

            if (alertasCriticos.length > 0) {
                mensagemFinal += "\n🔥 *ALERTA CRÍTICO* 🔥\n" + alertasCriticos.join('\n') + "\n";
            }
            if (alertasAltos.length > 0) {
                mensagemFinal += "\n🟠 *ALERTA ALTO* 🟠\n" + alertasAltos.join('\n') + "\n";
            }
            if (alertasAviso.length > 0) {
                mensagemFinal += "\n⚠️ *AVISO* ⚠️\n" + alertasAviso.join('\n') + "\n";
            }

            await enviarNotificacao(waClient, mensagemFinal);
        } else {
            log(`Todos os ${hostsOK} hosts estão OK.`);
            // Opcional: Notificar que está tudo OK (Pode ser desativado para reduzir spam)
            // await enviarNotificacao(waClient, '✅ Sincronia OK \n\nTodos os hosts estão sincronizados.');
        }

    } catch (error) {
        const errMsg = `Erro ao verificar sincronia: ${error.message}`;
        log(errMsg, 'ERROR');
        await enviarNotificacao(waClient, `🚨 ERRO NO SCRIPT DE MONITORAMENTO 🚨\n\nNão foi possível conectar ao banco de dados.\nErro: ${error.message}`);
    } finally {
        await pgClient.end();
    }
}

/**
 * Helper para envio de mensagens
 */
async function enviarNotificacao(waClient, mensagem) {
    for (const numero of config.wa.numbers) {
        try {
            await waClient.sendMessage(numero, mensagem);
            await new Promise(r => setTimeout(r, 1000));
            log(`Notificação enviada para ${numero}`);
        } catch (error) {
            log(`Erro ao enviar para ${numero}: ${error.message}`, 'ERROR');
        }
    }
}

/**
 * Inicialização do Bot
 */
function iniciarBot() {
    log('Iniciando cliente WhatsApp...');

    const client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ],
            headless: true,
        }
    });

    client.on('qr', (qr) => {
        log('QR Code recebido. Aguardando escaneamento...');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        log('✅ WhatsApp conectado e pronto!');

        enviarNotificacao(client, '🤖 *Monitoramento Sincronia v2.1 Iniciado*');

        verificarSincronia(client);

        cron.schedule(config.cron.schedule, () => {
            log('Executando verificação agendada...');
            verificarSincronia(client);
        });
    });

    client.on('auth_failure', msg => {
        log(`Falha na autenticação: ${msg}`, 'ERROR');
    });

    client.initialize().catch(err => {
        log(`Erro fatal na inicialização: ${err.message}`, 'ERROR');
    });
}

iniciarBot();