// --- MODO OSCURO ---
function toggleTheme() {
    const html = document.documentElement;
    const icon = document.getElementById('theme-icon');
    
    if (html.classList.contains('dark')) {
        html.classList.remove('dark');
        icon.classList.remove('fa-sun');
        icon.classList.add('fa-moon');
        localStorage.setItem('theme', 'light');
    } else {
        html.classList.add('dark');
        icon.classList.remove('fa-moon');
        icon.classList.add('fa-sun');
        localStorage.setItem('theme', 'dark');
    }
}

// Cargar preferencia de tema al iniciar
(function loadTheme() {
    const savedTheme = localStorage.getItem('theme');
    const icon = document.getElementById('theme-icon');
    if (savedTheme === 'dark') {
        document.documentElement.classList.add('dark');
        icon.classList.remove('fa-moon');
        icon.classList.add('fa-sun');
    }
})();

// --- LÓGICA DE TRADING ---
let currentData = { tps: [], sls: [] };

const datePicker = document.getElementById('datePicker');
const today = new Date().toISOString().split('T')[0];
datePicker.value = today;

// Abrir el selector de fecha al pulsar la caja (soporta showPicker cuando está disponible)
(function enableDateWrapper() {
    const wrapper = document.getElementById('date-picker-wrapper');
    if (!wrapper) return;

    const openPicker = (e) => {
        // Evitar que el evento afecte a otros controles
        e.preventDefault();
        if (typeof datePicker.showPicker === 'function') {
            try { datePicker.showPicker(); } catch (err) { datePicker.focus(); }
        } else {
            datePicker.focus();
        }
    };

    wrapper.addEventListener('click', openPicker);
    // Soporte teclado (Enter / Space)
    wrapper.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
            openPicker(ev);
        }
    });
})();

// Inicializar: carga rápida local y luego Firestore si está disponible
loadData();
// Si hay datos locales pendientes, mostrar el botón de sincronizar (aunque no haya auth aún)
try {
    const syncBtnInit = document.getElementById('btn-sync-now');
    if (syncBtnInit && getLocalTradingKeys && getLocalTradingKeys().length > 0) {
        syncBtnInit.classList.remove('hidden');
    }
} catch(e) { /* ignore if DOM not ready or function missing */ }
// Intentar cargar desde Firestore cuando esté listo
window.addEventListener('firebase-auth-ready', async () => {
    // intenta cargar datos desde Firestore y actualizar UI
    try { await loadDataFirestore(); } catch (e) { /* ignore */ }
    // actualizar visibilidad de botones auth
    updateAuthUI();

    // Si el usuario está autenticado con cuenta (no anónima) y hay datos locales,
    // mostrar aviso y habilitar botón de 'Sincronizar ahora' para migrar local->Firestore.
    try {
        const uid = window._firebase && window._firebase.uid;
        const user = window._firebase && window._firebase.auth && window._firebase.auth.currentUser;
        const syncBtn = document.getElementById('btn-sync-now');
        const localKeys = getLocalTradingKeys();
        if (syncBtn) syncBtn.classList.add('hidden');

        if (uid && user && !user.isAnonymous) {
            // mostrar botón si hay datos locales pendientes
            if (localKeys.length > 0) {
                if (syncBtn) syncBtn.classList.remove('hidden');
                showToast('Se han detectado datos locales. Pulsa "Sincronizar ahora" para subirlos a tu cuenta.', 'info', 5000);
            }
        }
    } catch (e) {
        console.warn('Error comprobando migración local->firestore', e);
    }
});

// También intenta cuando firebase-init.js fue cargado antes
if (window._firebase && window._firebase.uid !== undefined) {
    // small delay to let auth settle
    setTimeout(() => { loadDataFirestore().catch(()=>{}); updateAuthUI(); }, 200);
}

datePicker.addEventListener('change', () => {
    loadData();
    if(!document.getElementById('summaries-section').classList.contains('hidden')){
        generateSummaries();
    }
});

function loadData() {
    const date = datePicker.value;
    const storageKey = `trading_${date}`;
    const stored = localStorage.getItem(storageKey);
    currentData = stored ? JSON.parse(stored) : { tps: [], sls: [] };
    renderUI();
}

