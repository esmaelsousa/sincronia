const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { Client: PgClient } = require('pg');
const cron = require('node-cron');

// --- Configuração do WhatsApp ---
const LISTA_NUMEROS_ALERTA = [
    '557491414996@c.us',
    '557491985228@c.us',
    '557591361080@c.us',
    '557481078575@c.us',
    // '55YYYYYYYYYY@c.us' 
];

// --- Configuração do Banco ---
const dbConfig = {
    user: 'postgres',
    host: 'node231575-redeitatiaia.sp1.br.saveincloud.net.br',
    database: 'autosystem',
    password: '@Office0312',
    port: 16463,
};

// A consulta SQL
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

/**N
 * Função de verificação do banco.
 */
async function verificarSincronia(waClient) {
    const pgClient = new PgClient(dbConfig);
    
    // 1. Criamos arrays para coletar os alertas
    let alertasCriticos = [];
    let alertasAltos = [];
    let alertasAviso = [];
    let hostsOK = 0; // Para contar quantos estão bons

    try {
        await pgClient.connect();
        const res = await pgClient.query(QUERY_SYNC);
        const dataAtual = new Date(); // Data atual para comparação
        
        console.log(`[${dataAtual.toLocaleString()}] Verificando sincronia...`);

        if (res.rows.length === 0) {
            console.log('Nenhum host encontrado para verificar.');
            return;
        }

        // 2. Loop de COLETA DE DADOS
        for (const row of res.rows) {
            const atraso = Number(row.atraso);
            const nome = row.nome || 'Host Desconhecido';

            // --- TRATAMENTO DA DATA ---
            const dataObj = new Date(row.ts);

            // Formatação Visual (DD/MM/AAAA HH:MM:SS)
            const dia = String(dataObj.getDate()).padStart(2, '0');
            const mes = String(dataObj.getMonth() + 1).padStart(2, '0');
            const ano = dataObj.getFullYear();
            const hora = String(dataObj.getHours()).padStart(2, '0');
            const min = String(dataObj.getMinutes()).padStart(2, '0');
            const seg = String(dataObj.getSeconds()).padStart(2, '0');
            const dataFormatada = `${dia}/${mes}/${ano} ${hora}:${min}:${seg}`;

            // --- CÁLCULO DE TEMPO (NOVA LÓGICA) ---
            // Diferença em milissegundos
            const diffMs = dataAtual - dataObj; 
            // 1 hora = 1000 ms * 60 seg * 60 min = 3.600.000 ms
            const isAtrasadoMaisDeUmaHora = diffMs > 3600000; 

            // Montamos a linha base da mensagem
            let detalheHost = `*Host:* ${nome} | *Atraso:* ${atraso} | *Data:* ${dataFormatada}`;

            // Se tiver mais de 1 hora de atraso, adicionamos um ícone de alerta no texto
            if (isAtrasadoMaisDeUmaHora) {
                detalheHost += ` ⏳ (>1h)`;
            }

            // --- LÓGICA DE CLASSIFICAÇÃO ---
            
            if (atraso > 500000) {
                // Nível CRÍTICO (Prioridade máxima pelo atraso de sequência)
                alertasCriticos.push(detalheHost);
                console.error(`CRÍTICO: ${nome} (Atraso: ${atraso})`);

            } else if (atraso >= 100000) { 
                // Nível ALTO
                alertasAltos.push(detalheHost);
                console.warn(`ALTO: ${nome} (Atraso: ${atraso})`);

            } else if (atraso >= 50000) {
                // Nível AVISO por sequência
                alertasAviso.push(detalheHost);
                console.warn(`AVISO: ${nome} (Atraso: ${atraso})`);
            
            } else if (isAtrasadoMaisDeUmaHora) {
                // --- NOVA CONDIÇÃO ---
                // Se a sequência está OK (abaixo de 50k), MAS o tempo é maior que 1h,
                // jogamos para a lista de AVISO.
                alertasAviso.push(detalheHost);
                console.warn(`AVISO TEMPORAL: ${nome} (Mais de 1h sem sync)`);

            } else {
                // Nível OK (Sequência baixa e Tempo menor que 1h)
                hostsOK++;
                console.log(`OK: Host ${nome}.`);
            }
        } 

        // 3. Montagem e Envio da MENSAGEM ÚNICA
        if (alertasCriticos.length > 0 || alertasAltos.length > 0 || alertasAviso.length > 0) {
            
            let mensagemFinal = "🚨 *MONITORAMENTO DE SINCRONIA* 🚨\n\nForam detectados os seguintes atrasos:\n";

            if (alertasCriticos.length > 0) {
                mensagemFinal += "\n🔥 *ALERTA CRÍTICO* 🔥\n";
                mensagemFinal += alertasCriticos.join('\n');
                mensagemFinal += "\n";
            }
    
            if (alertasAltos.length > 0) {
                mensagemFinal += "\n🟠 *ALERTA ALTO* 🟠\n";
                mensagemFinal += alertasAltos.join('\n');
                mensagemFinal += "\n";
            }
    
            if (alertasAviso.length > 0) {
                mensagemFinal += "\n⚠️ *AVISO* ⚠️\n";
                mensagemFinal += alertasAviso.join('\n');
                mensagemFinal += "\n";
            }

            console.log("Enviando relatório de alertas...");
            await enviarNotificacao(waClient, mensagemFinal);
            
        } else {
            console.log(`Todos os ${hostsOK} hosts estão OK.`);
            // A mensagem de OK só é interessante enviar se você quiser confirmar que o bot está vivo,
            // ou pode comentar a linha abaixo para reduzir spam quando tudo estiver bem.
            await enviarNotificacao(waClient, '✅ Sincronia OK \n\nTodos os hosts estão sincronizados (< 1h e sequências OK).');
        }

    } catch (error) {
        console.error('Erro ao verificar sincronia:', error.message);
        await enviarNotificacao(waClient, `🚨 ERRO NO SCRIPT DE MONITORAMENTO 🚨\n\nNão foi possível verificar a sincronia.\nErro: ${error.message}`);
    } finally {
        await pgClient.end();
    }
}

