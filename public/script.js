const socket = io();

// WhatsApp Elements
const qrcodeContainer = document.getElementById('qrcode-container');
const waStatus = document.getElementById('wa-status');
const btnWaReset = document.getElementById('btn-wa-reset');
const btnWaDisconnect = document.getElementById('btn-wa-disconnect');

// System Elements
const logsContainer = document.getElementById('logs-container');
const totalPostosSpan = document.getElementById('total-postos');
const globalStatus = document.getElementById('global-status');

// Form Elements
const postoForm = document.getElementById('posto-form');
const postosGrid = document.getElementById('postos-grid');
const btnTest = document.getElementById('btn-test');
const alertaForm = document.getElementById('alerta-form');
const alertasList = document.getElementById('alertas-list');
const alertaInput = document.getElementById('alerta-numero');

// --- WhatsApp Events ---
socket.on('qr', (qr) => {
    qrcodeContainer.innerHTML = '';
    const canvas = document.createElement('canvas');
    QRCode.toCanvas(canvas, qr, { width: 220, margin: 2 }, function (error) {
        if (error) console.error(error);
        qrcodeContainer.appendChild(canvas);
    });
});

socket.on('wa_status', (status) => {
    if (status.ready) {
        waStatus.textContent = 'Online';
        waStatus.className = 'status-badge online';
        qrcodeContainer.innerHTML = `
            <div style="color: #10b981; font-weight: 700; text-align: center; animation: fadeIn 0.5s ease-out;">
                <div style="font-size: 2.5rem; margin-bottom: 10px;">✅</div>
                <div style="font-size: 1.1rem; margin-bottom: 5px;">Conectado</div>
                <div style="font-size: 0.9rem; opacity: 0.7; font-family: monospace;">${status.number}</div>
            </div>
        `;
    } else {
        waStatus.textContent = 'Desconectado';
        waStatus.className = 'status-badge offline';
        qrcodeContainer.innerHTML = '<p style="text-align: center; opacity: 0.5;">Aguardando QR Code...</p>';
    }
});

// --- WhatsApp Actions ---
btnWaReset.onclick = async () => {
    if (confirm('Deseja forçar a geração de um novo QR Code?')) {
        const res = await fetch('/api/wa/reset', { method: 'POST' });
        if (res.ok) {
            alert('Reiniciando cliente WhatsApp...');
        }
    }
};

btnWaDisconnect.onclick = async () => {
    if (confirm('Tem certeza que deseja desconectar este número?')) {
        const res = await fetch('/api/wa/disconnect', { method: 'POST' });
        if (res.ok) {
            alert('WhatsApp desconectado com sucesso.');
        }
    }
};

// --- Logs ---
socket.on('log', (msg) => {
    const p = document.createElement('p');
    const time = new Date().toLocaleTimeString('pt-BR');
    p.innerHTML = `<span style="opacity: 0.4;">[${time}]</span> ${msg}`;
    logsContainer.appendChild(p);
    logsContainer.scrollTop = logsContainer.scrollHeight;

    // Limitar logs na tela
    if (logsContainer.children.length > 50) {
        logsContainer.removeChild(logsContainer.firstChild);
    }
});

// --- Auth System ---
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');

function checkAuth() {
    const token = localStorage.getItem('sinc_token');
    if (token) {
        loginOverlay.style.display = 'none';
        document.querySelector('.container').style.display = 'block';
        socket.emit('auth', token);
    } else {
        loginOverlay.style.display = 'flex';
        document.querySelector('.container').style.display = 'none';
    }
}

loginForm.onsubmit = async (e) => {
    e.preventDefault();
    const user = document.getElementById('login-user').value;
    const pass = document.getElementById('login-pass').value;

    const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, pass })
    });

    if (res.ok) {
        const data = await res.json();
        localStorage.setItem('sinc_token', data.token);
        loginOverlay.style.display = 'none';
        document.querySelector('.container').style.display = 'block';
        carregarPostos();
        carregarAlertas();
    } else {
        alert('❌ Credenciais incorretas!');
    }
};