// Carga desde Firestore si hay auth/db, y reemplaza currentData
// Además, gestiona un listener en tiempo real para sincronizar entre dispositivos.
let _unsubscribeJournalListener = null;

async function loadDataFirestore() {
    const date = datePicker.value;
    if (!window._firebase || !window._firebase.db) return;

    if (!window._firebase.uid) {
        await new Promise(res => {
            window.addEventListener('firebase-auth-ready', res, { once: true });
        });
    }

    const uid = window._firebase.uid;
    if (!uid) return;

    const db = window._firebase.db;
    const docRef = window.firebaseFirestoreDoc(db, 'users', uid, 'journals', date);

    try {
        // 1) Leer una vez para inicializar la UI
        const snap = await window.firebaseFirestoreGetDoc(docRef);
        if (snap && snap.exists && snap.exists()) {
            currentData = snap.data() || { tps: [], sls: [] };
        } else {
            currentData = { tps: [], sls: [] };
        }
        renderUI();

        // 2) Limpiar cualquier listener anterior
        if (typeof _unsubscribeJournalListener === 'function') {
            _unsubscribeJournalListener();
            _unsubscribeJournalListener = null;
        }

        // 3) Suscribirse en tiempo real al documento actual
        if (window.firebaseFirestoreOnSnapshot) {
            _unsubscribeJournalListener = window.firebaseFirestoreOnSnapshot(
                docRef,
                (docSnap) => {
                    try {
                        if (docSnap && docSnap.exists && docSnap.exists()) {
                            const data = docSnap.data() || { tps: [], sls: [] };
                            // Evitar re-render innecesario si no cambió nada
                            const serializedNew = JSON.stringify({
                                tps: data.tps || [],
                                sls: data.sls || []
                            });
                            const serializedCurrent = JSON.stringify({
                                tps: currentData.tps || [],
                                sls: currentData.sls || []
                            });
                            if (serializedNew !== serializedCurrent) {
                                currentData = {
                                    tps: data.tps || [],
                                    sls: data.sls || []
                                };
                                // No tocar localStorage aquí para no pisar datos offline propios
                                renderUI();
                                if(!document.getElementById('summaries-section').classList.contains('hidden')){
                                    generateSummaries();
                                }
                            }
                        }
                    } catch (err) {
                        console.warn('Error procesando snapshot en tiempo real', err);
                    }
                },
                (err) => {
                    console.warn('Listener en tiempo real cancelado / con error:', err);
                }
            );
        }
    } catch (err) {
        console.error('Error cargando desde Firestore', err);
    }
}

let __pendingSave = null;

async function saveData() {
    const date = datePicker.value;
    const storageKey = `trading_${date}`;
    // Siempre mantén un cache local por velocidad
    localStorage.setItem(storageKey, JSON.stringify(currentData));
    renderUI();

    // Generar resúmenes si están visibles
    if(!document.getElementById('summaries-section').classList.contains('hidden')){
        generateSummaries();
    }

    // Intentar guardar en Firestore de forma fiable: asegurar red y auth
    try {
        if (!window._firebase || !window._firebase.db) {
            // no hay firestore inicializado
            return;
        }
        // Si no hay uid aún, esperar al event firebase-auth-ready (pero no bloquear mucho)
        if (!window._firebase.uid) {
            await new Promise(res => {
                const t = setTimeout(res, 1500); // timeout para no bloquear indefinidamente
                window.addEventListener('firebase-auth-ready', () => { clearTimeout(t); res(); }, { once: true });
            });
        }

        // Si tras espera no hay uid, no intentamos guardar en Firestore
        if (!window._firebase.uid) return;

        // marcar estado pendiente y actualizar UI
        __pendingSave = saveDataFirestoreWithNetwork();
        const statusSync = document.getElementById('auth-sync');
        if (statusSync) {
            statusSync.classList.remove('bg-green-400','bg-red-400','bg-gray-400');
            statusSync.classList.add('animate-pulse','bg-yellow-400');
            statusSync.title = 'Guardando...';
        }

        await __pendingSave;

        // éxito
        if (statusSync) {
            statusSync.classList.remove('animate-pulse','bg-yellow-400');
            statusSync.classList.add('bg-green-400');
            statusSync.title = 'Sincronización OK';
        }
        showToast('Guardado en Firestore', 'success', 1800);
    } catch (err) {
        console.warn('No se pudo guardar en Firestore:', err);
        const statusSync = document.getElementById('auth-sync');
        if (statusSync) {
            statusSync.classList.remove('animate-pulse','bg-yellow-400','bg-green-400');
            statusSync.classList.add('bg-red-400');
            statusSync.title = 'Error sincronizando';
        }
        showToast('Error al guardar en la nube', 'error', 4000);
    } finally {
        __pendingSave = null;
    }
}

