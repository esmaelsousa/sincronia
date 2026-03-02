const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { Client: PgClient } = require('pg'); // Renomeado para evitar conflito de nome
const cron = require('node-cron'); // Correto

// --- Configuração do WhatsApp ---
const LISTA_NUMEROS_ALERTA = [
    '557491414996@c.us',
    '557491985228@c.us',
    '557591361080@c.us',
	'557481078575@c.us',
    // '55YYYYYYYYYY@c.us'  // <-- Pode adicionar mais
];

// --- Configuração do Banco ---
const dbConfig = {
    user: 'postgres',
    host: 'node231575-redeitatiaia.sp1.br.saveincloud.net.br',
    database: 'autosystem',
    password: '@Office0312',
    port: 16463,
};

// --- Configuração do Monitoramento ---
// const INTERVALO_VERIFICACAO_MS = 5 * 60 * 1000; // Esta linha não é mais necessária com o node-cron

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

/**
 * Função de verificação do banco. (CORRIGIDA)
 */
async function verificarSincronia(waClient) {
    const pgClient = new PgClient(dbConfig);
    
    try {
        await pgClient.connect();
        const res = await pgClient.query(QUERY_SYNC);
        console.log(`[${new Date().toLocaleString()}] Verificando sincronia...`);

        if (res.rows.length === 0) {
            console.log('Nenhum host encontrado para verificar.');
            return;
        }

        for (const row of res.rows) {
            const atraso = Number(row.atraso);
            const nome = row.nome || 'Host Desconhecido';
			const ts = row.ts;
            let mensagemAlerta = ''; // Começa vazia

            if (atraso > 1000000) {
                // Nível CRÍTICO
                mensagemAlerta = `🔥 ALERTA CRÍTICO 🔥\n\nSincronia muito atrasada!\n*Host:* ${nome}\n*Atraso:* ${atraso} \n Data: ${ts}`;
                console.error(mensagemAlerta);

            } else if (atraso >= 500000) { 
                // Nível ALTO
                mensagemAlerta = `🟠 ALERTA ALTO 🟠\n\nSincronia atrasada.\n*Host:* ${nome}\n*Atraso:* ${atraso} \n Data: ${ts}`;
                console.warn(mensagemAlerta);

            } else if (atraso >= 100000) {
                // Nível AVISO (Agora também envia WhatsApp)
                mensagemAlerta = `⚠️ AVISO ⚠️\n\nSincronia com atraso.\n*Host:* ${nome}\n*Atraso:* ${atraso} \n Data: ${ts}`;
                console.warn(mensagemAlerta); // (Agora usamos a varíavel para logar)
            
            } else {
                // Nível OK
				mensagemAlerta = `Sincronia OK \n\nSincronia sem atraso.`;
                console.log(`OK: Host ${nome} (Atraso: ${atraso}).`);
            }

            // Se houver uma mensagem de alerta (Crítico, Alto ou Aviso), envie
            if (mensagemAlerta) {
                await enviarNotificacao(waClient, mensagemAlerta);
            }
        }
    } catch (error) {
        console.error('Erro ao verificar sincronia:', error.message);
        await enviarNotificacao(waClient, `🚨 ERRO NO SCRIPT DE MONITORAMENTO 🚨\n\nNão foi possível verificar a sincronia do banco.\n\nErro: ${error.message}`);
    } finally {
        await pgClient.end();
    }
}


/**
 * Função helper para enviar notificação de WhatsApp
 * (Atualizada para enviar para múltiplos números)
 */
async function enviarNotificacao(waClient, mensagem) {
    
    // Itera sobre cada número na lista de alertas
    for (const numero of LISTA_NUMEROS_ALERTA) {
        try {
            await waClient.sendMessage(numero, mensagem);
            console.log(`Notificação enviada com sucesso para ${numero}`);
        } catch (error) {
            console.error(`Erro ao enviar notificação para ${numero}:`, error.message);
            // Continua tentando os outros números mesmo se um falhar
        }
    }
}

/**
 * Função principal para iniciar o Bot
 */
function iniciarBot() {
    console.log('Iniciando cliente whatsapp-web.js...');
    
    // Usa 'LocalAuth' para salvar a sessão automaticamente na pasta ./.wwebjs_auth/
    const client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            // Correção para alguns sistemas Windows
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        }
    });

    // Evento disparado para gerar o QR Code
    client.on('qr', (qr) => {
        console.log('QR Code recebido! Escaneie com seu celular:');
        qrcode.generate(qr, { small: true }); // Mostra o QR no terminal
    });

    // ####################################################################
    // # ATUALIZADO AQUI #
    // # (Lógica 'start' movida para 'ready' e usando 'node-cron') #
    // ####################################################################

    // Evento disparado quando o bot está 100% pronto
    client.on('ready', () => {
        console.log('\n✅ Cliente WhatsApp pronto! Iniciando monitoramento agendado.');
        
        // 1. Envia a mensagem de "Iniciado" (apenas uma vez)
        enviarNotificacao(client, '🤖 Monitoramento de Sincronia Rede Itatiaia V2 iniciado com sucesso! 🤖');
        
        // 2. Roda a verificação pela primeira vez (bom para testar)
        console.log('Executando verificação inicial...');
        verificarSincronia(client);

        // 3. Agenda a verificação periódica usando CRON
        
        // AGENDAMENTO: '0 7-19 * * *'
        // Significa: no minuto 0 (hora cheia), da hora 7 até a hora 19,
        // todos os dias, todos os meses.
        
        const AGENDAMENTO = '0 7-19 * * *'; 
        console.log(`Verificação agendada com o padrão cron: [${AGENDAMENTO}]`);

        cron.schedule(AGENDAMENTO, () => {
            console.log(`\n--- [${new Date().toLocaleString()}] ---`);
            console.log('Executando verificação agendada (das 7h às 19h)...');
            verificarSincronia(client);
        });
        
        // O antigo 'setInterval' foi removido.
    });

    // Evento em caso de falha na autenticação
    client.on('auth_failure', msg => {
        console.error('Falha na autenticação do WhatsApp!', msg);
    });

    // Inicia o cliente
    client.initialize();
}

// --- Iniciar tudo ---
iniciarBot();