/**
 * Função helper para enviar notificação
 */
async function enviarNotificacao(waClient, mensagem) {
    for (const numero of LISTA_NUMEROS_ALERTA) {
        try {
            await waClient.sendMessage(numero, mensagem);
            // Pequeno delay para evitar bloqueio por spam se a lista for grande
            await new Promise(r => setTimeout(r, 1000)); 
            console.log(`Notificação enviada para ${numero}`);
        } catch (error) {
            console.error(`Erro ao enviar para ${numero}:`, error.message);
        }
    }
}

/**
 * Função principal para iniciar o Bot
 */
function iniciarBot() {
    console.log('Iniciando cliente whatsapp-web.js...');
    
    const client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        }
    });

    client.on('qr', (qr) => {
        console.log('QR Code recebido! Escaneie com seu celular:');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        console.log('\n✅ Cliente WhatsApp pronto! Iniciando monitoramento.');
        
        enviarNotificacao(client, '🤖 Monitoramento Rede Itatiaia V2 iniciado! (Verificando Tempo > 1h)');
        
        console.log('Executando verificação inicial...');
        verificarSincronia(client);

        // Agendamento: Hora cheia, das 7h às 19h
        const AGENDAMENTO = '0 7-19 * * *'; 
        console.log(`Agendado para: [${AGENDAMENTO}]`);

        cron.schedule(AGENDAMENTO, () => {
            console.log(`\n--- [${new Date().toLocaleString()}] --- Executando rotina cron.`);
            verificarSincronia(client);
        });
    });

    client.on('auth_failure', msg => {
        console.error('Falha na autenticação do WhatsApp!', msg);
    });

    client.initialize();
}

iniciarBot();