// Envoltorio que se asegura que Firestore esté online antes de hacer setDoc
async function saveDataFirestoreWithNetwork() {
    // asegurar que la red de Firestore está habilitada (si existe helper)
    try {
        if (window.ensureFirestoreOnline) await window.ensureFirestoreOnline();
    } catch (e) {
        console.warn('No se pudo forzar enableNetwork antes de guardar:', e);
    }
    return saveDataFirestore();
}

// Guarda en Firestore (async)
async function saveDataFirestore() {
    const date = datePicker.value;
    if (!window._firebase || !window._firebase.db) return;
    if (!window._firebase.uid) {
        // esperar auth
        await new Promise(res => window.addEventListener('firebase-auth-ready', res, { once: true }));
    }
    const uid = window._firebase.uid;
    if (!uid) return;
    const db = window._firebase.db;
    try {
        const docRef = window.firebaseFirestoreDoc(db, 'users', uid, 'journals', date);
        await window.firebaseFirestoreSetDoc(docRef, currentData);
    } catch (err) {
        console.error('Error guardando en Firestore', err);
        throw err;
    }
}

// --- MIGRACIÓN localStorage -> Firestore ---
function getLocalTradingKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        const m = k.match(/^trading_(\d{4}-\d{2}-\d{2})$/);
        if (m) keys.push(m[1]);
    }
    return keys.sort();
}

async function migrateLocalToFirestore(confirmIfNeeded = true) {
    const localDates = getLocalTradingKeys();
    if (localDates.length === 0) {
        showToast('No hay datos locales para sincronizar', 'info');
        return;
    }

    const uid = window._firebase && window._firebase.uid;
    if (!uid) {
        showToast('Necesitas iniciar sesión para sincronizar', 'error');
        return;
    }

    if (confirmIfNeeded) {
        const ok = await showConfirmModal(`Se encontraron ${localDates.length} día(s) con datos en este navegador. ¿Deseas subirlos a tu cuenta en la nube?`);
        if (!ok) return;
    }

    try {
        if (window.ensureFirestoreOnline) await window.ensureFirestoreOnline();
    } catch (e) {
        console.warn('No se pudo asegurar red antes de migrar:', e);
    }

    const db = window._firebase.db;
    let migrated = 0;
    for (const dateKey of localDates) {
        try {
            const raw = localStorage.getItem(`trading_${dateKey}`);
            if (!raw) continue;
            const data = JSON.parse(raw);

            const docRef = window.firebaseFirestoreDoc(db, 'users', uid, 'journals', dateKey);
            const snap = await window.firebaseFirestoreGetDoc(docRef);
            if (snap && snap.exists && snap.exists()) {
                // Si ya existe en Firestore y no está vacío, saltar
                const existing = snap.data();
                const emptyExisting = (!existing || ((!existing.tps || existing.tps.length===0) && (!existing.sls || existing.sls.length===0)));
                const emptyLocal = ((!data.tps || data.tps.length===0) && (!data.sls || data.sls.length===0));
                if (!emptyExisting) {
                    console.log('Saltando', dateKey, 'ya existe en Firestore');
                    continue;
                }
                if (emptyLocal) continue;
            }

            await window.firebaseFirestoreSetDoc(docRef, data);
            migrated++;
        } catch (err) {
            console.warn('Error migrando', dateKey, err);
        }
    }

    if (migrated > 0) showToast(`Sincronizados ${migrated} día(s) a Firestore`, 'success');
    else showToast('No se migraron datos (ya existían o estaban vacíos)', 'info');

    // refrescar UI con datos desde Firestore si el datePicker cae en un día migrado
    await loadDataFirestore();
}