// --- Logout ---
const btnLogout = document.getElementById('btn-logout');
if (btnLogout) {
    btnLogout.onclick = () => {
        if (confirm('Deseja realmente sair do sistema?')) {
            localStorage.removeItem('sinc_token');
            location.reload(); // Recarrega para voltar à tela de login
        }
    };
}

// --- Modal Config ---
const configModal = document.getElementById('config-modal');
const btnOpenConfig = document.getElementById('btn-open-config');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnCancelPosto = document.getElementById('btn-cancel-posto');
const modalTitle = document.getElementById('modal-title');

function abrirModal(id = null) {
    if (id) {
        modalTitle.textContent = 'Editar Configurações';
        prepararEdicao(id);
    } else {
        modalTitle.textContent = 'Configurar Novo Banco';
        cancelarEdicao();
    }
    configModal.style.display = 'flex';
}

function fecharModal() {
    configModal.style.display = 'none';
    cancelarEdicao();
}

if (btnOpenConfig) btnOpenConfig.onclick = () => abrirModal();
if (btnCloseModal) btnCloseModal.onclick = fecharModal;
if (btnCancelPosto) btnCancelPosto.onclick = fecharModal;

window.onclick = (event) => {
    if (event.target == configModal) fecharModal();
};

// --- Postos CRUD (Extended) ---
async function carregarPostos() {
    try {
        const res = await fetch('/api/postos');
        if (res.status === 401) return checkAuth();
        const postos = await res.json();
        totalPostosSpan.textContent = `${postos.length} POSTOS CADASTRADOS`;
        renderPostos(postos);
    } catch (e) {
        console.error('Erro ao carregar postos:', e);
    }
}

function renderPostos(postos) {
    postosGrid.innerHTML = '';
    postos.forEach(p => {
        const div = document.createElement('div');
        div.className = 'posto-card';
        div.id = `card-${p.id}`;
        div.innerHTML = `
            <div class="posto-header">
                <div class="posto-title">
                    <h3>${p.nome}</h3>
                    <p>${p.host}</p>
                </div>
                <div class="posto-main-status">
                    <span id="sinc-${p.id}" class="sincronia-time">--:--:--</span>
                    <span id="check-${p.id}" class="last-check">Aguardando...</span>
                </div>
            </div>

            <div id="hosts-${p.id}" class="hosts-list">
                <!-- Hosts individuais aqui -->
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: auto;">
                <button onclick="abrirModal('${p.id}')" class="secondary" style="padding: 0.4rem 0.6rem; font-size: 0.7rem;">⚙️ EDITAR</button>
                <button onclick="removerPosto('${p.id}')" class="danger" style="padding: 0.4rem 0.6rem; font-size: 0.7rem;">REMOVER</button>
            </div>
        `;
        postosGrid.appendChild(div);
    });
}

let editandoId = null;

function prepararEdicao(id) {
    fetch('/api/postos')
        .then(res => res.json())
        .then(postos => {
            const p = postos.find(posto => posto.id === id);
            if (p) {
                document.getElementById('nome').value = p.nome;
                document.getElementById('host').value = p.host;
                document.getElementById('port').value = p.port;
                document.getElementById('user').value = p.user;
                document.getElementById('password').value = p.password;
                document.getElementById('database').value = p.database;
                document.getElementById('frequencia').value = p.frequencia || "5";
                editandoId = id;
            }
        });
}

function cancelarEdicao() {
    editandoId = null;
    postoForm.reset();
}

postoForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.textContent;
    btn.textContent = 'Salvando...';
    btn.disabled = true;

    const data = {
        nome: document.getElementById('nome').value,
        host: document.getElementById('host').value,
        port: document.getElementById('port').value,
        user: document.getElementById('user').value,
        password: document.getElementById('password').value,
        database: document.getElementById('database').value,
        frequencia: document.getElementById('frequencia').value,
    };

    try {
        const url = editandoId ? `/api/postos/${editandoId}` : '/api/postos';
        const method = editandoId ? 'PUT' : 'POST';

        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (res.ok) {
            alert(editandoId ? '✅ Posto atualizado!' : '✅ Posto salvo!');
            fecharModal();
            carregarPostos();
        }
    } catch (err) {
        alert('❌ Erro de rede ou servidor offline.');
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
};