// Handler público llamado desde el botón 'Sincronizar ahora'
function promptMigrateLocalToFirestore() {
    const uid = window._firebase && window._firebase.uid;
    if (!uid) {
        // pedir al usuario que inicie sesión con Google para sincronizar entre dispositivos
        showConfirmModal('Para sincronizar entre dispositivos necesitas iniciar sesión. ¿Deseas iniciar sesión con Google ahora?').then(ok => {
            if (ok) {
                try {
                    signInWithGoogle();
                    // after auth, the firebase-auth-ready listener will suggest sync again
                    showToast('Tras iniciar sesión, pulsa de nuevo "Sincronizar ahora" para subir los datos locales.', 'info', 5000);
                } catch (err) {
                    console.error('Error iniciando signInWithGoogle desde prompt:', err);
                    showToast('No se pudo iniciar sesión con Google', 'error');
                }
            }
        });
        return;
    }

    migrateLocalToFirestore(true).catch(err => {
        console.error('migrateLocalToFirestore error', err);
        showToast('Error durante la sincronización', 'error');
    });
}

function addEntry(type) {
    const inputId = type === 'tp' ? 'tp-input' : 'sl-input';
    const assetId = type === 'tp' ? 'tp-asset' : 'sl-asset'; // ID del Activo

    const input = document.getElementById(inputId);
    const assetInput = document.getElementById(assetId);

        const btnRegister = document.getElementById('btn-register');
    const value = parseFloat(input.value);
    const asset = assetInput.value.trim().toUpperCase(); // Obtener activo

    if (!value || value <= 0) {
        showToast('Ingresa un porcentaje válido', 'error');
        return;
    }

    const entry = { 
        id: Date.now(), 
        value: value, 
        asset: asset || '---' // Guardar activo o guiones si está vacío
    };

    if (type === 'tp') currentData.tps.push(entry);
    else currentData.sls.push(entry);

    input.value = '';
    assetInput.value = ''; // Limpiar campo activo
    saveData();
}

function deleteEntry(type, id) {
    if (type === 'tp') currentData.tps = currentData.tps.filter(item => item.id !== id);
    else currentData.sls = currentData.sls.filter(item => item.id !== id);
    saveData();
}

// Inicio de edición inline: muestra input + botones
function startEdit(type, id) {
    // Cerrar cualquier editor abierto
    document.querySelectorAll('.inline-editor').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.value-span').forEach(el => el.classList.remove('hidden'));

    const valueSpan = document.getElementById(`value-${type}-${id}`);
    const editor = document.getElementById(`editor-${type}-${id}`);
    if (!valueSpan || !editor) return;

    valueSpan.classList.add('hidden');
    editor.classList.remove('hidden');
    const inputs = editor.querySelectorAll('input');
    const assetInput = inputs[0];
    const valueInput = inputs[1];
    const assetSpan = document.getElementById(`asset-${type}-${id}`);
    if (assetInput) {
        assetInput.value = assetSpan ? assetSpan.innerText.trim() : '';
    }
    if (valueInput) {
        valueInput.value = valueSpan.dataset.value || valueSpan.innerText.replace('%','').replace('+','').replace('-','').trim();
        valueInput.focus();
        valueInput.select();
    }
}

function cancelEdit(type, id) {
    const valueSpan = document.getElementById(`value-${type}-${id}`);
    const editor = document.getElementById(`editor-${type}-${id}`);
    if (!valueSpan || !editor) return;
    editor.classList.add('hidden');
    valueSpan.classList.remove('hidden');
}

function saveEdit(type, id) {
    const list = type === 'tp' ? currentData.tps : currentData.sls;
    const item = list.find(i => i.id === id);
    if (!item) return;

    const editor = document.getElementById(`editor-${type}-${id}`);
    if (!editor) return;
    const inputs = editor.querySelectorAll('input');
    const assetInput = inputs[0];
    const valueInput = inputs[1];
    if (!valueInput) return;

    const newValue = parseFloat(valueInput.value);
    if (isNaN(newValue) || newValue <= 0) {
        showToast('Porcentaje inválido', 'error');
        return;
    }

    // Actualizar asset si se proporcionó
    if (assetInput) {
        const newAsset = assetInput.value.trim().toUpperCase();
        item.asset = newAsset || '---';
    }

    item.value = newValue;
    saveData();
}

async function clearList(type) {
    const ok = await showConfirmModal('¿Borrar historial de esta columna?');
    if (ok) {
        if (type === 'tp') currentData.tps = [];
        else currentData.sls = [];
        saveData();
        showToast('Historial borrado', 'success');
    }
}

async function clearAll() {
    const ok = await showConfirmModal('¿Limpiar datos de hoy?');
    if (ok) {
        currentData = { tps: [], sls: [] };
        saveData();
        showToast('Datos de hoy limpiados', 'success');
    }
}

// --- RENDERIZADO UI ---
function renderUI() {
    renderList('tp', currentData.tps);
    renderList('sl', currentData.sls);
    updateTotals();
}

function renderList(type, list) {
    const container = document.getElementById(type === 'tp' ? 'tp-list' : 'sl-list');
    container.innerHTML = '';

    if (list.length === 0) {
        container.innerHTML = '<div class="text-center text-slate-300 dark:text-slate-600 text-sm py-4">No hay registros</div>';
        return;
    }

    const valueColor = type === 'tp' ? 'text-green-500 dark:text-green-400' : 'text-red-500 dark:text-red-400';
    const sign = type === 'tp' ? '+' : '-';

    list.forEach(item => {
        const row = document.createElement('div');
        row.className = "flex justify-between items-center py-2 px-3 rounded hover:bg-slate-50 dark:hover:bg-slate-700/50 border border-transparent hover:border-slate-100 dark:hover:border-slate-600 transition group";
        row.innerHTML = `
            <div class="flex items-center gap-3">
                <span id="asset-${type}-${item.id}" class="font-bold text-slate-700 dark:text-slate-200 text-xs bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded">${item.asset}</span>
                <span id="value-${type}-${item.id}" data-value="${item.value}" class="value-span font-bold ${valueColor} text-sm">${sign}${item.value.toFixed(2)}%</span>
                <div id="editor-${type}-${item.id}" class="inline-editor hidden flex items-center gap-2">
                    <input type="text" class="w-20 px-2 py-1 rounded text-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100" placeholder="PAR" />
                    <input type="number" step="0.01" min="0.01" class="w-20 px-2 py-1 rounded text-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100" />
                    <button onclick="saveEdit('${type}', ${item.id})" title="Guardar" class="text-black dark:text-white bg-slate-200 dark:bg-slate-700 px-2 py-1 rounded"><i class="fa-solid fa-floppy-disk"></i></button>
                    <button onclick="cancelEdit('${type}', ${item.id})" title="Cancelar" class="text-slate-500 px-2 py-1 rounded"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onclick="startEdit('${type}', ${item.id})" title="Editar" class="text-slate-400 hover:text-slate-200 text-xs"><i class="fa-solid fa-pen-to-square"></i></button>
                <button onclick="deleteEntry('${type}', ${item.id})" title="Eliminar" class="text-red-300 hover:text-red-500 text-xs"><i class="fa-solid fa-xmark"></i></button>
            </div>
        `;
        container.appendChild(row);
    });
}