btnTest.onclick = async () => {
    const data = {
        host: document.getElementById('host').value,
        port: document.getElementById('port').value,
        user: document.getElementById('user').value,
        password: document.getElementById('password').value,
        database: document.getElementById('database').value,
    };

    const originalText = btnTest.textContent;
    btnTest.textContent = 'Testando...';
    btnTest.disabled = true;

    try {
        const res = await fetch('/api/test-connection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        const result = await res.json();

        if (res.ok && result.success) {
            alert('✅ Conexão bem sucedida!');
        } else {
            alert(result.error || '❌ Erro na conexão.');
        }
    } catch (e) {
        console.error('Erro de rede detalhado:', e);
        alert(`❌ Erro de rede: ${e.message}\nVerifique se o servidor está online no IP:3000.`);
    } finally {
        btnTest.textContent = originalText;
        btnTest.disabled = false;
    }
};

async function removerPosto(id) {
    if (confirm('Deseja remover este posto do monitoramento?')) {
        await fetch(`/api/postos/${id}`, { method: 'DELETE' });
        carregarPostos();
    }
}

// --- Alertas Management ---
async function carregarAlertas() {
    const res = await fetch('/api/alertas');
    const alertas = await res.json();
    renderAlertas(alertas);
}

function renderAlertas(alertas) {
    alertasList.innerHTML = '';
    if (alertas.length === 0) {
        alertasList.innerHTML = '<p style="font-size: 0.7rem; opacity: 0.4; text-align: center;">Nenhum número cadastrado.</p>';
        return;
    }
    alertas.forEach(num => {
        const div = document.createElement('div');
        div.className = 'alert-item';
        div.innerHTML = `
            <span>${num}</span>
            <button onclick="removerAlerta('${num}')" style="background: none; color: #fb7185; cursor: pointer; padding: 0;">&times;</button>
        `;
        alertasList.appendChild(div);
    });
}

alertaForm.onsubmit = async (e) => {
    e.preventDefault();
    const numero = alertaInput.value.trim();
    if (!numero) return;

    const res = await fetch('/api/alertas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numero })
    });

    if (res.ok) {
        alertaInput.value = '';
        carregarAlertas();
    }
};

async function removerAlerta(numero) {
    if (confirm(`Remover ${numero}?`)) {
        await fetch('/api/alertas', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ numero })
        });
        carregarAlertas();
    }
}

// --- Status Update ---
socket.on('status_posto', (data) => {
    const checkText = document.getElementById(`check-${data.id}`);
    const sincText = document.getElementById(`sinc-${data.id}`);
    const hostsList = document.getElementById(`hosts-${data.id}`);

    if (checkText) checkText.textContent = 'visto ' + data.lastCheck.split(',')[1].trim();

    if (sincText && data.hosts && data.hosts.length > 0) {
        const timestamps = data.hosts.map(h => new Date(h.ts).getTime());
        const lastSyncTime = new Date(Math.max(...timestamps));
        sincText.textContent = lastSyncTime.toLocaleTimeString('pt-BR');
        sincText.className = 'sincronia-time' + (data.status === 'atrasado' ? ' atrasado' : '');
    }

    if (hostsList && data.hosts) {
        hostsList.innerHTML = data.hosts.map(h => `
            <div class="host-item">
                <div class="host-info">
                    <span class="name">${h.nome}</span>
                    <span class="atraso">Atraso: ${h.atraso}</span>
                </div>
                <span class="status-dot ${h.online ? 'online' : 'offline'}"></span>
            </div>
        `).join('');
    }
});

// Init
checkAuth();
carregarPostos();
carregarAlertas();