function updateTotals() {
    const tpTotal = currentData.tps.reduce((acc, curr) => acc + curr.value, 0);
    const slTotal = currentData.sls.reduce((acc, curr) => acc + curr.value, 0);
    const net = tpTotal - slTotal;

    document.getElementById('tp-total-display').innerText = tpTotal.toFixed(2) + '%';
    document.getElementById('sl-total-display').innerText = slTotal.toFixed(2) + '%';
    document.getElementById('footer-tp').innerText = '+' + tpTotal.toFixed(2) + '%';
    document.getElementById('footer-sl').innerText = '-' + slTotal.toFixed(2) + '%';
    
    const netEl = document.getElementById('footer-net');
    const mainEl = document.getElementById('main-profit-display');

    let sign = net > 0 ? '+' : '';
    let colorClass = net > 0 ? 'text-green-500 dark:text-green-400' : (net < 0 ? 'text-red-500 dark:text-red-400' : 'text-slate-800 dark:text-slate-200');
    let icon = net >= 0 ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down';

    netEl.innerText = sign + net.toFixed(2) + '%';
    netEl.className = "font-bold text-lg " + colorClass;

    mainEl.innerHTML = `<i class="fa-solid ${icon} mr-2 text-sm ${colorClass}"></i> Profit Total: <span class="${colorClass}">${sign}${net.toFixed(2)}%</span>`;
}

// --- RESÚMENES ---
function toggleSummaries() {
    const section = document.getElementById('summaries-section');
    const btn = document.getElementById('btn-toggle-summary');
    
    section.classList.toggle('hidden');

    if (section.classList.contains('hidden')) {
        btn.innerHTML = '<i class="fa-solid fa-chart-column"></i> Ver Resúmenes';
    } else {
        btn.innerHTML = '<i class="fa-solid fa-eye-slash"></i> Ocultar Resúmenes';
        generateSummaries();
    }
}
async function generateSummaries() {
    const selectedDate = new Date(datePicker.value + "T00:00:00");
    const dayOfWeek = selectedDate.getDay() || 7; 
    
    const monday = new Date(selectedDate);
    monday.setDate(selectedDate.getDate() - dayOfWeek + 1);
    
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const options = { day: '2-digit', month: '2-digit' };
    const rangeText = `Semana ${monday.toLocaleDateString('es-ES', options)} - ${sunday.toLocaleDateString('es-ES', options)}/${monday.getFullYear()}`;
    document.getElementById('week-range-text').innerText = rangeText;

    let weeklyNet = 0;
    let totalDays = 0;
    let winDays = 0;
    let lossDays = 0;
    const dailyListContainer = document.getElementById('daily-summary-list');
    dailyListContainer.innerHTML = '';

    for (let i = 0; i < 7; i++) {
        const tempDate = new Date(monday);
        tempDate.setDate(monday.getDate() + i);
        const dateKey = tempDate.toISOString().split('T')[0];

        // Intentar leer desde Firestore si está disponible
        let data = null;
        if (window._firebase && window._firebase.db && window._firebase.uid) {
            try {
                const db = window._firebase.db;
                const uid = window._firebase.uid;
                const docRef = window.firebaseFirestoreDoc(db, 'users', uid, 'journals', dateKey);
                const snap = await window.firebaseFirestoreGetDoc(docRef);
                if (snap && snap.exists && snap.exists()) {
                    data = snap.data();
                }
            } catch (err) {
                console.warn('No se pudo leer desde Firestore para', dateKey, err);
            }
        }

        // Si no hay datos en Firestore, fallback a localStorage
        if (!data) {
            const rawData = localStorage.getItem(`trading_${dateKey}`);
            if (rawData) data = JSON.parse(rawData);
        }

        if (data) {
            const dailyTp = (data.tps || []).reduce((sum, item) => sum + item.value, 0);
            const dailySl = (data.sls || []).reduce((sum, item) => sum + item.value, 0);
            if ((data.tps && data.tps.length > 0) || (data.sls && data.sls.length > 0)) {
                const dailyNet = dailyTp - dailySl;
                weeklyNet += dailyNet;
                totalDays++;
                if (dailyNet > 0) winDays++;
                else if (dailyNet < 0) lossDays++;
                addDailyRow(tempDate, dailyTp, dailySl, dailyNet);
            }
        }
    }

    const weekNetEl = document.getElementById('week-net-total');
    weekNetEl.innerText = (weeklyNet > 0 ? '+' : '') + weeklyNet.toFixed(2) + '%';
    weekNetEl.className = "font-bold text-lg " + (weeklyNet > 0 ? 'text-green-500 dark:text-green-400' : (weeklyNet < 0 ? 'text-red-500 dark:text-red-400' : 'text-slate-800 dark:text-slate-200'));

    document.getElementById('week-total-days').innerText = totalDays;
    document.getElementById('week-win-days').innerText = winDays;
    document.getElementById('week-loss-days').innerText = lossDays;
    const winRate = totalDays > 0 ? (winDays / totalDays) * 100 : 0;
    document.getElementById('week-win-rate').innerText = winRate.toFixed(1) + '%';
}

function addDailyRow(dateObj, tp, sl, net) {
    const container = document.getElementById('daily-summary-list');
    const dateStr = dateObj.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    const dateCap = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);

    const netColor = net > 0 ? 'text-green-600 dark:text-green-400' : (net < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-300');
    const dotColor = net > 0 ? 'text-green-500' : (net < 0 ? 'text-red-500' : 'text-gray-300');
    const sign = net > 0 ? '+' : '';

    const div = document.createElement('div');
    div.className = "bg-slate-50 dark:bg-slate-700/50 rounded p-3 flex justify-between items-center border border-slate-100 dark:border-slate-600";
    div.innerHTML = `
        <div class="flex items-center gap-3">
            <i class="fa-solid fa-circle text-[10px] ${dotColor}"></i>
            <div>
                <div class="text-sm font-bold text-slate-700 dark:text-slate-200">${dateCap}</div>
                <div class="text-xs text-slate-400">TP: +${tp.toFixed(2)}% | SL: -${sl.toFixed(2)}%</div>
            </div>
        </div>
        <div class="font-bold ${netColor}">${sign}${net.toFixed(2)}%</div>
    `;
    container.appendChild(div);
}

/* --- MODALES Y TOASTS PERSONALIZADOS --- */
// Toast simple (info, success, error)
function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    const base = 'rounded px-3 py-2 shadow-md flex items-center gap-3 text-sm';
    let color = 'bg-slate-800 text-white';
    if (type === 'success') color = 'bg-green-600 text-white';
    if (type === 'error') color = 'bg-red-600 text-white';
    if (type === 'info') color = 'bg-slate-800 text-white';

    el.className = `${base} ${color}`;
    el.innerText = message;
    container.appendChild(el);
    setTimeout(() => {
        el.classList.add('opacity-0');
        setTimeout(() => el.remove(), 300);
    }, duration);
}

// Modal confirm/prompt básico que retorna Promise<boolean>
function showConfirmModal(message) {
    return new Promise(resolve => {
        const overlay = document.getElementById('modal-overlay');
        const msg = document.getElementById('modal-message');
        const btnOk = document.getElementById('modal-confirm');
        const btnCancel = document.getElementById('modal-cancel');
        if (!overlay || !msg || !btnOk || !btnCancel) return resolve(false);

        msg.innerText = message;
        overlay.classList.remove('hidden');

        const cleanup = () => {
            overlay.classList.add('hidden');
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
        };

        const onOk = () => { cleanup(); resolve(true); };
        const onCancel = () => { cleanup(); resolve(false); };

        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
    });
}

// Actualiza botones y estado de auth en la UI
function updateAuthUI() {
    const btnGoogle = document.getElementById('btn-google');
    const btnGoogleMobile = document.getElementById('btn-google-mobile');
    const btnRegister = document.getElementById('btn-register');
    const btnRegisterMobile = document.getElementById('btn-register-mobile');
    const btnSignout = document.getElementById('btn-signout');
    const btnSignoutMobile = document.getElementById('btn-signout-mobile');
    const btnSync = document.getElementById('btn-sync-now');
    const btnSyncMobile = document.getElementById('btn-sync-now-mobile');
    const status = document.getElementById('auth-status');
    const statusText = document.getElementById('auth-text');
    const statusUid = document.getElementById('auth-uid');
    const statusSync = document.getElementById('auth-sync');
    if (!status || !statusText || !statusUid || !statusSync) return;

    const a = window._firebase && window._firebase.auth;
    const uid = window._firebase && window._firebase.uid;

    // Mostrar u ocultar botones según estado
    if (a && uid) {
        // Desktop
        if (btnGoogle) btnGoogle.classList.add('hidden');
        if (btnRegister) btnRegister.classList.add('hidden');
        if (btnSignout) btnSignout.classList.remove('hidden');
        if (btnSync) btnSync.classList.remove('hidden');
        // Mobile
        if (btnGoogleMobile) btnGoogleMobile.classList.add('hidden');
        if (btnRegisterMobile) btnRegisterMobile.classList.add('hidden');
        if (btnSignoutMobile) btnSignoutMobile.classList.remove('hidden');
        if (btnSyncMobile) btnSyncMobile.classList.remove('hidden');
        status.classList.remove('hidden');

        const user = a.currentUser;
        // Si el usuario es anónimo, ofrecer la opción de registrarse (link con Google)
        if (user && user.isAnonymous) {
            statusText.innerText = 'Anon (anónimo)';
            if (btnRegister) btnRegister.classList.remove('hidden');
            if (btnRegisterMobile) btnRegisterMobile.classList.remove('hidden');
        } else if (user && !user.isAnonymous && user.email) {
            statusText.innerText = user.email;
            if (btnRegister) btnRegister.classList.add('hidden');
            if (btnRegisterMobile) btnRegisterMobile.classList.add('hidden');
        } else {
            statusText.innerText = 'Anon';
        }

        // Mostrar uid abreviado
        try {
            const short = String(uid).length > 12 ? `${uid.slice(0,6)}...${uid.slice(-4)}` : uid;
            statusUid.innerText = short;
        } catch (e) {
            statusUid.innerText = '';
        }

        // Indicador de sincronización (heurística): online + presencia de Firestore = verde
        const online = navigator.onLine;
        const hasDb = !!(window._firebase && window._firebase.db);
        if (online && hasDb) {
            statusSync.classList.remove('bg-gray-400');
            statusSync.classList.remove('bg-red-400');
            statusSync.classList.add('bg-green-400');
            statusSync.title = 'Sincronización OK';
        } else if (!online) {
            statusSync.classList.remove('bg-gray-400');
            statusSync.classList.remove('bg-green-400');
            statusSync.classList.add('bg-red-400');
            statusSync.title = 'Offline (sin conexión de red)';
        } else {
            statusSync.classList.remove('bg-green-400');
            statusSync.classList.remove('bg-red-400');
            statusSync.classList.add('bg-gray-400');
            statusSync.title = 'Sincronización desconocida';
        }
    } else {
        if (btnGoogle) btnGoogle.classList.remove('hidden');
        if (btnGoogleMobile) btnGoogleMobile.classList.remove('hidden');
        if (btnSignout) btnSignout.classList.add('hidden');
        if (btnSignoutMobile) btnSignoutMobile.classList.add('hidden');
        if (btnSync) btnSync.classList.add('hidden');
        if (btnSyncMobile) btnSyncMobile.classList.add('hidden');
        status.classList.remove('hidden');
        statusText.innerText = 'No conectado';
        statusUid.innerText = '';
        statusSync.classList.remove('bg-green-400');
        statusSync.classList.remove('bg-red-400');
        statusSync.classList.add('bg-gray-400');
        statusSync.title = 'Sincronización desconocida';
    }
}

// Toggle mobile menu visibility
function toggleMobileMenu() {
    const menu = document.getElementById('mobile-menu');
    if (!menu) return;
    if (menu.classList.contains('hidden')) {
        menu.classList.remove('hidden');
    } else {
        menu.classList.add('hidden');
    }
}

// Watch for auth changes when firebase becomes available
function watchAuthChanges() {
    if (window._firebase && window._firebase.auth) {
        const auth = window._firebase.auth;
        auth.onAuthStateChanged(() => {
            updateAuthUI();
        });
        // initial update
        updateAuthUI();
    } else {
        window.addEventListener('firebase-auth-ready', () => {
            if (window._firebase && window._firebase.auth) {
                window._firebase.auth.onAuthStateChanged(() => updateAuthUI());
            }
            updateAuthUI();
        }, { once: true });
    }
}

watchAuthChanges();