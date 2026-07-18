// --- MODO OSCURO ---
function toggleTheme() {
    const html = document.documentElement;
    const icons = Array.from(document.querySelectorAll('.theme-icon'));

    if (html.classList.contains('dark')) {
        html.classList.remove('dark');
        icons.forEach(ic => { ic.classList.remove('ph-sun'); ic.classList.add('ph-moon'); });
        localStorage.setItem('theme', 'light');
    } else {
        html.classList.add('dark');
        icons.forEach(ic => { ic.classList.remove('ph-moon'); ic.classList.add('ph-sun'); });
        localStorage.setItem('theme', 'dark');
    }
}

// Cargar preferencia de tema al iniciar
(function loadTheme() {
    const savedTheme = localStorage.getItem('theme');
    const icons = Array.from(document.querySelectorAll('.theme-icon'));
    if (savedTheme === 'dark' || !savedTheme) {
        document.documentElement.classList.add('dark');
        icons.forEach(ic => { ic.classList.remove('ph-moon'); ic.classList.add('ph-sun'); });
        if (!savedTheme) localStorage.setItem('theme', 'dark');
    }
})();

// Evita mostrar contenido público hasta que la autenticación inicial esté lista
(function guardInitialRender() {
    const body = document.body;
    if (!body) return;

    const releaseGate = () => {
        if (!body.classList.contains('auth-pending')) return;
        body.classList.remove('auth-pending');
    };

    // Si Firebase ya respondió antes de que se evalúe este script, libera ya
    if (window._firebase && window._firebase.authReady) {
        releaseGate();
        return;
    }

    window.addEventListener('firebase-auth-ready', releaseGate, { once: true });
    // Fallback más generoso (8 s): si Firebase no responde, dejamos que el usuario
    // vea la app aunque sin sesión, en lugar de bloquearlo.
    setTimeout(releaseGate, 8000);
})();

// --- LÓGICA DE TRADING ---

// Devuelve la fecha como YYYY-MM-DD en zona LOCAL (evita el bug de toISOString
// que desplaza un día en zonas UTC+).
function localDateKey(date) {
    if (!(date instanceof Date) || isNaN(date)) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

let currentData = { tps: [], sls: [] };
// Estado de expandir/colapsar listas largas (declarado arriba para evitar TDZ:
// renderList puede ejecutarse antes de llegar a su definición).
let __listExpanded = { tp: false, sl: false };
function normalizeCurrentData() {
    if (!currentData || typeof currentData !== 'object') currentData = { tps: [], sls: [] };
    if (!Array.isArray(currentData.tps)) currentData.tps = [];
    if (!Array.isArray(currentData.sls)) currentData.sls = [];
}
// Capital dinámico: configuración y estado
const CAPITAL_STORAGE_KEY = 'trading_capital_config';
const DISPLAY_PREF_KEY = 'trading_display_pref';
let capitalConfig = { initial: 1000, withdrawals: [], deposits: [] };
let capitalTimeline = []; // [{ dateKey, cumulativeNet, capital, relativePct }]

// --- Movimientos de capital: retiros y depósitos ---
// Cada movimiento: { id, date: 'YYYY-MM-DD', amount: number>0, note: string }
// Retiros: salen de la cuenta (restan del capital actual).
// Depósitos: entran a la cuenta (suman al capital actual).
// NINGUNO toca el capital inicial ni el % de rendimiento: solo el trading mueve
// el rendimiento; agregar o sacar dinero no es ganancia ni pérdida.
function getMovements(kind) { // kind: 'withdrawals' | 'deposits'
    return Array.isArray(capitalConfig[kind]) ? capitalConfig[kind] : [];
}
function totalMovements(kind) {
    return getMovements(kind).reduce((s, m) => s + (Number(m.amount) || 0), 0);
}
function movementsUpTo(kind, dateKey) {
    return getMovements(kind).reduce((s, m) => (m.date && m.date <= dateKey ? s + (Number(m.amount) || 0) : s), 0);
}
// Atajos por tipo
function getWithdrawals() { return getMovements('withdrawals'); }
function getDeposits() { return getMovements('deposits'); }
function getTotalWithdrawals() { return totalMovements('withdrawals'); }
function getTotalDeposits() { return totalMovements('deposits'); }
function getWithdrawalsUpTo(dateKey) { return movementsUpTo('withdrawals', dateKey); }
function getDepositsUpTo(dateKey) { return movementsUpTo('deposits', dateKey); }
// Saldo neto de movimientos (depósitos − retiros) hasta una fecha o total
function netMovements() { return getTotalDeposits() - getTotalWithdrawals(); }
function netMovementsUpTo(dateKey) { return getDepositsUpTo(dateKey) - getWithdrawalsUpTo(dateKey); }
function saveCapitalLocal() {
    try {
        localStorage.setItem(CAPITAL_STORAGE_KEY, JSON.stringify({
            initial: capitalConfig.initial,
            withdrawals: getWithdrawals(),
            deposits: getDeposits()
        }));
    } catch (e) { /* ignore */ }
}
let __capitalRecalcTimer = null;
let __isCalculatingCapital = false;
// Modo de visualización: 'dollars' (montos en $, fuente de verdad) o 'percent'
// (mostrar todo como % del capital inicial). El % se calcula al vuelo.
let displayPreference = { mode: 'dollars' };
try {
    const __raw = localStorage.getItem(DISPLAY_PREF_KEY);
    if (__raw) {
        const __p = JSON.parse(__raw);
        if (__p && (__p.mode === 'dollars' || __p.mode === 'percent')) displayPreference.mode = __p.mode;
    }
} catch (e) { /* ignore */ }

function getDisplayMode() {
    return displayPreference.mode;
}

// Formatea un monto numérico cambiando solo el símbolo según el modo activo.
// No hace ninguna conversión: el valor 25 se ve como "$25.00" o "25.00%".
// opts.showSign = true → antepone "+" o "−" (cero sin signo).
function formatAmount(value, opts) {
    const o = opts || {};
    const num = Number(value) || 0;
    const isNeg = num < 0;
    const abs = Math.abs(num);
    const body = getDisplayMode() === 'percent' ? abs.toFixed(2) + '%' : '$' + abs.toFixed(2);
    if (!o.showSign || num === 0) return body;
    return (isNeg ? '−' : '+') + body;
}

// Parsea el input del usuario a número. Sin conversión por modo: 25 siempre es 25.
function inputValueToDollars(rawValue) {
    const v = parseFloat(String(rawValue == null ? '' : rawValue).replace(',', '.').trim());
    return Number.isFinite(v) ? v : NaN;
}

// Devuelve el valor a precargar en el input del editor. Sin conversión.
function dollarsToInputValue(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function setDisplayMode(mode) {
    if (mode !== 'dollars' && mode !== 'percent') return;
    if (displayPreference.mode === mode) return;
    displayPreference.mode = mode;
    try { localStorage.setItem(DISPLAY_PREF_KEY, JSON.stringify(displayPreference)); } catch (e) { /* ignore */ }
    saveDisplayModeRemote(mode);
    refreshDisplayModeUI();
    // Cerrar paneles abiertos (sus inputs están en otro modo)
    document.querySelectorAll('.row-editor:not(.hidden)').forEach(el => {
        el.classList.add('hidden');
        el.innerHTML = '';
    });
    document.querySelectorAll('.trade-entry-row.is-expanded').forEach(el => el.classList.remove('is-expanded'));
    try { renderUI(); } catch (e) { /* ignore */ }
    try { scheduleCapitalRecalc(0); } catch (e) { /* ignore */ }
    try { scheduleGenerateSummaries(80); } catch (e) { /* ignore */ }
}

async function saveDisplayModeRemote(mode) {
    if (typeof hasFirestore !== 'function' || !hasFirestore()) return;
    const uid = window._firebase && window._firebase.uid;
    if (!uid) return;
    try {
        const docRef = window.firebaseFirestoreDoc(window._firebase.db, 'users', uid, 'config', 'capital');
        await window.firebaseFirestoreSetDoc(docRef, { displayMode: mode }, { merge: true });
    } catch (err) {
        console.warn('No se pudo guardar displayMode en Firestore', err);
    }
}

// Refresca aspectos visuales que dependen del modo: botones del toggle y
// placeholders de los inputs rápidos.
function refreshDisplayModeUI() {
    const mode = getDisplayMode();
    const isPercent = mode === 'percent';
    document.querySelectorAll('[data-display-mode]').forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.displayMode === mode);
    });
    const tpInput = document.getElementById('tp-input');
    const slInput = document.getElementById('sl-input');
    if (tpInput) tpInput.placeholder = isPercent ? '0.00 %' : '$ 0.00';
    if (slInput) slInput.placeholder = isPercent ? '0.00 %' : '$ 0.00';
    // Etiquetas del KPI card cambian de "Capital" a "Porcentaje" según el modo.
    const kpiInitial = document.getElementById('kpi-label-initial');
    const kpiCurrent = document.getElementById('kpi-label-current');
    if (kpiInitial) kpiInitial.innerText = isPercent ? 'Porcentaje inicial' : 'Capital inicial';
    if (kpiCurrent) kpiCurrent.innerText = isPercent ? 'Porcentaje actual' : 'Capital actual';
    const kpiSymbol = document.getElementById('kpi-currency-symbol');
    if (kpiSymbol) kpiSymbol.innerText = isPercent ? '%' : '$';
}
const DATE_STORAGE_KEY = 'trading_selected_date';

const datePicker = document.getElementById('datePicker');
const today = localDateKey(new Date());
const restoredDate = localStorage.getItem(DATE_STORAGE_KEY);
const initialDate = restoredDate || today;
datePicker.value = initialDate;

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
initCapitalFeature();

// Nota: la carga de datos al iniciar sesión y al restaurar sesión persistida
// se gestiona ahora desde watchAuthChanges() → onAuthChange() →
// refreshUserDataAfterLogin(), que detecta la transición desconectado→conectado
// y dispara la carga completa (capital + diario + recalc + migración).
// Solo dejamos aquí la actualización mínima de UI.
window.addEventListener('firebase-auth-ready', () => {
    try { updateAuthUI(); } catch (e) { /* ignore */ }
});

// También intenta cuando firebase-init.js fue cargado antes
if (window._firebase && window._firebase.uid !== undefined) {
    // small delay to let auth settle
    setTimeout(() => { loadDataFirestore().catch(()=>{}); updateAuthUI(); }, 200);
}

datePicker.addEventListener('change', () => {
    localStorage.setItem(DATE_STORAGE_KEY, datePicker.value);
    loadData();
    scheduleGenerateSummaries();
    renderCapitalDisplays(getCurrentNet());
    // Si hay sesión iniciada, recrear el listener por-fecha para apuntar a la
    // nueva fecha. Sin esto, el snapshot listener anterior seguía escribiendo
    // currentData con datos de la fecha previa cuando llegaban cambios remotos.
    if (window._firebase && window._firebase.uid) {
        loadDataFirestore().catch(() => { /* ignore */ });
    }
});

let _unsubscribeJournalCollectionListener = null;

function ensureJournalCollectionListener() {
    if (!window._firebase || !window._firebase.db) return;
    const uid = window._firebase.uid;
    if (!uid) return;
    // Asegurar también el listener del capital inicial — viven y mueren juntos.
    try { ensureCapitalConfigListener(); } catch (e) { /* ignore */ }
    if (_unsubscribeJournalCollectionListener) return;

    const collRef = window.firebaseFirestoreCollection(window._firebase.db, 'users', uid, 'journals');
    _unsubscribeJournalCollectionListener = window.firebaseFirestoreOnSnapshot(
        collRef,
        (snapshot) => {
            // Si el usuario está viendo o editando un trade, no procesamos
            // el snapshot ahora — el re-render destruiría el panel abierto.
            if (isAnyRowEditorOpen()) return;
            let touched = false;
            snapshot.docChanges().forEach(change => {
                const dateKey = change.doc.id;
                if (!dateKey) return;
                const storageKey = `trading_${dateKey}`;

                if (change.type === 'removed') {
                    localStorage.removeItem(storageKey);
                    try { __journalCache.delete(dateKey); } catch (e) { /* ignore */ }
                    if (dateKey === datePicker.value) {
                        currentData = { tps: [], sls: [] };
                        normalizeCurrentData();
                        renderUI();
                    }
                    touched = true;
                    return;
                }

                const docData = change.doc.data() || {};
                const normalized = {
                    tps: Array.isArray(docData.tps) ? docData.tps : [],
                    sls: Array.isArray(docData.sls) ? docData.sls : []
                };
                localStorage.setItem(storageKey, JSON.stringify(normalized));
                // Mantener el cache en memoria sincronizado (lo usa fetchAllJournalsMerged
                // indirectamente vía readManyJournalForDates).
                try { __journalCache.set(dateKey, normalized); } catch (e) { /* ignore */ }
                if (dateKey === datePicker.value) {
                    currentData = normalized;
                    normalizeCurrentData();
                    renderUI();
                }
                touched = true;
            });
            // Cualquier cambio en cualquier fecha afecta el capital acumulado y los
            // resúmenes. Disparamos los recálculos UNA sola vez por snapshot (debounced).
            if (touched) {
                try { scheduleCapitalRecalc(); } catch (e) { /* ignore */ }
                try { scheduleGenerateSummaries(); } catch (e) { /* ignore */ }
            }
        },
        (err) => {
            console.warn('Listener de diarios cancelado:', err);
        }
    );
}

function cleanupJournalCollectionListener() {
    if (typeof _unsubscribeJournalCollectionListener === 'function') {
        _unsubscribeJournalCollectionListener();
        _unsubscribeJournalCollectionListener = null;
    }
    try { cleanupCapitalConfigListener(); } catch (e) { /* ignore */ }
}

// Listener en tiempo real para el capital inicial (users/{uid}/config/capital).
// Sin esto, cambiar el capital inicial en un dispositivo no se ve en otro hasta
// refrescar.
let _unsubscribeCapitalConfigListener = null;

function ensureCapitalConfigListener() {
    if (!window._firebase || !window._firebase.db) return;
    const uid = window._firebase.uid;
    if (!uid) return;
    if (_unsubscribeCapitalConfigListener) return;

    const docRef = window.firebaseFirestoreDoc(window._firebase.db, 'users', uid, 'config', 'capital');
    _unsubscribeCapitalConfigListener = window.firebaseFirestoreOnSnapshot(
        docRef,
        (snap) => {
            try {
                if (!snap || !snap.exists || !snap.exists()) return;
                const data = snap.data() || {};
                let changed = false;

                // 1) Capital inicial
                const candidate = data.initialCapital ?? data.initial;
                const next = sanitizeCapitalValue(candidate, capitalConfig.initial);
                if (Math.abs(next - capitalConfig.initial) >= 1e-6) {
                    capitalConfig.initial = next;
                    saveCapitalLocal();
                    const input = document.getElementById('capital-input');
                    if (input && document.activeElement !== input) input.value = capitalConfig.initial;
                    changed = true;
                }

                // 2) Modo de visualización
                const remoteMode = data.displayMode;
                if ((remoteMode === 'dollars' || remoteMode === 'percent') && remoteMode !== displayPreference.mode) {
                    displayPreference.mode = remoteMode;
                    try { localStorage.setItem(DISPLAY_PREF_KEY, JSON.stringify(displayPreference)); } catch (e) { /* ignore */ }
                    refreshDisplayModeUI();
                    try { renderUI(); } catch (e) { /* ignore */ }
                    changed = true;
                }

                // 3) Movimientos de capital: retiros y depósitos
                if (Array.isArray(data.withdrawals) && JSON.stringify(getWithdrawals()) !== JSON.stringify(data.withdrawals)) {
                    capitalConfig.withdrawals = data.withdrawals;
                    saveCapitalLocal();
                    changed = true;
                }
                if (Array.isArray(data.deposits) && JSON.stringify(getDeposits()) !== JSON.stringify(data.deposits)) {
                    capitalConfig.deposits = data.deposits;
                    saveCapitalLocal();
                    changed = true;
                }
                if (changed) { try { updateCapMoveUI(); } catch (e) { /* ignore */ } }

                if (changed) scheduleCapitalRecalc(0);
            } catch (err) {
                console.warn('Error procesando capital config snapshot', err);
            }
        },
        (err) => {
            console.warn('Listener de capital config cancelado:', err);
        }
    );
}

function cleanupCapitalConfigListener() {
    if (typeof _unsubscribeCapitalConfigListener === 'function') {
        _unsubscribeCapitalConfigListener();
        _unsubscribeCapitalConfigListener = null;
    }
}

// --- Helpers reutilizables para lectura de diarios (cache y lecturas batch) ---
const __journalCache = new Map();
let __firestoreModule = null; // cache del import dinámico

function hasFirestore() {
    return !!(window._firebase && window._firebase.db && window._firebase.uid);
}

async function ensureFirestoreModule() {
    if (__firestoreModule) return __firestoreModule;
    try {
        __firestoreModule = await import('https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js');
    } catch (err) {
        __firestoreModule = null;
    }
    return __firestoreModule;
}

// Obtener un diario (primero cache/localStorage, si no existe intentar Firestore)
async function readJournalForDate(dateKey) {
    if (__journalCache.has(dateKey)) return __journalCache.get(dateKey);
    let data = null;
    try {
        const raw = localStorage.getItem(`trading_${dateKey}`);
        if (raw) data = JSON.parse(raw);
    } catch (e) {
        // ignore parse errors
    }
    if (!data && hasFirestore()) {
        try {
            const db = window._firebase.db;
            const uid = window._firebase.uid;
            const docRef = window.firebaseFirestoreDoc(db, 'users', uid, 'journals', dateKey);
            const snap = await window.firebaseFirestoreGetDoc(docRef);
            if (snap && snap.exists && snap.exists()) data = snap.data();
        } catch (err) {
            // ignore remote errors
        }
    }
    __journalCache.set(dateKey, data);
    return data;
}

// Leer muchos diarios en batch: intenta localStorage/cache y, si es necesario, usa consultas 'in' en chunks
async function readManyJournalForDates(keys) {
    const out = {};
    const toFetch = [];
    for (const k of keys) {
        if (__journalCache.has(k)) { out[k] = __journalCache.get(k); continue; }
        try {
            const raw = localStorage.getItem(`trading_${k}`);
            if (raw) { const parsed = JSON.parse(raw); __journalCache.set(k, parsed); out[k] = parsed; continue; }
        } catch (e) { /* ignore */ }
        toFetch.push(k);
    }

    if (toFetch.length === 0) return out;
    if (!hasFirestore()) {
        toFetch.forEach(k => { __journalCache.set(k, null); out[k] = null; });
        return out;
    }

    const db = window._firebase.db;
    const uid = window._firebase.uid;
    const chunkSize = 10;
    for (let i = 0; i < toFetch.length; i += chunkSize) {
        const chunk = toFetch.slice(i, i + chunkSize);
        try {
            const mod = await ensureFirestoreModule();
            if (!mod) throw new Error('firestore module not available');
            const { collection, query, where, getDocs, documentId } = mod;
            const collRef = collection(db, 'users', uid, 'journals');
            const q = query(collRef, where(documentId(), 'in', chunk));
            const snap = await getDocs(q);
            const found = new Set();
            snap.forEach(d => { const id = d.id; const data = d.data(); __journalCache.set(id, data); out[id] = data; found.add(id); });
            chunk.forEach(k => { if (!found.has(k)) { __journalCache.set(k, null); out[k] = null; } });
        } catch (err) {
            console.warn('readManyJournalForDates batch error', err);
            chunk.forEach(k => { __journalCache.set(k, null); out[k] = null; });
        }
    }

    return out;
}

// --- CAPITAL DINÁMICO (config + cálculo determinístico) ---
function sanitizeCapitalValue(val, fallback = 1000) {
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n;
}

function formatCurrency(val) {
    try {
        return new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
    } catch (e) {
        return (val || 0).toFixed(2);
    }
}

async function loadCapitalConfig(forceRemote = false) {
    // Cargar desde localStorage primero
    try {
        const raw = localStorage.getItem(CAPITAL_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            capitalConfig.initial = sanitizeCapitalValue(parsed.initial, capitalConfig.initial);
            if (Array.isArray(parsed.withdrawals)) capitalConfig.withdrawals = parsed.withdrawals;
            if (Array.isArray(parsed.deposits)) capitalConfig.deposits = parsed.deposits;
        }
    } catch (e) { /* ignore parse errors */ }

    // Intentar obtener desde Firestore si está disponible
    if (hasFirestore()) {
        try {
            const db = window._firebase.db;
            const uid = window._firebase.uid;
            if (uid) {
                const docRef = window.firebaseFirestoreDoc(db, 'users', uid, 'config', 'capital');
                const snap = await window.firebaseFirestoreGetDoc(docRef);
                if (snap && snap.exists && snap.exists()) {
                    const data = snap.data() || {};
                    const candidate = data.initialCapital ?? data.initial;
                    capitalConfig.initial = sanitizeCapitalValue(candidate, capitalConfig.initial);
                    // Modo de visualización ($ / %) viene en el mismo doc
                    if (data.displayMode === 'dollars' || data.displayMode === 'percent') {
                        displayPreference.mode = data.displayMode;
                        try { localStorage.setItem(DISPLAY_PREF_KEY, JSON.stringify(displayPreference)); } catch (e) { /* ignore */ }
                    }
                    // Movimientos de capital
                    if (Array.isArray(data.withdrawals)) capitalConfig.withdrawals = data.withdrawals;
                    if (Array.isArray(data.deposits)) capitalConfig.deposits = data.deposits;
                } else if (forceRemote) {
                    await window.firebaseFirestoreSetDoc(docRef, { initialCapital: capitalConfig.initial });
                }
            }
        } catch (err) {
            console.warn('No se pudo cargar capital desde Firestore', err);
        }
    }

    saveCapitalLocal();

    const input = document.getElementById('capital-input');
    if (input) input.value = capitalConfig.initial;
    try { updateCapMoveUI(); } catch (e) { /* ignore */ }
}

async function saveCapitalConfigRemote(value) {
    if (!hasFirestore()) return;
    const uid = window._firebase.uid;
    if (!uid) return;
    try {
        const docRef = window.firebaseFirestoreDoc(window._firebase.db, 'users', uid, 'config', 'capital');
        // merge:true para no borrar displayMode / withdrawals del mismo doc
        await window.firebaseFirestoreSetDoc(docRef, { initialCapital: value }, { merge: true });
    } catch (err) {
        console.warn('No se pudo guardar capital en Firestore', err);
    }
}

// Configuración por tipo de movimiento (ids de elementos y textos).
const CAP_MOVE_CFG = {
    withdrawals: { prefix: 'withdraw', chip: 'withdraw-total-chip', noun: 'retiro', idp: 'w',
        emptyMsg: 'Aún no has registrado retiros.', okMsg: 'Retiro registrado', delMsg: 'Retiro eliminado',
        confirmMsg: '¿Eliminar este retiro? El capital actual volverá a incluir ese monto.' },
    deposits: { prefix: 'deposit', chip: 'deposit-total-chip', noun: 'depósito', idp: 'd',
        emptyMsg: 'Aún no has registrado depósitos.', okMsg: 'Depósito registrado', delMsg: 'Depósito eliminado',
        confirmMsg: '¿Eliminar este depósito? El capital actual dejará de incluir ese monto.' }
};

async function saveCapMoveRemote(kind, list) {
    if (!hasFirestore()) return;
    const uid = window._firebase.uid;
    if (!uid) return;
    try {
        const docRef = window.firebaseFirestoreDoc(window._firebase.db, 'users', uid, 'config', 'capital');
        const payload = {}; payload[kind] = list;
        await window.firebaseFirestoreSetDoc(docRef, payload, { merge: true });
    } catch (err) {
        console.warn('No se pudo guardar ' + kind + ' en Firestore', err);
    }
}

function persistCapitalConfig(value) {
    capitalConfig.initial = sanitizeCapitalValue(value, capitalConfig.initial);
    saveCapitalLocal();
    saveCapitalConfigRemote(capitalConfig.initial);
    scheduleCapitalRecalc(0);
    renderCapitalDisplays(getCurrentNet());
}

// Persiste una lista de movimientos (local + remoto) y refresca UI/cálculos.
function persistCapMove(kind) {
    saveCapitalLocal();
    saveCapMoveRemote(kind, getMovements(kind));
    scheduleCapitalRecalc(0);
    renderCapitalDisplays(getCurrentNet());
    updateCapMoveUI();
}

// ==================== MOVIMIENTOS DE CAPITAL: UI ====================
function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Actualiza los chips (Retiros/Depósitos), las listas de modales abiertos y el
// resumen de movimientos en Estadísticas.
function updateCapMoveUI() {
    Object.keys(CAP_MOVE_CFG).forEach(kind => {
        const cfg = CAP_MOVE_CFG[kind];
        const total = totalMovements(kind);
        const chip = document.getElementById(cfg.chip);
        if (chip) {
            if (total > 0) { chip.textContent = '$' + formatCurrency(total); chip.classList.remove('hidden'); }
            else { chip.textContent = ''; chip.classList.add('hidden'); }
        }
        const overlay = document.getElementById(cfg.prefix + '-modal-overlay');
        if (overlay && !overlay.classList.contains('hidden')) renderCapMoveList(kind);
    });
    try { renderCapitalMovementsStats(); } catch (e) { /* ignore */ }
}

function renderCapMoveList(kind) {
    const cfg = CAP_MOVE_CFG[kind];
    const totalEl = document.getElementById(cfg.prefix + '-modal-total');
    if (totalEl) totalEl.textContent = '$' + formatCurrency(totalMovements(kind));

    const listEl = document.getElementById(cfg.prefix + '-list');
    if (!listEl) return;
    const list = getMovements(kind).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (list.length === 0) {
        listEl.innerHTML = `<div class="text-center text-slate-400 dark:text-slate-500 text-sm py-4">${cfg.emptyMsg}</div>`;
        return;
    }
    listEl.innerHTML = list.map(m => {
        const amount = '$' + formatCurrency(Number(m.amount) || 0);
        const note = m.note ? `<div class="text-xs text-slate-400 dark:text-slate-500 truncate">${escapeHtml(m.note)}</div>` : '';
        return `
        <div class="flex items-center justify-between gap-3 py-2.5 px-3.5 mb-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
            <div class="min-w-0">
                <div class="text-sm font-bold text-slate-700 dark:text-slate-200 tabular-nums">${amount}</div>
                <div class="text-xs text-slate-400 dark:text-slate-500 tabular-nums">${m.date || ''}</div>
                ${note}
            </div>
            <button onclick="deleteCapMove('${kind}','${m.id}')" class="text-slate-400 hover:text-red-500 dark:hover:text-red-400 p-2 rounded-lg transition" aria-label="Eliminar ${cfg.noun}">
                <i class="ph ph-trash"></i>
            </button>
        </div>`;
    }).join('');
}

// Resumen "Depositado / Retirado" dentro de Estadísticas.
function renderCapitalMovementsStats() {
    const depEl = document.getElementById('stats-deposited');
    const wdEl = document.getElementById('stats-withdrawn');
    const totalD = getTotalDeposits();
    const totalW = getTotalWithdrawals();
    if (depEl) depEl.textContent = '$' + formatCurrency(totalD);
    if (wdEl) wdEl.textContent = '$' + formatCurrency(totalW);
    const wrap = document.getElementById('capital-movements');
    if (wrap) wrap.classList.toggle('hidden', totalD <= 0 && totalW <= 0);
}

function openCapMoveModal(kind) {
    const cfg = CAP_MOVE_CFG[kind];
    const overlay = document.getElementById(cfg.prefix + '-modal-overlay');
    if (!overlay) return;
    const dateEl = document.getElementById(cfg.prefix + '-date');
    const amountEl = document.getElementById(cfg.prefix + '-amount');
    const noteEl = document.getElementById(cfg.prefix + '-note');
    if (dateEl) dateEl.value = localDateKey(new Date());
    if (amountEl) amountEl.value = '';
    if (noteEl) noteEl.value = '';
    renderCapMoveList(kind);
    overlay.classList.remove('hidden');
}

function closeCapMoveModal(kind) {
    const overlay = document.getElementById(CAP_MOVE_CFG[kind].prefix + '-modal-overlay');
    if (overlay) overlay.classList.add('hidden');
}

function submitCapMove(kind) {
    const cfg = CAP_MOVE_CFG[kind];
    const amountEl = document.getElementById(cfg.prefix + '-amount');
    const dateEl = document.getElementById(cfg.prefix + '-date');
    const noteEl = document.getElementById(cfg.prefix + '-note');
    const amount = parseFloat((amountEl && amountEl.value) || '');
    if (!Number.isFinite(amount) || amount <= 0) {
        showToast('Ingresa un monto válido', 'error');
        return;
    }
    const date = (dateEl && dateEl.value) || localDateKey(new Date());
    const note = ((noteEl && noteEl.value) || '').trim().slice(0, 200);
    const id = cfg.idp + Date.now() + Math.floor(Math.random() * 1000);
    if (!Array.isArray(capitalConfig[kind])) capitalConfig[kind] = [];
    capitalConfig[kind].push({ id, date, amount: Math.round(amount * 100) / 100, note });
    persistCapMove(kind);
    if (amountEl) amountEl.value = '';
    if (noteEl) noteEl.value = '';
    showToast(cfg.okMsg, 'success');
}

async function deleteCapMove(kind, id) {
    const cfg = CAP_MOVE_CFG[kind];
    const ok = await showConfirmModal(cfg.confirmMsg);
    if (!ok) return;
    capitalConfig[kind] = getMovements(kind).filter(m => m.id !== id);
    persistCapMove(kind);
    showToast(cfg.delMsg, 'success');
}

function setupCapitalInput() {
    const input = document.getElementById('capital-input');
    if (!input) return;
    const handler = () => {
        const val = parseFloat(input.value);
        if (!Number.isFinite(val) || val <= 0) {
            showToast('Ingresa un capital inicial válido', 'error');
            input.value = capitalConfig.initial;
            return;
        }
        if (Math.abs(val - capitalConfig.initial) < 1e-6) return;
        persistCapitalConfig(val);
    };
    input.addEventListener('change', handler);
    input.addEventListener('blur', handler);
}

function normalizeTradeEntry(item, idx, type) {
    const safeValue = Number(item && item.value);
    const value = Number.isFinite(safeValue) ? Math.abs(safeValue) : 0;
    const id = (item && (item.id || item.id === 0)) ? Number(item.id) : idx;
    const out = {
        id: Number.isFinite(id) ? id : idx,
        value,
        asset: (item && item.asset ? String(item.asset).trim().toUpperCase() : '---') || '---',
        type
    };
    // Detalles opcionales: solo conservamos lo que esté presente y bien formado.
    const det = sanitizeDetails(item && item.details);
    if (det) out.details = det;
    return out;
}

// Devuelve un objeto details "limpio" o null si está vacío.
// Campos aceptados: side, leverage, entry, sl, targets[], notes.
// Compatibilidad hacia atrás: acepta también t1/t2/t3 y los migra a targets.
function sanitizeDetails(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};

    const side = String(raw.side || '').toUpperCase();
    if (side === 'LONG' || side === 'SHORT') out.side = side;

    ['leverage', 'entry', 'sl'].forEach(k => {
        const v = Number(raw[k]);
        if (Number.isFinite(v) && v > 0) out[k] = v;
    });

    // Targets: preferir array `targets`. Si no existe, intentar t1, t2, ...
    let targets = [];
    if (Array.isArray(raw.targets)) {
        targets = raw.targets.map(Number).filter(v => Number.isFinite(v) && v > 0);
    } else {
        for (let i = 1; i <= 99; i++) {
            const v = Number(raw['t' + i]);
            if (Number.isFinite(v) && v > 0) targets.push(v);
            else if (raw['t' + i] === undefined) break; // no más slots t<i>
        }
    }
    if (targets.length) out.targets = targets;

    if (raw.notes != null) {
        const n = String(raw.notes).trim().slice(0, 500);
        if (n) out.notes = n;
    }
    return Object.keys(out).length ? out : null;
}

function normalizeJournalData(data) {
    return {
        tps: Array.isArray(data && data.tps) ? data.tps.map((it, idx) => normalizeTradeEntry(it, idx, 'tp')) : [],
        sls: Array.isArray(data && data.sls) ? data.sls.map((it, idx) => normalizeTradeEntry(it, idx, 'sl')) : []
    };
}

function hasTrades(data) {
    if (!data) return false;
    return (Array.isArray(data.tps) && data.tps.length > 0) || (Array.isArray(data.sls) && data.sls.length > 0);
}

async function fetchAllJournalsMerged() {
    const merged = {};

    // 1) LocalStorage
    const localKeys = getLocalTradingKeys();
    for (const k of localKeys) {
        try {
            const raw = localStorage.getItem(`trading_${k}`);
            if (!raw) continue;
            merged[k] = normalizeJournalData(JSON.parse(raw));
        } catch (e) { /* ignore parse errors */ }
    }

    // 2) Estado actual (por si aún no se guardó)
    if (datePicker && datePicker.value && !merged[datePicker.value]) {
        merged[datePicker.value] = normalizeJournalData(currentData);
    }

    // 3) Firestore (solo para keys que no estén localmente)
    if (hasFirestore()) {
        try {
            const mod = await ensureFirestoreModule();
            if (mod) {
                const { collection, getDocs } = mod;
                const collRef = collection(window._firebase.db, 'users', window._firebase.uid, 'journals');
                const snap = await getDocs(collRef);
                snap.forEach(docSnap => {
                    const id = docSnap.id;
                    if (!id) return;
                    if (merged[id] && hasTrades(merged[id])) return; // preferir local si ya hay datos
                    merged[id] = normalizeJournalData(docSnap.data() || {});
                });
            }
        } catch (err) {
            console.warn('No se pudieron leer todos los diarios para capital', err);
        }
    }

    return merged;
}

function computeCapitalTimelineFromJournals(journalMap) {
    const keys = Object.keys(journalMap || {}).sort();
    const timeline = [];
    let cumulativeNet = 0;

    // Salvaguarda: si por alguna razón el capital inicial es 0 o inválido,
    // usamos 1 como referencia para no producir Infinity al dividir.
    const baseCapital = (capitalConfig.initial && capitalConfig.initial > 0) ? capitalConfig.initial : 1;

    for (const dateKey of keys) {
        const data = journalMap[dateKey];
        if (!data) continue;
        const tpSum = (data.tps || []).reduce((acc, tp) => acc + (Number(tp.value) || 0), 0);
        const slSum = (data.sls || []).reduce((acc, sl) => acc + (Number(sl.value) || 0), 0);
        const dailyNet = tpSum - slSum;
        if (!dailyNet) continue;

        cumulativeNet += dailyNet;
        const capital = baseCapital + cumulativeNet;
        const relativePct = (cumulativeNet / baseCapital) * 100;

        timeline.push({
            dateKey,
            cumulativeNet,
            capital,
            relativePct
        });
    }

    return timeline;
}

function getCapitalSnapshot() {
    // Depósitos suman y retiros restan del dinero disponible (capital actual),
    // pero NO afectan el % de rendimiento (relativePct mide solo el P&L de trading).
    const net = netMovements(); // depósitos − retiros
    const base = {
        capital: capitalConfig.initial + net,
        relativePct: 0,
        cumulativeNet: 0
    };
    if (!capitalTimeline || capitalTimeline.length === 0) return base;
    const last = capitalTimeline[capitalTimeline.length - 1];
    return Object.assign({}, last, { capital: last.capital + net });
}

function renderCapitalDisplays(netForDay = null) {
    const capitalSnap = getCapitalSnapshot();
    const pct = capitalSnap.relativePct;
    const abs = capitalSnap.capital;
    const pctSign = pct > 0 ? '+' : '';
    const pctColor = pct > 0
        ? 'text-green-500 dark:text-green-400'
        : (pct < 0 ? 'text-red-500 dark:text-red-400' : 'text-slate-500 dark:text-slate-400');

    const absEl = document.getElementById('capital-abs-display');
    const pctEl = document.getElementById('capital-pct-display');
    if (absEl) {
        const isPositive = pct > 0;
        const isNegative = pct < 0;
        const symbol = getDisplayMode() === 'percent' ? '%' : '$';
        const num = formatCurrency(abs);
        absEl.innerText = getDisplayMode() === 'percent' ? num + symbol : symbol + num;
        absEl.classList.remove('text-green-500','dark:text-green-400','text-red-500','dark:text-red-400','text-slate-800','dark:text-slate-100');
        if (isPositive) absEl.classList.add('text-green-500','dark:text-green-400');
        else if (isNegative) absEl.classList.add('text-red-500','dark:text-red-400');
        else absEl.classList.add('text-slate-800','dark:text-slate-100');
    }
    if (pctEl) {
        if (pct === 0) {
            pctEl.innerHTML = '&nbsp;';
            pctEl.className = 'kpi-hint tabular-nums';
        } else {
            pctEl.innerText = `${pctSign}${pct.toFixed(2)}%`;
            pctEl.className = `kpi-hint tabular-nums ${pctColor}`;
        }
    }

    const mainEl = document.getElementById('main-profit-display');
    if (mainEl) {
        const net = netForDay === null ? getCurrentNet() : netForDay;
        const netColor = net > 0
            ? 'gain'
            : (net < 0 ? 'loss' : 'text-slate-400 dark:text-slate-500');
        const arrow = net > 0 ? '▲' : (net < 0 ? '▼' : '·');
        const body = net === 0 ? formatAmount(0) : formatAmount(net, { showSign: true });
        mainEl.innerHTML = `<span class="${netColor}">${arrow} ${body}</span>`;
    }
}

function scheduleCapitalRecalc(delay = 200) {
    if (__capitalRecalcTimer) clearTimeout(__capitalRecalcTimer);
    __capitalRecalcTimer = setTimeout(() => {
        __capitalRecalcTimer = null;
        recalcCapitalTimeline();
    }, delay);
}

function getCurrentNet() {
    const tpTotal = currentData.tps.reduce((acc, curr) => acc + (Number(curr.value) || 0), 0);
    const slTotal = currentData.sls.reduce((acc, curr) => acc + (Number(curr.value) || 0), 0);
    return tpTotal - slTotal;
}

// Construye serie diaria continua: cada día desde el primer trade hasta hoy,
// con el capital "arrastrado" en días sin movimiento. Devuelve [{ dateKey, capital, dailyNet }].
function buildDailyCapitalSeries(initial, journals) {
    const sorted = Object.keys(journals || {}).sort();
    if (sorted.length === 0) return [];

    const start = new Date(sorted[0] + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Limitar a "hoy o último día con datos", lo que sea más reciente
    const lastDataDate = new Date(sorted[sorted.length - 1] + 'T00:00:00');
    const end = today >= lastDataDate ? today : lastDataDate;

    const series = [];
    let cum = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const key = localDateKey(d);
        const data = journals[key];
        let dailyNet = 0;
        if (data) {
            const tp = (data.tps || []).reduce((s, it) => s + (Number(it.value) || 0), 0);
            const sl = (data.sls || []).reduce((s, it) => s + (Number(it.value) || 0), 0);
            dailyNet = tp - sl;
            cum += dailyNet;
        }
        // Reflejar depósitos (suben) y retiros (bajan) en la gráfica
        series.push({ dateKey: key, capital: initial + cum + netMovementsUpTo(key), dailyNet });
    }
    return series;
}

let __lastJournalsCache = {}; // para re-render del sparkline en resize sin recargar

async function recalcCapitalTimeline() {
    if (__isCalculatingCapital) return;
    __isCalculatingCapital = true;
    try {
        const journals = await fetchAllJournalsMerged();
        __lastJournalsCache = journals;
        capitalTimeline = computeCapitalTimelineFromJournals(journals);
    } catch (err) {
        console.warn('No se pudo recalcular el capital', err);
    } finally {
        __isCalculatingCapital = false;
        renderCapitalDisplays(getCurrentNet());
        try { renderCapitalSparkline(); } catch (e) { console.warn('Error renderizando sparkline', e); }
        try { renderStatsUI(); } catch (e) { console.warn('Error renderizando estadísticas', e); }
    }
}

// ==================== ESTADÍSTICAS ====================
function __pad2(n) { return n < 10 ? '0' + n : '' + n; }

function computeStats(map) {
    const keys = Object.keys(map || {}).sort();
    let grossProfit = 0, grossLoss = 0, wins = 0, losses = 0, bestTrade = 0, worstTrade = 0;
    const dayNets = [];
    const perDay = {};
    for (const k of keys) {
        const d = map[k]; if (!d) continue;
        const tps = d.tps || [], sls = d.sls || [];
        let tpSum = 0, slSum = 0;
        tps.forEach(t => { const v = Number(t.value) || 0; tpSum += v; if (v > bestTrade) bestTrade = v; });
        sls.forEach(s => { const v = Number(s.value) || 0; slSum += v; if (v > worstTrade) worstTrade = v; });
        grossProfit += tpSum; grossLoss += slSum; wins += tps.length; losses += sls.length;
        if (tps.length || sls.length) {
            const net = tpSum - slSum;
            dayNets.push({ dateKey: k, net });
            perDay[k] = net;
        }
    }
    const totalTrades = wins + losses;
    const net = grossProfit - grossLoss;
    const winRate = totalTrades ? (wins / totalTrades * 100) : 0;
    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : 0);
    const avgWin = wins ? grossProfit / wins : 0;
    const avgLoss = losses ? grossLoss / losses : 0;
    const greenDays = dayNets.filter(d => d.net > 0).length;
    const redDays = dayNets.filter(d => d.net < 0).length;
    let streak = 0, streakSign = 0;
    for (let i = dayNets.length - 1; i >= 0; i--) {
        const sg = Math.sign(dayNets[i].net);
        if (sg === 0) continue;
        if (streak === 0) { streakSign = sg; streak = 1; }
        else if (sg === streakSign) streak++;
        else break;
    }
    let bestDay = null, worstDay = null;
    dayNets.forEach(d => {
        if (!bestDay || d.net > bestDay.net) bestDay = d;
        if (!worstDay || d.net < worstDay.net) worstDay = d;
    });
    return {
        grossProfit, grossLoss, net, wins, losses, totalTrades, winRate, profitFactor,
        avgWin, avgLoss, greenDays, redDays, streak, streakSign, bestTrade, worstTrade,
        bestDay, worstDay, perDay, daysCount: dayNets.length
    };
}

// Abre el "Resumen Mensual" existente (calendario detallado) desde el scoreboard.
window.openMonthlySummaries = function () {
    const sec = document.getElementById('summaries-section');
    if (!sec) return;
    if (sec.classList.contains('hidden')) { try { toggleSummaries(); } catch (e) { /* ignore */ } }
    setTimeout(() => { try { sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* ignore */ } }, 150);
};

function renderStatsUI() {
    const kpiEl = document.getElementById('stats-kpis');
    if (!kpiEl) return;
    const s = computeStats(__lastJournalsCache || {});
    const mode = getDisplayMode();
    const money = (v) => mode === 'percent' ? `${v.toFixed(2)}%` : `$${(Math.round(v * 100) / 100).toFixed(2)}`;
    const signMoney = (v) => (v > 0 ? '+' : '') + money(v);
    const pf = s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2);
    const netColor = s.net > 0 ? 'gain' : (s.net < 0 ? 'loss' : 'text-slate-700 dark:text-slate-200');

    if (s.totalTrades === 0) {
        kpiEl.innerHTML = `<div class="col-span-full text-center text-sm text-slate-500 dark:text-slate-400 py-4">Aún sin operaciones registradas. Empieza a añadir Take Profit / Stop Loss para ver tus estadísticas.</div>`;
    } else {
        const tiles = [
            { label: 'Win rate', val: `${s.winRate.toFixed(0)}%`, sub: `${s.wins}W / ${s.losses}L`, cls: 'text-slate-800 dark:text-slate-100' },
            { label: 'Profit factor', val: pf, sub: s.profitFactor >= 1 ? 'rentable' : 'en pérdida', cls: (s.profitFactor >= 1 ? 'gain' : 'loss') },
            { label: 'Neto', val: signMoney(s.net), sub: `${s.daysCount} día(s)`, cls: netColor },
            { label: 'Operaciones', val: `${s.totalTrades}`, sub: `${s.daysCount ? (s.totalTrades / s.daysCount).toFixed(1) : '0'}/día`, cls: 'text-slate-800 dark:text-slate-100' },
            { label: 'Racha', val: `${s.streak || 0} ${s.streakSign > 0 ? '🟢' : (s.streakSign < 0 ? '🔴' : '')}`, sub: s.streakSign > 0 ? 'días verdes' : (s.streakSign < 0 ? 'días rojos' : '—'), cls: 'text-slate-800 dark:text-slate-100' },
            { label: 'Mejor día', val: s.bestDay ? signMoney(s.bestDay.net) : '—', sub: s.bestDay ? s.bestDay.dateKey.slice(5) : '', cls: 'gain' }
        ];
        kpiEl.innerHTML = tiles.map(t => `
            <div class="sub-surface p-3 text-center flex flex-col items-center justify-center gap-1">
                <div class="k-lab">${t.label}</div>
                <div class="font-bold text-lg tabular-nums ${t.cls}">${t.val}</div>
                <div class="text-[0.7rem] text-slate-500 dark:text-slate-400">${t.sub}</div>
            </div>`).join('');
    }
    try { renderCapitalMovementsStats(); } catch (e) { /* ignore */ }
}

// ==================== SPARKLINE ====================
function renderCapitalSparkline() {
    const container = document.getElementById('capital-sparkline');
    const metaEl = document.getElementById('capital-sparkline-meta');
    if (!container) return;

    const journals = __lastJournalsCache || {};
    const initial = capitalConfig.initial || 1000;
    const fullSeries = buildDailyCapitalSeries(initial, journals);

    // Mostrar últimos 30 puntos como máximo
    const series = fullSeries.slice(-30);

    if (series.length === 0) {
        container.innerHTML = '<div class="kpi-sparkline-empty">Aún sin historial</div>';
        if (metaEl) metaEl.innerText = '';
        return;
    }

    // Asegurar punto inicial: si solo hay 1 punto, anteponer el capital base
    let points = series.slice();
    if (points.length === 1) {
        points.unshift({ dateKey: '', capital: initial, dailyNet: 0 });
    }

    const W = container.clientWidth || 300;
    const H = 56;
    const padX = 2, padY = 6;
    const n = points.length;

    const capitals = points.map(p => p.capital);
    let min = Math.min(...capitals, initial);
    let max = Math.max(...capitals, initial);
    if (max === min) { max = min + 1; } // evitar división por cero
    const range = max - min;

    const xAt = (i) => padX + (i / (n - 1)) * (W - padX * 2);
    const yAt = (v) => padY + (1 - (v - min) / range) * (H - padY * 2);

    const linePath = points.map((p, i) =>
        `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(2)} ${yAt(p.capital).toFixed(2)}`
    ).join(' ');
    const areaPath = `${linePath} L ${xAt(n - 1).toFixed(2)} ${(H - padY).toFixed(2)} L ${xAt(0).toFixed(2)} ${(H - padY).toFixed(2)} Z`;

    const last = points[points.length - 1].capital;
    // Marca "Bento OLED": línea en degradado azul→cian eléctrico (--jt-c1 → --jt-c2)
    // y área cian. Los acentos son idénticos en tema claro y oscuro.
    const sparkC1 = '#4facfe';
    const sparkC2 = '#00f2fe';

    // Punto final destacado
    const lastX = xAt(n - 1);
    const lastY = yAt(last);

    container.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="jt-spark-line" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="${sparkC1}" />
            <stop offset="100%" stop-color="${sparkC2}" />
          </linearGradient>
          <linearGradient id="jt-spark-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${sparkC2}" stop-opacity="0.22" />
            <stop offset="100%" stop-color="${sparkC2}" stop-opacity="0" />
          </linearGradient>
        </defs>
        <path d="${areaPath}" fill="url(#jt-spark-fill)" />
        <path d="${linePath}" fill="none" stroke="url(#jt-spark-line)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <line class="kpi-sparkline-hover-line" id="spark-vline" x1="0" y1="${padY}" x2="0" y2="${H - padY}" />
        <circle class="kpi-sparkline-dot" id="spark-dot-end" cx="${lastX.toFixed(2)}" cy="${lastY.toFixed(2)}" r="3.5" stroke="${sparkC2}" />
        <circle class="kpi-sparkline-dot" id="spark-dot" cx="0" cy="0" r="0" stroke="${sparkC2}" style="opacity:0" />
      </svg>
      <div class="kpi-sparkline-tooltip" id="spark-tooltip">
        <div class="tt-date"></div>
        <div class="tt-value"></div>
      </div>
    `;

    // Meta: variación vs el inicio de la ventana visible. Formato según modo.
    if (metaEl) {
        const startCap = points[0].capital;
        const delta = last - startCap;
        const cls = delta > 0 ? 'gain' : (delta < 0 ? 'loss' : '');
        const body = delta === 0 ? formatAmount(0) : formatAmount(delta, { showSign: true });
        metaEl.innerHTML = `<span>${n} días · </span><span class="${cls}">${body}</span>`;
    }

    // Hover interactivo: encontrar el punto más cercano según x del mouse
    const svg = container.querySelector('svg');
    const tooltip = container.querySelector('#spark-tooltip');
    const ttDate = tooltip.querySelector('.tt-date');
    const ttValue = tooltip.querySelector('.tt-value');
    const vline = container.querySelector('#spark-vline');
    const dot = container.querySelector('#spark-dot');

    const onMove = (e) => {
        const rect = svg.getBoundingClientRect();
        const xPx = e.clientX - rect.left;
        const xViewbox = (xPx / rect.width) * W;
        // Buscar el i más cercano
        let bestI = 0;
        let bestDist = Infinity;
        for (let i = 0; i < n; i++) {
            const d = Math.abs(xAt(i) - xViewbox);
            if (d < bestDist) { bestDist = d; bestI = i; }
        }
        const px = xAt(bestI);
        const py = yAt(points[bestI].capital);
        const cssX = (px / W) * rect.width;
        const cssY = (py / H) * rect.height;

        vline.setAttribute('x1', px.toFixed(2));
        vline.setAttribute('x2', px.toFixed(2));
        vline.style.opacity = '1';
        dot.setAttribute('cx', px.toFixed(2));
        dot.setAttribute('cy', py.toFixed(2));
        dot.setAttribute('r', '4');
        dot.style.opacity = '1';

        const dateLabel = points[bestI].dateKey || 'Inicial';
        ttDate.innerText = dateLabel;
        ttValue.innerText = formatAmount(points[bestI].capital);
        tooltip.style.left = cssX + 'px';
        tooltip.style.top = cssY + 'px';
        tooltip.classList.add('is-visible');
    };
    const onLeave = () => {
        vline.style.opacity = '0';
        dot.style.opacity = '0';
        dot.setAttribute('r', '0');
        tooltip.classList.remove('is-visible');
    };
    svg.addEventListener('mousemove', onMove);
    svg.addEventListener('mouseleave', onLeave);
    svg.addEventListener('touchmove', (e) => { if (e.touches[0]) onMove(e.touches[0]); }, { passive: true });
    svg.addEventListener('touchend', onLeave);
}

// Re-render del sparkline al redimensionar la ventana (debounced)
let __sparkResizeTimer = null;
window.addEventListener('resize', () => {
    if (__sparkResizeTimer) clearTimeout(__sparkResizeTimer);
    __sparkResizeTimer = setTimeout(() => {
        try { renderCapitalSparkline(); } catch (e) {}
    }, 150);
});

async function initCapitalFeature() {
    try { await loadCapitalConfig(); } catch (e) { /* ignore */ }
    try { setupCapitalInput(); } catch (e) { /* ignore */ }
    // Sincronizar la UI con el modo de visualización cargado (placeholders, toggle).
    try { refreshDisplayModeUI(); } catch (e) { /* ignore */ }
    renderCapitalDisplays(getCurrentNet());
    scheduleCapitalRecalc(0);
}

// ==================== HEATMAP MENSUAL ====================
// Devuelve HTML de un mini-calendario donde cada día tradeado del mes se colorea
// según signo (verde/rojo) y la intensidad escala con |net| relativa al máximo del mes.
function renderMonthHeatmap(year, month, weeks) {
    // Construir mapa dateKey -> netDelDía a partir de las semanas del mes
    const dayNet = {}; // dateKey -> { net, tp, sl }
    let maxAbs = 0;
    Object.values(weeks || {}).forEach(wk => {
        (wk.days || []).forEach(d => {
            dayNet[d.dateKey] = { net: d.net, tp: d.tp, sl: d.sl };
            if (Math.abs(d.net) > maxAbs) maxAbs = Math.abs(d.net);
        });
    });

    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0); // último día del mes
    const daysInMonth = last.getDate();
    // Día de la semana del primer día (lunes=1 ... domingo=7)
    const firstDow = first.getDay() || 7;
    const todayKey = localDateKey(new Date());

    // Total de celdas (incluye relleno antes del día 1) para llenar grid de 7 columnas
    const leadingBlanks = firstDow - 1; // 0..6
    const totalCells = leadingBlanks + daysInMonth;
    const trailingBlanks = (7 - (totalCells % 7)) % 7;

    const intensity = (absNet) => {
        if (maxAbs <= 0) return 0;
        const r = absNet / maxAbs;
        if (r >= 0.66) return 3;
        if (r >= 0.33) return 2;
        return 1;
    };

    const cells = [];
    // Headers L M X J V S D (semana ISO)
    const headers = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
    let html = `
      <div class="heatmap" role="group" aria-label="Calendario del mes">
        <div class="heatmap-header">${headers.map(h => `<span>${h}</span>`).join('')}</div>
        <div class="heatmap-grid">`;

    for (let i = 0; i < leadingBlanks; i++) {
        html += `<div class="heatmap-cell is-out" aria-hidden="true"></div>`;
    }
    for (let day = 1; day <= daysInMonth; day++) {
        const d = new Date(year, month, day);
        const dk = localDateKey(d);
        const info = dayNet[dk];
        const isToday = (dk === todayKey);
        let cls = 'heatmap-cell';
        let title = '';
        let pctHtml = '';
        if (info) {
            cls += ' has-trade';
            if (info.net > 0) cls += ' win-' + intensity(Math.abs(info.net));
            else if (info.net < 0) cls += ' loss-' + intensity(Math.abs(info.net));
            const sign = info.net > 0 ? '+' : (info.net < 0 ? '−' : '');
            const absNet = Math.abs(info.net);
            // Tooltip completo: usa formatAmount para respetar el modo $/% activo.
            const fullAmount = formatAmount(info.net, { showSign: true });
            // Versión compacta dentro de la celda (1 decimal o sin decimales si es entero)
            const unit = getDisplayMode() === 'percent' ? '%' : '';
            const compactAmount = absNet >= 100
                ? `${sign}${Math.round(absNet)}${unit}`
                : `${sign}${absNet.toFixed(1)}${unit}`;
            title = `${day}: ${fullAmount} (TP ${formatAmount(info.tp, { showSign: true })} / SL ${formatAmount(-info.sl, { showSign: true })})`;
            pctHtml = `<div class="heatmap-cell-pct">${compactAmount}</div>`;
        } else {
            cls += ' is-empty-day';
            title = `${day} – sin trades`;
        }
        if (isToday) cls += ' is-today';
        html += `<div class="${cls}" data-date-key="${dk}" data-day="${day}" title="${title}">
            <div class="heatmap-cell-day">${day}</div>
            ${pctHtml}
        </div>`;
    }
    for (let i = 0; i < trailingBlanks; i++) {
        html += `<div class="heatmap-cell is-out" aria-hidden="true"></div>`;
    }

    html += `</div>
        <div class="heatmap-legend">
            <span>Pérdida</span>
            <span class="heatmap-legend-scale">
                <span class="heatmap-cell loss-3"></span>
                <span class="heatmap-cell loss-2"></span>
                <span class="heatmap-cell loss-1"></span>
                <span class="heatmap-cell"></span>
                <span class="heatmap-cell win-1"></span>
                <span class="heatmap-cell win-2"></span>
                <span class="heatmap-cell win-3"></span>
            </span>
            <span>Ganancia</span>
        </div>
      </div>`;
    return html;
}

// Click en un día del heatmap → navegar a esa fecha (manteniendo resúmenes abiertos)
function wireHeatmapInteractions(container) {
    if (!container) return;
    container.addEventListener('click', (e) => {
        const cell = e.target.closest('.heatmap-cell.has-trade');
        if (!cell) return;
        const dk = cell.dataset.dateKey;
        if (!dk) return;
        const picker = document.getElementById('datePicker');
        if (picker) {
            picker.value = dk;
            try { localStorage.setItem(DATE_STORAGE_KEY, dk); } catch (err) {}
        }
        try { loadData(); } catch (err) {}
        try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (err) {}
    });
}

// Debounce para generación de resúmenes: evita llamadas redundantes y chequea visibilidad
let __generateSummariesTimer = null;
function scheduleGenerateSummaries(delay = 250) {
    // Si la sección de resúmenes está oculta, no hacemos nada
    try {
        const section = document.getElementById('summaries-section');
        if (!section || section.classList.contains('hidden')) return;
    } catch (e) { return; }

    if (window._isGeneratingSummaries) return;
    if (__generateSummariesTimer) clearTimeout(__generateSummariesTimer);
    __generateSummariesTimer = setTimeout(() => {
        __generateSummariesTimer = null;
        try { generateSummaries(); } catch (e) { console.warn('generateSummaries error (scheduled):', e); }
    }, delay);
}

function loadData() {
    const date = datePicker.value;
    const storageKey = `trading_${date}`;
    const stored = localStorage.getItem(storageKey);
    const parsed = stored ? JSON.parse(stored) : null;
    currentData = parsed ? parsed : { tps: [], sls: [] };

    normalizeCurrentData();
    renderUI();
    scheduleCapitalRecalc();
    renderCapitalDisplays(getCurrentNet());
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

    ensureJournalCollectionListener();

    const db = window._firebase.db;
    const docRef = window.firebaseFirestoreDoc(db, 'users', uid, 'journals', date);

    try {
        // 1) Leer una vez para inicializar la UI
        const snap = await window.firebaseFirestoreGetDoc(docRef);
        if (snap && snap.exists && snap.exists()) {
            // Existe documento remoto: es la fuente de verdad, sin excepciones.
            // (Si está vacío, queremos que la UI también esté vacía — no resucitar
            // datos viejos del localStorage de este dispositivo.)
            const remote = snap.data() || { tps: [], sls: [] };
            currentData = {
                tps: Array.isArray(remote.tps) ? remote.tps : [],
                sls: Array.isArray(remote.sls) ? remote.sls : []
            };
            // Sincronizar el cache local con lo que dice la nube
            try { localStorage.setItem(`trading_${date}`, JSON.stringify(currentData)); } catch (e) { /* ignore */ }
        } else {
            // El doc remoto NO existe para esta fecha. Como hay sesión iniciada,
            // Firestore manda: la fecha no tiene datos. Limpiamos currentData
            // y removemos cualquier cache local viejo de esta fecha para que no
            // resucite ni se vuelva a subir a la nube.
            currentData = { tps: [], sls: [] };
            try { localStorage.removeItem(`trading_${date}`); } catch (e) { /* ignore */ }
        }
        normalizeCurrentData();
        renderUI();
        scheduleCapitalRecalc();

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
                        // Si el usuario está editando o viendo detalles, dejamos
                        // pasar este snapshot — re-renderizar destruiría el panel.
                        if (isAnyRowEditorOpen()) return;
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
                                // Sincronizar localStorage y cache en memoria con la
                                // verdad remota. Antes evitábamos esto para no pisar
                                // datos offline; ahora el contrato es claro: cuando hay
                                // sesión iniciada, Firestore manda. Sin esto,
                                // fetchAllJournalsMerged leía localStorage stale al
                                // recalcular el capital y se quedaba desfasado.
                                try { localStorage.setItem(`trading_${date}`, JSON.stringify(currentData)); } catch (e) { /* ignore */ }
                                try { __journalCache.set(date, currentData); } catch (e) { /* ignore */ }
                                renderUI();
                                scheduleCapitalRecalc();
                                scheduleGenerateSummaries();
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
    scheduleCapitalRecalc();

    // Generar resúmenes si están visibles
    scheduleGenerateSummaries();

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

        // éxito: solo actualiza el indicador visual del estado de sync (sin toast)
        if (statusSync) {
            statusSync.classList.remove('animate-pulse','bg-yellow-400');
            statusSync.classList.add('bg-green-400');
            statusSync.title = 'Sincronización OK';
        }
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
    // Firestore ya gestiona la reconexión; solo guardamos.
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
        // Normalizar antes de subir: migra entradas legacy (t1/t2/t3 → targets[]),
        // limpia campos malformados, garantiza shape consistente en Firestore.
        const payload = normalizeJournalData(currentData);
        await window.firebaseFirestoreSetDoc(docRef, payload);
    } catch (err) {
        console.error('Error guardando en Firestore', err);
        throw err;
    }
}

// --- MIGRACIÓN localStorage -> Firestore ---
// Devuelve todas las fechas (YYYY-MM-DD) que tienen datos en localStorage
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

// Migra datos locales de múltiples días a Firestore.
// - Si confirmIfNeeded = true: muestra un modal de confirmación.
// - Si confirmIfNeeded = false: ejecuta en background sin preguntar (modo automático).
async function migrateLocalToFirestore(confirmIfNeeded = true) {
    const localDates = getLocalTradingKeys();
    if (localDates.length === 0) {
        // En modo automático no molestamos al usuario.
        if (confirmIfNeeded) {
            showToast('No hay datos locales para sincronizar', 'info');
        }
        return { migrated: 0, skippedExisting: 0 };
    }

    const uid = window._firebase && window._firebase.uid;
    if (!uid) {
        if (confirmIfNeeded) {
            showToast('Necesitas iniciar sesión para sincronizar', 'error');
        }
        return { migrated: 0, skippedExisting: 0 };
    }

    if (confirmIfNeeded) {
        const ok = await showConfirmModal(`Se encontraron ${localDates.length} día(s) con datos en este dispositivo. ¿Deseas subirlos a tu cuenta en la nube?`);
        if (!ok) return;
    }

    try {
        if (window.ensureFirestoreOnline) await window.ensureFirestoreOnline();
    } catch (e) {
        console.warn('No se pudo asegurar red antes de migrar:', e);
    }

    const db = window._firebase.db;
    let migrated = 0;
    let skippedExisting = 0;
    for (const dateKey of localDates) {
        try {
            const raw = localStorage.getItem(`trading_${dateKey}`);
            if (!raw) continue;
            const data = JSON.parse(raw);

            const docRef = window.firebaseFirestoreDoc(db, 'users', uid, 'journals', dateKey);
            const snap = await window.firebaseFirestoreGetDoc(docRef);
            if (snap && snap.exists && snap.exists()) {
                // Documento ya existe en Firestore
                const existing = snap.data();
                const emptyExisting = (!existing || ((!existing.tps || existing.tps.length===0) && (!existing.sls || existing.sls.length===0)));
                const emptyLocal = ((!data.tps || data.tps.length===0) && (!data.sls || data.sls.length===0));

                if (!emptyExisting) {
                    // Ya hay datos remotos: no migramos pero lo contamos como "saltado".
                    skippedExisting++;
                    console.log('Saltando', dateKey, 'ya existe en Firestore');
                    continue;
                }
                if (emptyLocal) {
                    continue;
                }
            }

            await window.firebaseFirestoreSetDoc(docRef, data);
            migrated++;
        } catch (err) {
            console.warn('Error migrando', dateKey, err);
        }
    }

    // Mostrar mensajes sólo cuando tiene sentido
    if (confirmIfNeeded) {
        if (migrated > 0) {
            const extra = skippedExisting > 0 ? ` (${skippedExisting} día(s) ya estaban en la nube)` : '';
            showToast(`Sincronizados ${migrated} día(s) a Firestore${extra}`, 'success');
        } else if (skippedExisting > 0) {
            showToast('Todos los días locales ya existían en la nube. No se migraron cambios.', 'info');
        } else {
            showToast('No se migraron datos (vacíos o sin cambios)', 'info');
        }
    }

    // refrescar UI con datos desde Firestore si el datePicker cae en un día migrado
    await loadDataFirestore();

    return { migrated, skippedExisting };
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

async function addEntry(type) {
    if (type !== 'tp' && type !== 'sl') return;

    // Si el usuario no está autenticado, mostrar advertencia (y respetar preferencia)
    const uid = window._firebase && window._firebase.uid;
    if (!uid) {
        const ok = await showAddWarningIfNeeded();
        if (!ok) return;
    }

    const inputId = type === 'tp' ? 'tp-input' : 'sl-input';
    const assetId = type === 'tp' ? 'tp-asset' : 'sl-asset';

    const input = document.getElementById(inputId);
    const assetInput = document.getElementById(assetId);
    if (!input) return;

    // Lee el input según el modo de visualización: $ directo o % → $.
    const value = inputValueToDollars(input.value);
    const asset = (assetInput && assetInput.value || '').trim().toUpperCase();

    if (!Number.isFinite(value) || value <= 0) {
        showToast('Ingresa un monto válido (mayor a 0)', 'error');
        input.focus();
        return;
    }

    // Tope sano: prevenir typos absurdos (ej. añadir un cero de más)
    if (value > 1000000) {
        showToast('El monto parece demasiado alto. Verifica el valor.', 'error');
        input.focus();
        return;
    }

    const entry = {
        id: Date.now() + Math.floor(Math.random() * 1000), // evitar colisión si se añaden 2 en el mismo ms
        value: Math.round(value * 100) / 100, // normalizar a 2 decimales
        asset: asset || '---'
    };

    // Detalles opcionales del panel expandible
    const details = readAddDetailsPanel(type);
    if (details) {
        // Validación de coherencia LONG/SHORT vs entry/SL/targets
        const errs = validateTradePrices(details.side, details.entry, details.sl, details.targets);
        if (Object.keys(errs).length) {
            const panel = document.getElementById(`${type}-details-panel`);
            const firstMsg = applyValidationErrors(panel, errs, { slSelector: `#${type}-sl-price` });
            showToast(firstMsg, 'error', 5000);
            return;
        }
        entry.details = details;
    }

    if (type === 'tp') currentData.tps.push(entry);
    else currentData.sls.push(entry);

    input.value = '';
    if (assetInput) assetInput.value = '';
    clearAddDetailsPanel(type);
    saveData();
    // Devolver foco al campo de activo para encadenar entradas rápido
    if (assetInput) assetInput.focus();
}

// Lee el panel "+ Detalles del trade" del formulario de alta y devuelve un
// objeto details limpio (o null si no hay nada que guardar).
function readAddDetailsPanel(type) {
    const $ = (id) => document.getElementById(id);
    const get = (suffix) => {
        const el = $(`${type}-${suffix}`);
        return el ? el.value : '';
    };
    const panel = document.getElementById(`${type}-details-panel`);
    const targets = panel
        ? Array.from(panel.querySelectorAll('.target-input')).map(el => Number(el.value)).filter(v => Number.isFinite(v) && v > 0)
        : [];
    const raw = {
        side: get('side'),
        leverage: get('leverage'),
        entry: get('entry'),
        sl: get('sl-price'),
        notes: get('notes'),
        targets
    };
    return sanitizeDetails(raw);
}

function clearAddDetailsPanel(type) {
    const ids = ['side', 'leverage', 'entry', 'sl-price', 'notes'];
    ids.forEach(suffix => {
        const el = document.getElementById(`${type}-${suffix}`);
        if (el) el.value = '';
    });
    // Resetear targets: dejar solo T1 vacío, eliminar slots adicionales que
    // se hayan añadido dinámicamente.
    const panel = document.getElementById(`${type}-details-panel`);
    if (panel) {
        const slots = panel.querySelectorAll('[data-target-slot]');
        slots.forEach((slot, i) => {
            if (i === 0) {
                const input = slot.querySelector('input');
                if (input) input.value = '';
            } else {
                slot.remove();
            }
        });
    }
    const addBtn = document.querySelector(`[data-add-target="${type}"]`);
    if (addBtn) addBtn.classList.remove('hidden');
}

// Añade un nuevo slot de target al final del grid (sin límite).
function addTargetSlot(type) {
    const panel = document.getElementById(`${type}-details-panel`);
    if (!panel) return;
    const grid = panel.querySelector('.details-grid');
    if (!grid) return;
    const existing = grid.querySelectorAll('[data-target-slot]');
    const next = existing.length + 1;

    const newSlot = document.createElement('label');
    newSlot.className = 'details-field';
    newSlot.setAttribute('data-target-slot', '');
    newSlot.setAttribute('data-target-index', String(next));
    newSlot.innerHTML = `
        <span>Target ${next}</span>
        <input type="number" step="any" placeholder="0.00" class="details-input target-input" inputmode="decimal" />
    `;

    const lastSlot = existing[existing.length - 1];
    if (lastSlot && lastSlot.parentNode) {
        lastSlot.parentNode.insertBefore(newSlot, lastSlot.nextSibling);
    } else {
        grid.appendChild(newSlot);
    }
    const input = newSlot.querySelector('input');
    if (input) try { input.focus(); } catch (e) { /* ignore */ }
}

function toggleAddDetails(type) {
    const panel = document.getElementById(`${type}-details-panel`);
    const btn = document.querySelector(`[data-details-toggle="${type}"]`);
    if (!panel) return;
    const willOpen = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willOpen);
    if (btn) {
        btn.classList.toggle('is-open', willOpen);
        btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    }
    if (willOpen) {
        // Auto-foco al primer campo del panel
        const first = document.getElementById(`${type}-leverage`);
        if (first) try { first.focus(); } catch (e) { /* ignore */ }
    }
}

async function deleteEntry(type, id) {
    // Confirmación antes de eliminar (acción no reversible)
    const label = type === 'tp' ? 'este Take Profit' : 'este Stop Loss';
    const ok = await showConfirmModal(`¿Eliminar ${label}? Esta acción no se puede deshacer.`);
    if (!ok) return;

    // Animar salida si la fila está visible, luego borrar
    const row = document.querySelector(`[data-entry-id="${id}"][data-entry-type="${type}"]`);
    const finalize = () => {
        if (type === 'tp') currentData.tps = currentData.tps.filter(item => item.id !== id);
        else currentData.sls = currentData.sls.filter(item => item.id !== id);
        // Quitar el elemento del DOM directamente: si hay un editor abierto,
        // renderUI() no rehace las listas, así que el borrado debe reflejarse aquí.
        if (row && row.parentNode) row.remove();
        saveData();
    };
    if (row) {
        row.classList.add('is-leaving');
        setTimeout(finalize, 220);
    } else {
        finalize();
    }
}

// Construye el HTML del editor expandido para una fila ya guardada.
function buildRowEditorHTML(type, id, item) {
    const det = (item && item.details) || {};
    const v = (x) => (x == null || x === '' ? '' : x);

    // Targets: siempre mostrar al menos 1. Si la entrada tiene targets[],
    // mostramos uno por cada valor. El usuario puede añadir más con el botón.
    const savedTargets = Array.isArray(det.targets) ? det.targets : [];
    const initialCount = Math.max(1, savedTargets.length);
    let targetsHTML = '';
    for (let i = 1; i <= initialCount; i++) {
        const val = (i <= savedTargets.length) ? savedTargets[i - 1] : '';
        targetsHTML += `
            <label class="details-field" data-row-target-slot="${i}">
                <span>Target ${i}</span>
                <input type="number" step="any" class="details-input target-input" value="${v(val)}" inputmode="decimal" placeholder="0.00" />
            </label>
        `;
    }

    return `
        <div class="details-grid">
            <label class="details-field">
                <span>Activo (par)</span>
                <input type="text" class="details-input" data-field="asset" value="${(item.asset || '').replace(/"/g,'&quot;')}" placeholder="BTC" />
            </label>
            <label class="details-field">
                <span>${type === 'tp' ? `Ganancia (${getDisplayMode() === 'percent' ? '%' : '$'})` : `Pérdida (${getDisplayMode() === 'percent' ? '%' : '$'})`}</span>
                <input type="number" step="0.01" min="0.01" class="details-input" data-field="value" value="${dollarsToInputValue(item.value || 0)}" inputmode="decimal" />
            </label>
            <label class="details-field">
                <span>Tipo</span>
                <select class="details-input" data-field="side">
                    <option value="">—</option>
                    <option value="LONG"${det.side === 'LONG' ? ' selected' : ''}>LONG</option>
                    <option value="SHORT"${det.side === 'SHORT' ? ' selected' : ''}>SHORT</option>
                </select>
            </label>
            <label class="details-field">
                <span>Apalancamiento</span>
                <div class="details-input-wrap">
                    <input type="number" step="1" min="1" class="details-input details-input-with-suffix" data-field="leverage" value="${v(det.leverage)}" inputmode="numeric" placeholder="0" />
                    <span class="details-input-suffix">X</span>
                </div>
            </label>
            <label class="details-field">
                <span>Precio entrada</span>
                <input type="number" step="any" class="details-input" data-field="entry" value="${v(det.entry)}" inputmode="decimal" placeholder="0.00" />
            </label>
            <label class="details-field">
                <span>Stop Loss</span>
                <input type="number" step="any" class="details-input" data-field="sl" value="${v(det.sl)}" inputmode="decimal" placeholder="0.00" />
            </label>
            ${targetsHTML}
            <label class="details-field details-field-wide">
                <span>Notas</span>
                <textarea rows="2" class="details-input details-textarea" data-field="notes" maxlength="500" placeholder="Análisis, contexto, lección...">${(det.notes || '').replace(/</g,'&lt;')}</textarea>
            </label>
        </div>
        <button type="button" class="details-add-target" data-row-add-target onclick="addRowTargetSlot('${type}', ${id})">
            <i class="ph ph-plus"></i> Añadir target
        </button>
        <div class="row-editor-actions">
            <button type="button" class="row-editor-btn" onclick="cancelEdit('${type}', ${id})">Cancelar</button>
            <button type="button" class="row-editor-btn is-primary" onclick="saveEdit('${type}', ${id})">Guardar</button>
        </div>
    `;
}

// Añade un nuevo slot de target al editor inline (sin límite).
function addRowTargetSlot(type, id) {
    const editor = document.getElementById(`row-editor-${type}-${id}`);
    if (!editor) return;
    const existing = editor.querySelectorAll('[data-row-target-slot]');
    const next = existing.length + 1;

    const newSlot = document.createElement('label');
    newSlot.className = 'details-field';
    newSlot.setAttribute('data-row-target-slot', String(next));
    newSlot.innerHTML = `
        <span>Target ${next}</span>
        <input type="number" step="any" class="details-input target-input" inputmode="decimal" placeholder="0.00" />
    `;

    const lastSlot = existing[existing.length - 1];
    if (lastSlot && lastSlot.parentNode) {
        lastSlot.parentNode.insertBefore(newSlot, lastSlot.nextSibling);
    } else {
        const grid = editor.querySelector('.details-grid');
        if (grid) grid.appendChild(newSlot);
    }
    const input = newSlot.querySelector('input');
    if (input) try { input.focus(); } catch (e) { /* ignore */ }
}

// Alterna el editor: si está abierto lo cierra, si no lo abre.
function toggleEdit(type, id) {
    const editor = document.getElementById(`row-editor-${type}-${id}`);
    if (editor && !editor.classList.contains('hidden')) {
        cancelEdit(type, id);
    } else {
        startEdit(type, id);
    }
}

// Abre el editor expandido inline para una fila concreta.
function startEdit(type, id) {
    // Cerrar cualquier otro editor de fila abierto
    document.querySelectorAll('.row-editor:not(.hidden)').forEach(el => {
        el.classList.add('hidden');
        el.innerHTML = '';
    });
    document.querySelectorAll('.trade-entry-row.is-expanded').forEach(el => el.classList.remove('is-expanded'));

    const list = type === 'tp' ? currentData.tps : currentData.sls;
    const item = list.find(i => i.id === id);
    const editor = document.getElementById(`row-editor-${type}-${id}`);
    if (!item || !editor) return;

    editor.innerHTML = buildRowEditorHTML(type, id, item);
    editor.classList.remove('hidden');

    // Marcar la fila como expandida (para el estilo visual)
    const wrapper = editor.closest('.trade-entry-wrapper');
    const row = wrapper && wrapper.querySelector('.trade-entry-row');
    if (row) row.classList.add('is-expanded');

    // Foco al primer campo
    const firstInput = editor.querySelector('input, select, textarea');
    if (firstInput) try { firstInput.focus(); firstInput.select && firstInput.select(); } catch (e) { /* ignore */ }
}

function cancelEdit(type, id) {
    const editor = document.getElementById(`row-editor-${type}-${id}`);
    if (!editor) return;
    editor.classList.add('hidden');
    editor.innerHTML = '';
    const wrapper = editor.closest('.trade-entry-wrapper');
    const row = wrapper && wrapper.querySelector('.trade-entry-row');
    if (row) row.classList.remove('is-expanded');

    // Tras cerrar el panel, recuperamos cualquier actualización remota que
    // hayamos saltado mientras estaba abierto (re-render + fetch fresco).
    try { renderUI(); } catch (e) { /* ignore */ }
    setTimeout(() => {
        try { resyncFromFirestore('after-edit-close'); } catch (e) { /* ignore */ }
    }, 50);
}

function saveEdit(type, id) {
    const list = type === 'tp' ? currentData.tps : currentData.sls;
    const item = list.find(i => i.id === id);
    if (!item) return;

    const editor = document.getElementById(`row-editor-${type}-${id}`);
    if (!editor) return;

    const get = (field) => {
        const el = editor.querySelector(`[data-field="${field}"]`);
        return el ? el.value : '';
    };

    // El input "value" viene en el modo activo ($ o %). Lo convertimos a $.
    const newValueDollars = inputValueToDollars(get('value'));
    if (!Number.isFinite(newValueDollars) || newValueDollars <= 0) {
        showToast('Monto inválido', 'error');
        return;
    }
    if (newValueDollars > 1000000) {
        showToast('Monto demasiado alto', 'error');
        return;
    }

    item.value = Math.round(newValueDollars * 100) / 100;
    item.asset = (get('asset') || '').trim().toUpperCase() || '---';

    const targets = Array.from(editor.querySelectorAll('.target-input'))
        .map(el => Number(el.value))
        .filter(v => Number.isFinite(v) && v > 0);

    // Validación de coherencia LONG/SHORT vs entry/SL/targets antes de
    // construir los detalles definitivos.
    const validationErrs = validateTradePrices(get('side'), get('entry'), get('sl'), targets);
    if (Object.keys(validationErrs).length) {
        const firstMsg = applyValidationErrors(editor, validationErrs);
        showToast(firstMsg, 'error', 5000);
        return;
    }

    const det = sanitizeDetails({
        side: get('side'),
        leverage: get('leverage'),
        entry: get('entry'),
        sl: get('sl'),
        notes: get('notes'),
        targets
    });
    if (det) item.details = det;
    else delete item.details;

    cancelEdit(type, id);
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
    const ok = await showConfirmModal('¿Eliminar todos los datos locales y en la nube? Esta acción es irreversible. ¿Deseas continuar?');
    if (!ok) return;

    // Desactivar listeners para evitar que snapshots repueblen localStorage mientras borramos
    try { cleanupJournalCollectionListener(); } catch (e) { /* ignore */ }
    try { if (typeof _unsubscribeJournalListener === 'function') { _unsubscribeJournalListener(); _unsubscribeJournalListener = null; } } catch (e) { /* ignore */ }

    // 1) Borrar todas las claves locales tipo trading_YYYY-MM-DD
    let removedLocal = 0;
    // iterar en reversa para evitar problemas al eliminar mientras se recorre
    for (let i = localStorage.length - 1; i >= 0; i--) {
        try {
            const k = localStorage.key(i);
            if (!k) continue;
            if (k.startsWith('trading_')) {
                localStorage.removeItem(k);
                removedLocal++;
            }
        } catch (e) {
            console.warn('Error borrando clave localStorage', e);
        }
    }

    // Reset UI state y datos en memoria
    // Limpiar caché en memoria y estado actual sin volver a persistir nada
    try { __journalCache.clear(); } catch (e) { /* ignore */ }
    currentData = { tps: [], sls: [] };
    normalizeCurrentData();
    renderUI();
    scheduleCapitalRecalc();
    // Limpiar los contenedores de resúmenes para que no se muestren datos antiguos
    try {
        const monthlyContainer = document.getElementById('monthly-summaries'); if (monthlyContainer) monthlyContainer.innerHTML = '';
        const summariesSection = document.getElementById('summaries-section'); if (summariesSection) summariesSection.classList.add('hidden');
    } catch (e) { /* ignore */ }

    // No volver a guardar datos vacíos localmente; en su lugar, forzar recarga desde Firestore tras eliminar en la nube

    showToast(removedLocal > 0 ? `Eliminados ${removedLocal} día(s) en este dispositivo` : 'No se encontraron datos locales', 'success', 2200);

    // 2) Si estamos autenticados, intentar eliminar documentos en Firestore
    try {
        const uid = window._firebase && window._firebase.uid;
        const db = window._firebase && window._firebase.db;
        if (uid && db) {
            // Usar import dinámico para disponer de deleteDoc/getDocs
            const mod = await import('https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js');
            const { collection, getDocs, doc, deleteDoc } = mod;
            const collRef = collection(db, 'users', uid, 'journals');
            const snap = await getDocs(collRef);
            let deleted = 0;
            for (const d of snap.docs) {
                try {
                    await deleteDoc(doc(db, 'users', uid, 'journals', d.id));
                    deleted++;
                } catch (err) {
                    console.warn('No se pudo borrar documento', d.id, err);
                }
            }
            showToast(`Eliminados ${deleted} documento(s) en la nube`, 'success', 2400);
            // actualizar listeners/UI: recargar desde Firestore (vacío)
            // Nota: tras la eliminación no recreamos entradas locales automáticamente.
            try { await loadDataFirestore(); } catch (e) { /* ignore */ }
        }
    } catch (err) {
        console.error('Error eliminando datos en la nube', err);
        showToast('Ocurrió un error al eliminar datos en la nube', 'error', 4000);
    }

    // Hacer una pasada final para eliminar cualquier clave `trading_` que pudiera quedar
    try {
        let finalRemoved = 0;
        const keys = getLocalTradingKeys();
        for (const k of keys) {
            try { localStorage.removeItem(`trading_${k}`); finalRemoved++; } catch (e) { /* ignore */ }
        }
        if (finalRemoved > 0) {
            showToast(`Eliminados ${finalRemoved} día(s) restantes en local`, 'success', 2000);
        }
    } catch (e) {
        console.warn('Error en limpieza final de localStorage', e);
    }

    // Forzar limpieza de cachés y UI
    try { __journalCache.clear(); } catch (e) { /* ignore */ }
    try {
        const monthlyContainer = document.getElementById('monthly-summaries'); if (monthlyContainer) monthlyContainer.innerHTML = '';
    } catch (e) { /* ignore */ }

    // Recargar la página para que la UI se actualice inmediatamente
    try { setTimeout(() => { location.reload(); }, 150); } catch (e) { /* ignore */ }
}

// --- RENDERIZADO UI ---
// True si hay algún panel de fila abierto (vista o edición). Mientras esté
// abierto, no re-renderizamos las listas para no destruir el panel.
function isAnyRowEditorOpen() {
    return !!document.querySelector('.row-editor:not(.hidden)');
}

function renderUI() {
    // Si el usuario está editando o viendo detalles, no rehacemos las listas
    // (eso destruiría el panel abierto y perdería su trabajo). Los totales sí
    // se actualizan, no afectan al panel.
    if (isAnyRowEditorOpen()) {
        updateTotals();
        return;
    }
    renderList('tp', currentData.tps);
    renderList('sl', currentData.sls);
    updateTotals();
}

window.toggleListExpand = function (type) {
    __listExpanded[type] = !__listExpanded[type];
    renderList(type, type === 'tp' ? currentData.tps : currentData.sls);
};

function renderList(type, list) {
    const container = document.getElementById(type === 'tp' ? 'tp-list' : 'sl-list');
    container.innerHTML = '';

    if (list.length === 0) {
        container.innerHTML = '<div class="text-center text-slate-300 dark:text-slate-600 text-sm py-4">No hay registros</div>';
        return;
    }

    const valueColor = type === 'tp' ? 'gain' : 'loss';
    const sign = type === 'tp' ? '+' : '-';

    // Colapsar listas largas: muestra las más recientes + botón "Ver todos".
    const COLLAPSE_AT = 4;
    const expanded = !!__listExpanded[type];
    const collapsed = list.length > COLLAPSE_AT && !expanded;
    const visible = collapsed ? list.slice(-COLLAPSE_AT) : list;

    visible.forEach(item => {
        const safeValue = Number(item && item.value);
        const valueNum = Number.isFinite(safeValue) ? safeValue : 0;
        const safeAsset = (item && item.asset) ? String(item.asset) : '---';
        const hasDetails = !!(item && item.details && Object.keys(item.details).length);
        // Mostramos el monto según el modo activo. El signo lo da el tipo (TP/SL)
        // ya que internamente value siempre es positivo.
        const signedDollars = (type === 'tp' ? 1 : -1) * valueNum;
        const displayText = formatAmount(signedDollars, { showSign: true });

        const wrapper = document.createElement('div');
        wrapper.dataset.entryId = item.id;
        wrapper.dataset.entryType = type;
        wrapper.className = 'trade-entry-wrapper';

        wrapper.innerHTML = `
            <div class="trade-entry-row flex justify-between items-center group"
                 onclick="onRowClick(event, '${type}', ${item.id})">
                <div class="flex items-center gap-3 min-w-0 flex-1">
                    <span id="asset-${type}-${item.id}" class="font-bold text-slate-700 dark:text-slate-200 text-xs bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded">${safeAsset}</span>
                    <span id="value-${type}-${item.id}" data-value="${valueNum}" class="value-span font-bold ${valueColor} text-sm tabular-nums">${displayText}</span>
                    <span class="entry-details-badge ${hasDetails ? 'has-details' : ''}" title="${hasDetails ? 'Tiene detalles' : 'Sin detalles'}">
                        <i class="ph ${hasDetails ? 'ph-info' : 'ph-dots-three'}"></i>
                    </span>
                </div>
                <div class="entry-actions flex gap-3 items-center" onclick="event.stopPropagation()">
                    <button onclick="toggleEdit('${type}', ${item.id})" title="Editar" class="entry-action-btn entry-edit"><i class="ph ph-gear-six"></i></button>
                    <button onclick="deleteEntry('${type}', ${item.id})" title="Eliminar" class="entry-action-btn entry-delete"><i class="ph ph-x"></i></button>
                </div>
            </div>
            <div id="row-editor-${type}-${item.id}" class="row-editor hidden"></div>
        `;
        container.appendChild(wrapper);
    });

    if (list.length > COLLAPSE_AT) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'list-expand-btn w-full mt-2 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-slate-700/50 rounded py-2 transition flex items-center justify-center gap-1.5';
        btn.setAttribute('onclick', `toggleListExpand('${type}')`);
        btn.innerHTML = expanded
            ? '<i class="ph ph-caret-up"></i> Ver menos'
            : `<i class="ph ph-caret-down"></i> Ver todos (${list.length})`;
        container.appendChild(btn);
    }
}

// Click en cualquier parte de la fila (excepto los botones de acción) → toggle vista (read-only).
// Para editar, el usuario debe pulsar el botón ✎ explícitamente.
function onRowClick(event, type, id) {
    const target = event.target;
    if (target && target.closest && target.closest('.entry-action-btn')) return;

    const wrapper = document.querySelector(`[data-entry-id="${id}"][data-entry-type="${type}"]`);
    const row = wrapper && wrapper.querySelector('.trade-entry-row');
    if (!row) return;

    // Si el editor está abierto, tocar la barra NO lo cierra (solo el engranaje lo hace).
    const editor = document.getElementById(`row-editor-${type}-${id}`);
    if (editor && !editor.classList.contains('hidden')) {
        return;
    }

    // Mostrar/ocultar los botones de acción (x / engranaje). Cerramos los de otras filas.
    const wasOpen = row.classList.contains('show-actions');
    document.querySelectorAll('.trade-entry-row.show-actions')
        .forEach(el => el.classList.remove('show-actions'));
    if (!wasOpen) row.classList.add('show-actions');
}

// Abre el panel de la fila en modo solo-lectura (vista).
function viewRow(type, id) {
    document.querySelectorAll('.row-editor:not(.hidden)').forEach(el => {
        el.classList.add('hidden');
        el.innerHTML = '';
    });
    document.querySelectorAll('.trade-entry-row.is-expanded').forEach(el => el.classList.remove('is-expanded'));

    const list = type === 'tp' ? currentData.tps : currentData.sls;
    const item = list.find(i => i.id === id);
    const editor = document.getElementById(`row-editor-${type}-${id}`);
    if (!item || !editor) return;

    // Si la entrada no tiene detalles guardados, no hay nada que mostrar — abrir
    // directamente el editor para que el usuario pueda añadir información.
    const hasDetails = item.details && Object.keys(item.details).length > 0;
    if (!hasDetails) {
        startEdit(type, id);
        return;
    }

    editor.innerHTML = buildRowViewHTML(type, id, item);
    editor.classList.remove('hidden');
    const wrapper = editor.closest('.trade-entry-wrapper');
    const row = wrapper && wrapper.querySelector('.trade-entry-row');
    if (row) row.classList.add('is-expanded');
}

// HTML de la vista solo-lectura.
function buildRowViewHTML(type, id, item) {
    const det = (item && item.details) || {};
    const targets = Array.isArray(det.targets) ? det.targets : [];
    const isTP = type === 'tp';
    const sign = isTP ? '+' : '-';
    const valueColorClass = isTP ? 'view-value-green' : 'view-value-red';

    const items = [];
    items.push({ label: 'Activo', value: item.asset || '---' });
    {
        const signedDollars = (isTP ? 1 : -1) * Number(item.value || 0);
        items.push({
            label: isTP ? 'Ganancia' : 'Pérdida',
            value: formatAmount(signedDollars, { showSign: true }),
            cls: valueColorClass
        });
    }
    if (det.side) items.push({ label: 'Tipo', value: det.side });
    if (det.leverage) items.push({ label: 'Apalancamiento', value: `${det.leverage}X` });
    if (det.entry) items.push({ label: 'Precio entrada', value: formatPrice(det.entry) });
    if (det.sl) items.push({ label: 'Stop Loss', value: formatPrice(det.sl) });
    targets.forEach((t, i) => items.push({ label: `Target ${i + 1}`, value: formatPrice(t) }));

    const itemsHTML = items.map(it => `
        <div class="row-view-item">
            <span class="row-view-label">${escapeHTML(it.label)}</span>
            <span class="row-view-value ${it.cls || ''}">${escapeHTML(it.value)}</span>
        </div>
    `).join('');

    const notesHTML = det.notes ? `
        <div class="row-view-notes">
            <span class="row-view-label">Notas</span>
            <p class="row-view-notes-text">${escapeHTML(det.notes)}</p>
        </div>
    ` : '';

    return `
        <div class="row-view-grid">${itemsHTML}</div>
        ${notesHTML}
        <div class="row-editor-actions">
            <button type="button" class="row-editor-btn" onclick="cancelEdit('${type}', ${id})">Cerrar</button>
            <button type="button" class="row-editor-btn is-primary" onclick="startEdit('${type}', ${id})">
                <i class="ph ph-pencil-simple"></i> Editar
            </button>
        </div>
    `;
}

// Formatea un precio numérico para mostrar (sin "X" — ese se añade manualmente).
function formatPrice(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return '—';
    // Hasta 8 decimales para criptos pequeñas, sin ceros innecesarios.
    return num.toLocaleString('es-PE', { maximumFractionDigits: 8 });
}

// Valida la coherencia de precios según la dirección del trade (LONG/SHORT).
// Devuelve un objeto { sl?, t1?, t2?, ... } con mensajes de error por campo.
// Si no hay side/entry, no podemos validar — devolvemos {} (sin errores).
function validateTradePrices(side, entry, sl, targets) {
    const errors = {};
    const entryNum = Number(entry);
    if (!side || !Number.isFinite(entryNum) || entryNum <= 0) return errors;
    const isLong = side === 'LONG';

    const slNum = Number(sl);
    if (Number.isFinite(slNum) && slNum > 0) {
        if (isLong && slNum >= entryNum) {
            errors.sl = `En LONG el Stop Loss debe estar por debajo del precio de entrada (${entryNum})`;
        } else if (!isLong && slNum <= entryNum) {
            errors.sl = `En SHORT el Stop Loss debe estar por encima del precio de entrada (${entryNum})`;
        }
    }

    if (Array.isArray(targets)) {
        targets.forEach((t, i) => {
            const tNum = Number(t);
            if (!Number.isFinite(tNum) || tNum <= 0) return;
            if (isLong && tNum <= entryNum) {
                errors['t' + (i + 1)] = `En LONG el Target ${i + 1} debe estar por encima del precio de entrada (${entryNum})`;
            } else if (!isLong && tNum >= entryNum) {
                errors['t' + (i + 1)] = `En SHORT el Target ${i + 1} debe estar por debajo del precio de entrada (${entryNum})`;
            }
        });
    }

    return errors;
}

// Marca con `.is-invalid` los inputs correspondientes a los errores. Devuelve
// el primer mensaje (para mostrar en el toast).
// `container` puede ser el panel de alta o el editor inline de una fila.
function applyValidationErrors(container, errors, opts) {
    if (!container) return null;
    container.querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid'));
    if (!errors || !Object.keys(errors).length) return null;

    const slSelector = (opts && opts.slSelector) || '[data-field="sl"]';
    if (errors.sl) {
        const el = container.querySelector(slSelector);
        if (el) el.classList.add('is-invalid');
    }

    const targetInputs = container.querySelectorAll('.target-input');
    Object.keys(errors).forEach(k => {
        const m = k.match(/^t(\d+)$/);
        if (!m) return;
        const idx = parseInt(m[1], 10) - 1;
        if (targetInputs[idx]) targetInputs[idx].classList.add('is-invalid');
    });

    return Object.values(errors)[0];
}

function escapeHTML(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function bumpIfChanged(el, newText) {
    if (!el) return;
    if (el.innerText !== newText) {
        el.innerText = newText;
        el.classList.remove('total-bump');
        // Reflow para reiniciar la animación si se dispara dos veces seguidas
        void el.offsetWidth;
        el.classList.add('total-bump');
    }
}

function updateTotals() {
    const tpTotal = currentData.tps.reduce((acc, curr) => acc + (Number(curr && curr.value) || 0), 0);
    const slTotal = currentData.sls.reduce((acc, curr) => acc + (Number(curr && curr.value) || 0), 0);
    const net = tpTotal - slTotal;

    bumpIfChanged(document.getElementById('tp-total-display'), formatAmount(tpTotal));
    bumpIfChanged(document.getElementById('sl-total-display'), formatAmount(slTotal));
    bumpIfChanged(document.getElementById('footer-tp'), formatAmount(tpTotal, { showSign: true }));
    bumpIfChanged(document.getElementById('footer-sl'), formatAmount(-slTotal, { showSign: true }));

    const netEl = document.getElementById('footer-net');
    const colorClass = net > 0 ? 'gain' : (net < 0 ? 'loss' : 'text-slate-800 dark:text-slate-200');
    bumpIfChanged(netEl, formatAmount(net, { showSign: true }));
    if (netEl) netEl.className = "font-bold text-lg tabular-nums " + colorClass;

    renderCapitalDisplays(net);
}

// --- RESÚMENES ---
function toggleSummaries() {
    const section = document.getElementById('summaries-section');
    const btn = document.getElementById('btn-toggle-summary');
    
    section.classList.toggle('hidden');

    if (section.classList.contains('hidden')) {
        btn.innerHTML = '<i class="ph ph-chart-bar"></i> Ver Resúmenes';
    } else {
        btn.innerHTML = '<i class="ph ph-eye-slash"></i> Ocultar Resúmenes';
        generateSummaries();
    }
}
async function generateSummaries() {
    if (window._isGeneratingSummaries) {
        console.log('generateSummaries: ya en ejecución, omitiendo llamada duplicada');
        return;
    }
    window._isGeneratingSummaries = true;
    try { showSummariesLoading(); } catch(e) {}
    try {
        const monthlyContainer = document.getElementById('monthly-summaries');
        if (!monthlyContainer) return;
        monthlyContainer.innerHTML = '';

        // Recolectar todos los diarios disponibles (localStorage + Firestore)
        let allJournals = {};
        try {
            allJournals = await fetchAllJournalsMerged();
        } catch (e) {
            console.warn('No se pudieron leer todos los diarios para generar resúmenes', e);
            allJournals = {};
        }

        // Generar resumen mensual: una tarjeta por cada mes con trades registrados
        // (clicable; al expandir muestra las semanas tradeadas dentro del mes,
        //  y cada semana puede a su vez expandirse para ver sus días)
        if (monthlyContainer) {
            // 1) Agrupar diarios por mes y, dentro de cada mes, por semana (lunes)
            const monthsMap = {};
            // estructura:
            // ymKey -> {
            //   net, totalDays, winDays, lossDays, year, month,
            //   weeks: { mondayKey -> { monday, net, totalDays, winDays, lossDays, days: [{date,tp,sl,net,dateKey}] } }
            // }
            Object.keys(allJournals || {}).forEach(dateKey => {
                const data = allJournals[dateKey];
                if (!hasTrades(data)) return;
                const tp = (data.tps || []).reduce((s, it) => s + (Number(it.value) || 0), 0);
                const sl = (data.sls || []).reduce((s, it) => s + (Number(it.value) || 0), 0);
                const net = tp - sl;

                const d = new Date(dateKey + 'T00:00:00');
                const ymKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                // Calcular el lunes (ISO) de la semana de ese día
                const dow = d.getDay() || 7;
                const monday = new Date(d);
                monday.setDate(d.getDate() - dow + 1);
                const mondayKey = localDateKey(monday);

                if (!monthsMap[ymKey]) {
                    monthsMap[ymKey] = {
                        net: 0, totalDays: 0, winDays: 0, lossDays: 0,
                        year: d.getFullYear(), month: d.getMonth(), weeks: {}
                    };
                }
                const m = monthsMap[ymKey];
                m.net += net;
                m.totalDays++;
                if (net > 0) m.winDays++;
                else if (net < 0) m.lossDays++;

                if (!m.weeks[mondayKey]) {
                    m.weeks[mondayKey] = {
                        monday: new Date(monday),
                        net: 0, totalDays: 0, winDays: 0, lossDays: 0, days: []
                    };
                }
                const wk = m.weeks[mondayKey];
                wk.net += net;
                wk.totalDays++;
                if (net > 0) wk.winDays++;
                else if (net < 0) wk.lossDays++;
                wk.days.push({ date: new Date(d), tp, sl, net, dateKey });
            });

            const monthKeys = Object.keys(monthsMap).sort().reverse();

            if (monthKeys.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'muted-card p-4 text-center text-slate-400 dark:text-slate-500 text-sm';
                empty.innerText = 'Aún no has registrado trades en ningún mes.';
                monthlyContainer.appendChild(empty);
            } else {
                monthKeys.forEach(ymKey => {
                    const stats = monthsMap[ymKey];
                    const first = new Date(stats.year, stats.month, 1);
                    const monthName = first.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
                    const monthNameCap = monthName.charAt(0).toUpperCase() + monthName.slice(1);
                    const signM = stats.net > 0 ? '+' : (stats.net < 0 ? '−' : '');
                    const monthNetClass = stats.net > 0 ? 'gain' : (stats.net < 0 ? 'loss' : 'text-slate-800 dark:text-slate-200');
                    const winRate = stats.totalDays > 0 ? ((stats.winDays / stats.totalDays) * 100).toFixed(1) : '0.0';

                    const monthId = `month-${ymKey}`;
                    const monthCard = document.createElement('div');
                    monthCard.className = 'muted-card p-4 month-card';
                    monthCard.innerHTML = `
                        <button type="button" class="month-card-trigger w-full text-left" aria-expanded="false" aria-controls="${monthId}-weeks">
                            <div class="flex justify-between items-center mb-3">
                                <div class="flex items-center gap-2">
                                    <i class="ph ph-caret-right month-chevron text-slate-400 dark:text-slate-500 transition-transform"></i>
                                    <div class="font-bold text-slate-700 dark:text-slate-200">${monthNameCap}</div>
                                </div>
                                <div class="font-bold text-lg ${monthNetClass} tabular-nums">${formatAmount(stats.net, { showSign: true })}</div>
                            </div>
                            <div class="grid grid-cols-3 gap-4 text-center mb-3">
                                <div>
                                    <div class="text-xs text-slate-500 dark:text-slate-400 mb-1">Días</div>
                                    <div class="font-bold text-slate-800 dark:text-slate-200 tabular-nums">${stats.totalDays}</div>
                                </div>
                                <div>
                                    <div class="text-xs text-green-600 dark:text-green-400 mb-1">Ganadores</div>
                                    <div class="font-bold text-green-600 dark:text-green-400 tabular-nums">${stats.winDays}</div>
                                </div>
                                <div>
                                    <div class="text-xs text-red-500 dark:text-red-400 mb-1">Perdedores</div>
                                    <div class="font-bold text-red-500 dark:text-red-400 tabular-nums">${stats.lossDays}</div>
                                </div>
                            </div>
                            <div class="px-1">
                                <div class="flex items-center justify-between text-xs">
                                    <span class="text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wide">Tasa de éxito</span>
                                    <span class="font-bold text-blue-600 dark:text-blue-400 tabular-nums">${winRate}%</span>
                                </div>
                                <div class="success-bar ${stats.totalDays === 0 ? 'success-bar-empty' : ''}">
                                    <div class="success-bar-fill" style="width: ${stats.totalDays > 0 ? winRate : 0}%"></div>
                                </div>
                            </div>
                        </button>
                        <div id="${monthId}-expanded" class="month-expanded hidden mt-4">
                            <div id="${monthId}-heatmap" class="heatmap-container"></div>
                        </div>
                    `;

                    // Renderizar heatmap del mes
                    try {
                        const hmContainer = monthCard.querySelector(`#${monthId}-heatmap`);
                        if (hmContainer) {
                            hmContainer.innerHTML = renderMonthHeatmap(stats.year, stats.month, stats.weeks);
                            wireHeatmapInteractions(hmContainer);
                        }
                    } catch (err) {
                        console.warn('Error renderizando heatmap', err);
                    }

                    // Toggle mes → expande heatmap
                    const monthTrigger = monthCard.querySelector('.month-card-trigger');
                    const monthChevron = monthCard.querySelector('.month-chevron');
                    const monthExpanded = monthCard.querySelector(`#${monthId}-expanded`);
                    monthTrigger.setAttribute('aria-controls', `${monthId}-expanded`);
                    monthTrigger.addEventListener('click', () => {
                        const expanded = monthTrigger.getAttribute('aria-expanded') === 'true';
                        monthTrigger.setAttribute('aria-expanded', String(!expanded));
                        if (monthExpanded) monthExpanded.classList.toggle('hidden', expanded);
                        if (monthChevron) monthChevron.style.transform = expanded ? 'rotate(0deg)' : 'rotate(90deg)';
                    });

                    monthlyContainer.appendChild(monthCard);
                });
            }
        }
    } finally {
        try { hideSummariesLoading(); } catch (e) {}
        window._isGeneratingSummaries = false;
    }
}

// Mostrar/ocultar indicador de carga para la sección de resúmenes
function showSummariesLoading() {
    const el = document.getElementById('summaries-loading');
    if (!el) return;
    el.classList.remove('hidden');
}

function hideSummariesLoading() {
    const el = document.getElementById('summaries-loading');
    if (!el) return;
    el.classList.add('hidden');
}

/* --- MODALES Y TOASTS PERSONALIZADOS --- */
// Toast simple (info, success, error)
function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    const base = 'rounded px-3 py-2 shadow-md flex items-center gap-3 text-sm';
    // Las clases bg-* siguen siendo el "marker" que styles.css usa para tintar
    // el borde del toast; el dot da el estado en el lenguaje Bento OLED.
    let color = 'bg-slate-800 text-white';
    let dotCls = 'dot-cy';
    if (type === 'success') { color = 'bg-green-600 text-white'; dotCls = 'dot-g'; }
    if (type === 'error') { color = 'bg-red-600 text-white'; dotCls = 'dot-r'; }
    if (type === 'info') { color = 'bg-slate-800 text-white'; dotCls = 'dot-cy'; }

    el.className = `${base} ${color}`;
    el.innerHTML = `<span class="dot ${dotCls}" aria-hidden="true"></span><span class="min-w-0">${escapeHtml(message)}</span>`;
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

// Mostrar advertencia al añadir entrada si el usuario no está autenticado.
// Devuelve true si el usuario decide continuar (o si la advertencia está suprimida).
function showAddWarningIfNeeded() {
    const key = 'suppress_add_warning';
    if (localStorage.getItem(key) === 'true') return Promise.resolve(true);

    return new Promise(resolve => {
        const overlay = document.getElementById('modal-overlay');
        const msg = document.getElementById('modal-message');
        const btnOk = document.getElementById('modal-confirm');
        const btnCancel = document.getElementById('modal-cancel');
        if (!overlay || !msg || !btnOk || !btnCancel) return resolve(true);

        msg.innerHTML = `
            <div class="mb-3">Debes iniciar sesion para sincronizar estos cambios.</div>
            <label class="inline-flex items-center text-sm"><input type="checkbox" id="modal-suppress-checkbox" class="mr-2 accent-blue-400">No mostrar de nuevo este mensaje</label>
        `;
        overlay.classList.remove('hidden');

        const cleanup = () => {
            overlay.classList.add('hidden');
            btnOk.removeEventListener('click', onOk);
            btnCancel.removeEventListener('click', onCancel);
        };

        const onOk = () => {
            const cb = document.getElementById('modal-suppress-checkbox');
            if (cb && cb.checked) localStorage.setItem(key, 'true');
            cleanup();
            resolve(true);
        };
        const onCancel = () => { cleanup(); resolve(false); };

        btnOk.addEventListener('click', onOk);
        btnCancel.addEventListener('click', onCancel);
    });
}

// Actualiza botones y estado de auth en la UI
function updateAuthUI() {
    const authCtaLogin = document.getElementById('auth-cta-login');
    const authCtaRegister = document.getElementById('auth-cta-register');
    const authCtaLoginMobile = document.getElementById('auth-cta-login-mobile');
    const authCtaRegisterMobile = document.getElementById('auth-cta-register-mobile');
    const btnSignout = document.getElementById('btn-signout');
    const btnSignoutMobile = document.getElementById('btn-signout-mobile');
    const status = document.getElementById('auth-status');
    const statusText = document.getElementById('auth-text');
    const statusUid = document.getElementById('auth-uid');
    const statusSync = document.getElementById('auth-sync');
    if (!status || !statusText || !statusUid || !statusSync) return;

    const toggleAuthCTAs = (show) => {
        [authCtaLogin, authCtaRegister].forEach((el) => {
            if (!el) return;
            el.classList.toggle('hidden', !show);
        });
        [authCtaLoginMobile, authCtaRegisterMobile].forEach((el) => {
            if (!el) return;
            el.classList.toggle('hidden', !show);
        });
    };

    const a = window._firebase && window._firebase.auth;
    const uid = window._firebase && window._firebase.uid;

    if (a && uid) {
        toggleAuthCTAs(false);
        if (btnSignout) btnSignout.classList.remove('hidden');
        if (btnSignoutMobile) btnSignoutMobile.classList.remove('hidden');
        status.classList.remove('hidden');
        status.classList.add('flex');

        const user = a.currentUser;
        // Mostrar email si existe, si no mostrar uid abreviado
        if (user && user.email) {
            statusText.innerText = user.email;
        } else {
            try {
                const short = String(uid).length > 12 ? `${uid.slice(0,6)}...${uid.slice(-4)}` : uid;
                statusText.innerText = short;
            } catch (e) {
                statusText.innerText = 'Conectado';
            }
        }

        try {
            const short = String(uid).length > 12 ? `${uid.slice(0,6)}...${uid.slice(-4)}` : uid;
            statusUid.innerText = short;
        } catch (e) {
            statusUid.innerText = '';
        }

        const online = navigator.onLine;
        const hasDb = !!(window._firebase && window._firebase.db);
        if (online && hasDb) {
            statusSync.classList.remove('bg-gray-400', 'bg-red-400');
            statusSync.classList.add('bg-green-400');
            statusSync.title = 'Sincronización OK';
        } else if (!online) {
            statusSync.classList.remove('bg-gray-400', 'bg-green-400');
            statusSync.classList.add('bg-red-400');
            statusSync.title = 'Offline (sin conexión de red)';
        } else {
            statusSync.classList.remove('bg-green-400', 'bg-red-400');
            statusSync.classList.add('bg-gray-400');
            statusSync.title = 'Sincronización desconocida';
        }
    } else {
        toggleAuthCTAs(true);
        if (btnSignout) btnSignout.classList.add('hidden');
        if (btnSignoutMobile) btnSignoutMobile.classList.add('hidden');
        // ensure mobile signout is hidden and mobile auth CTAs are visible
        if (btnSignoutMobile) btnSignoutMobile.classList.add('hidden');
        if (authCtaLoginMobile) authCtaLoginMobile.classList.remove('hidden');
        if (authCtaRegisterMobile) authCtaRegisterMobile.classList.remove('hidden');
        // Ocultamos la pill de estado cuando no hay sesión (evita ruido visual)
        status.classList.add('hidden');
        status.classList.remove('flex');
        statusText.innerText = '';
        statusUid.innerText = '';
        statusSync.classList.remove('bg-green-400', 'bg-red-400');
        statusSync.classList.add('bg-gray-400');
        statusSync.title = 'Sincronización desconocida';
    }

    // Mostrar el bloque "Resumen de Operación" únicamente para usuarios autenticados
    try {
        const summaryCard = document.getElementById('summary-card');
        const summariesSection = document.getElementById('summaries-section');
        const toggleBtn = document.getElementById('btn-toggle-summary');
        const user = a && a.currentUser;
        const isLoggedIn = !!(a && uid);

        if (summaryCard) summaryCard.classList.toggle('hidden', !isLoggedIn);
        if (toggleBtn) toggleBtn.classList.toggle('hidden', !isLoggedIn);
        // Si el usuario está logueado, forzar que la sección de resúmenes esté abierta
        if (isLoggedIn) {
            try {
                if (summariesSection) {
                    summariesSection.classList.remove('hidden');
                }
                if (toggleBtn) {
                    toggleBtn.innerHTML = '<i class="ph ph-eye-slash"></i> Ocultar Resúmenes';
                }
                // Generar resúmenes inmediatamente (silenciar errores)
                try { generateSummaries(); } catch (e) { /* ignore */ }
            } catch (e) {
                console.warn('Error forzando sección de resúmenes visible:', e);
            }
        } else {
            // Si no está autenticado, ocultar la sección y actualizar texto del botón
            if (summariesSection) summariesSection.classList.add('hidden');
            if (toggleBtn) toggleBtn.innerHTML = '<i class="ph ph-chart-bar"></i> Ver Resúmenes';
        }
    } catch (e) {
        // Silenciar errores no críticos
        console.warn('Error actualizando visibilidad del resumen según auth:', e);
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

// Refresca todos los datos del usuario actual (llamado tras un login real,
// o tras restaurar sesión persistida).
async function refreshUserDataAfterLogin() {
    try { await loadCapitalConfig(true); } catch (e) { console.warn('Error cargando capital tras login', e); }
    try { await loadDataFirestore(); } catch (e) { console.warn('Error cargando diario tras login', e); }
    try { scheduleCapitalRecalc(0); } catch (e) {}
    try { scheduleGenerateSummaries(80); } catch (e) {}
    try { updateAuthUI(); } catch (e) {}
    // NOTA: la migración automática silenciosa local->Firestore se deshabilitó
    // a propósito. Causaba que un dispositivo con cache viejo (p. ej. el
    // teléfono después de haber borrado todo desde el PC) "resucite" datos
    // antiguos y los suba a la nube, sobrescribiendo lo que el usuario acaba
    // de hacer en otro dispositivo. Si el usuario quiere subir datos locales
    // a la nube, debe usar el botón "Sincronizar ahora" explícitamente.
}

// Watch for auth changes when firebase becomes available
function watchAuthChanges() {
    let __previousUid = (window._firebase && window._firebase.uid) || null;

    const onAuthChange = () => {
        const newUid = (window._firebase && window._firebase.uid) || null;

        if (newUid && newUid !== __previousUid) {
            // Transición: anónimo/desconectado → conectado, o cambio de cuenta.
            // Limpiar el cache local `trading_*` de este dispositivo: a partir
            // de ahora la fuente de verdad es Firestore, no el localStorage.
            // Así evitamos que cache viejo "resucite" datos que el usuario ya
            // borró desde otro dispositivo.
            try {
                for (let i = localStorage.length - 1; i >= 0; i--) {
                    const k = localStorage.key(i);
                    if (k && k.startsWith('trading_')) localStorage.removeItem(k);
                }
            } catch (e) { console.warn('No se pudo limpiar cache local tras login', e); }
            try { __journalCache && __journalCache.clear && __journalCache.clear(); } catch (e) { /* ignore */ }
            ensureJournalCollectionListener();
            refreshUserDataAfterLogin();
        } else if (!newUid && __previousUid) {
            // Transición: conectado → desconectado.
            cleanupJournalCollectionListener();
            updateAuthUI();
        } else {
            // Mismo estado: solo actualizar UI por si hay cambios cosméticos.
            updateAuthUI();
        }

        __previousUid = newUid;
    };

    if (window._firebase && window._firebase.auth) {
        const auth = window._firebase.auth;
        auth.onAuthStateChanged(onAuthChange);

        // Estado inicial
        updateAuthUI();
        if (window._firebase && window._firebase.uid) {
            ensureJournalCollectionListener();
        } else {
            cleanupJournalCollectionListener();
        }
    } else {
        window.addEventListener('firebase-auth-ready', () => {
            if (window._firebase && window._firebase.auth) {
                window._firebase.auth.onAuthStateChanged(onAuthChange);
            }
            updateAuthUI();
            if (window._firebase && window._firebase.uid) {
                ensureJournalCollectionListener();
            } else {
                cleanupJournalCollectionListener();
            }
        }, { once: true });
    }
}
let authModalMode = 'register'; // 'register' o 'login'

// Traduce los códigos de error de Firebase Auth al español, con mensajes amigables
function translateAuthError(err) {
    if (!err) return 'Error de autenticación.';
    const code = (err && err.code) || '';
    const map = {
        'auth/invalid-email': 'El correo electrónico no es válido.',
        'auth/user-disabled': 'Esta cuenta ha sido deshabilitada.',
        'auth/user-not-found': 'No existe una cuenta con ese correo.',
        'auth/wrong-password': 'La contraseña es incorrecta.',
        'auth/invalid-credential': 'Correo o contraseña incorrectos.',
        'auth/invalid-login-credentials': 'Correo o contraseña incorrectos.',
        'auth/email-already-in-use': 'Ya existe una cuenta con ese correo. Inicia sesión.',
        'auth/weak-password': 'La contraseña es muy débil (mínimo 6 caracteres).',
        'auth/missing-password': 'Ingresa tu contraseña.',
        'auth/missing-email': 'Ingresa tu correo electrónico.',
        'auth/too-many-requests': 'Demasiados intentos. Espera un momento e inténtalo de nuevo.',
        'auth/network-request-failed': 'Sin conexión. Revisa tu internet e inténtalo de nuevo.',
        'auth/popup-closed-by-user': 'Cerraste la ventana antes de iniciar sesión.',
        'auth/popup-blocked': 'El navegador bloqueó la ventana emergente. Permítela e inténtalo de nuevo.',
        'auth/cancelled-popup-request': 'Se canceló el inicio de sesión.',
        'auth/operation-not-allowed': 'Este método de inicio de sesión no está habilitado.',
        'auth/account-exists-with-different-credential': 'Ya existe una cuenta con este correo usando otro método.',
    };
    if (map[code]) return map[code];
    if (err.message) return err.message.replace(/^Firebase:\s*/i, '');
    return 'Error de autenticación.';
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function setAuthFormError(message) {
    const errEl = document.getElementById('auth-error');
    if (!errEl) return;
    if (!message) {
        errEl.classList.add('hidden');
        errEl.innerText = '';
    } else {
        errEl.classList.remove('hidden');
        errEl.innerText = message;
    }
}

function setAuthSubmitLoading(loading) {
    const submitBtn = document.getElementById('auth-modal-submit');
    const spinner = document.getElementById('auth-modal-submit-spinner');
    const textEl = document.getElementById('auth-modal-submit-text');
    if (!submitBtn) return;
    submitBtn.disabled = !!loading;
    if (spinner) spinner.classList.toggle('hidden', !loading);
    if (textEl) {
        if (loading) {
            textEl.dataset.prev = textEl.innerText;
            textEl.innerText = 'Procesando...';
        } else if (textEl.dataset.prev) {
            textEl.innerText = textEl.dataset.prev;
        }
    }
}

function openAuthModal(mode = 'register') {
    authModalMode = mode;
    const overlay = document.getElementById('auth-modal-overlay');
    const title = document.getElementById('auth-modal-title');
    const subtitle = document.getElementById('auth-modal-subtitle');
    const icon = document.getElementById('auth-modal-icon');
    const submitText = document.getElementById('auth-modal-submit-text');
    const switchText = document.getElementById('auth-modal-switch-text');
    const switchBtn = document.getElementById('auth-modal-switch');
    const passInput = document.getElementById('auth-password');
    const emailInput = document.getElementById('auth-email');
    const forgotRow = document.getElementById('auth-forgot-row');

    if (!overlay || !title || !submitText || !switchText || !switchBtn) return;

    setAuthFormError('');
    setAuthSubmitLoading(false);

    if (mode === 'register') {
        title.innerText = 'Crear cuenta';
        if (subtitle) subtitle.innerText = 'Regístrate para sincronizar tu jornada de trading.';
        if (icon) { icon.className = 'ph ph-user-plus text-lg'; }
        submitText.innerText = 'Registrarme';
        switchText.innerText = '¿Ya tienes cuenta?';
        switchBtn.innerText = 'Inicia sesión aquí';
        if (passInput) passInput.setAttribute('autocomplete', 'new-password');
        if (forgotRow) forgotRow.classList.add('hidden');
    } else {
        title.innerText = 'Iniciar sesión';
        if (subtitle) subtitle.innerText = 'Bienvenido de vuelta. Accede a tu cuenta.';
        if (icon) { icon.className = 'ph ph-sign-in text-lg'; }
        submitText.innerText = 'Iniciar sesión';
        switchText.innerText = '¿Aún no tienes cuenta?';
        switchBtn.innerText = 'Regístrate aquí';
        if (passInput) passInput.setAttribute('autocomplete', 'current-password');
        if (forgotRow) forgotRow.classList.remove('hidden');
    }

    overlay.classList.remove('hidden');

    // Foco al primer campo vacío, sin perderse en móvil
    setTimeout(() => {
        if (emailInput && !emailInput.value) emailInput.focus();
        else if (passInput) passInput.focus();
    }, 60);
}

function closeAuthModal() {
    const overlay = document.getElementById('auth-modal-overlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    setAuthFormError('');
    setAuthSubmitLoading(false);
}

async function handleAuthSubmit() {
    const emailEl = document.getElementById('auth-email');
    const passEl = document.getElementById('auth-password');
    const email = (emailEl && emailEl.value || '').trim();
    const password = (passEl && passEl.value) || '';

    setAuthFormError('');

    if (!email) { setAuthFormError('Ingresa tu correo electrónico.'); emailEl && emailEl.focus(); return; }
    if (!isValidEmail(email)) { setAuthFormError('El correo no tiene un formato válido.'); emailEl && emailEl.focus(); return; }
    if (!password) { setAuthFormError('Ingresa tu contraseña.'); passEl && passEl.focus(); return; }
    if (password.length < 6) { setAuthFormError('La contraseña debe tener al menos 6 caracteres.'); passEl && passEl.focus(); return; }

    setAuthSubmitLoading(true);
    try {
        if (authModalMode === 'register') {
            await window.registerWithEmailPassword(email, password);
            showToast('¡Cuenta creada! Sesión iniciada.', 'success');
        } else {
            await window.loginWithEmailPassword(email, password);
            showToast('Sesión iniciada correctamente.', 'success');
        }
        // Limpia campos sólo en éxito
        if (emailEl) emailEl.value = '';
        if (passEl) passEl.value = '';
        closeAuthModal();
    } catch (err) {
        console.error(err);
        setAuthFormError(translateAuthError(err));
    } finally {
        setAuthSubmitLoading(false);
    }
}

async function handleForgotPassword() {
    const emailEl = document.getElementById('auth-email');
    const email = (emailEl && emailEl.value || '').trim();
    if (!email || !isValidEmail(email)) {
        setAuthFormError('Escribe tu correo arriba para enviarte el enlace de recuperación.');
        emailEl && emailEl.focus();
        return;
    }
    setAuthFormError('');
    setAuthSubmitLoading(true);
    try {
        await window.sendPasswordReset(email);
        showToast('Te enviamos un correo para restablecer tu contraseña.', 'success', 4500);
    } catch (err) {
        console.error(err);
        setAuthFormError(translateAuthError(err));
    } finally {
        setAuthSubmitLoading(false);
    }
}

function setupAuthModal() {
    const overlay = document.getElementById('auth-modal-overlay');
    if (!overlay) return;

    const form = document.getElementById('auth-form');
    const closeBtn = document.getElementById('auth-modal-close');
    const switchBtn = document.getElementById('auth-modal-switch');
    const googleBtn = document.getElementById('auth-google-btn');
    const togglePass = document.getElementById('auth-toggle-password');
    const forgotBtn = document.getElementById('auth-forgot-btn');
    const emailInput = document.getElementById('auth-email');
    const passInput = document.getElementById('auth-password');

    // Cerrar (X o clic fuera)
    if (closeBtn) closeBtn.addEventListener('click', closeAuthModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeAuthModal();
    });
    // Cerrar con Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
            closeAuthModal();
        }
    });

    // Cambiar entre registro / login (limpia errores y password)
    if (switchBtn) switchBtn.addEventListener('click', () => {
        if (passInput) passInput.value = '';
        setAuthFormError('');
        openAuthModal(authModalMode === 'register' ? 'login' : 'register');
    });

    // Submit (form: cubre Enter en cualquier input + clic en botón)
    if (form) form.addEventListener('submit', (e) => {
        e.preventDefault();
        handleAuthSubmit();
    });

    // Toggle ver/ocultar contraseña
    if (togglePass && passInput) {
        togglePass.addEventListener('click', () => {
            const showing = passInput.getAttribute('type') === 'text';
            passInput.setAttribute('type', showing ? 'password' : 'text');
            const icon = togglePass.querySelector('i');
            if (icon) {
                icon.classList.toggle('ph-eye', showing);
                icon.classList.toggle('ph-eye-slash', !showing);
            }
            togglePass.setAttribute('aria-label', showing ? 'Mostrar contraseña' : 'Ocultar contraseña');
        });
    }

    // Recuperar contraseña
    if (forgotBtn) forgotBtn.addEventListener('click', handleForgotPassword);

    // Limpiar el error inline al escribir
    [emailInput, passInput].forEach(el => {
        if (!el) return;
        el.addEventListener('input', () => setAuthFormError(''));
    });

    // Google dentro del modal
    if (googleBtn) googleBtn.addEventListener('click', async () => {
        setAuthFormError('');
        setAuthSubmitLoading(true);
        try {
            await window.signInWithGoogle();
            showToast('Sesión iniciada con Google.', 'success');
            closeAuthModal();
        } catch (err) {
            console.error(err);
            setAuthFormError(translateAuthError(err));
        } finally {
            setAuthSubmitLoading(false);
        }
    });
}

// Atajos de teclado en inputs de TP/SL: Enter envía la entrada
function setupTradeInputShortcuts() {
    [
        { tp: 'tp-asset', val: 'tp-input', type: 'tp' },
        { tp: 'sl-asset', val: 'sl-input', type: 'sl' }
    ].forEach(group => {
        const assetEl = document.getElementById(group.tp);
        const valEl = document.getElementById(group.val);

        // Enter en cualquiera de los dos campos del par envía
        [assetEl, valEl].forEach(el => {
            if (!el) return;
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    addEntry(group.type);
                }
            });
        });

        // Auto-uppercase del activo mientras escribe
        if (assetEl) {
            assetEl.addEventListener('input', () => {
                const start = assetEl.selectionStart;
                const end = assetEl.selectionEnd;
                const upper = assetEl.value.toUpperCase();
                if (assetEl.value !== upper) {
                    assetEl.value = upper;
                    try { assetEl.setSelectionRange(start, end); } catch (e) {}
                }
            });
        }
    });
}

setupTradeInputShortcuts();

// Ejecutar al cargar
setupAuthModal();

watchAuthChanges();

// ==================== Re-sincronización al volver al primer plano ====================
// En móvil (sobre todo iOS) el SO suspende el runtime de JS cuando la PWA está en
// background o la pantalla está bloqueada. El websocket de Firestore se cae y el
// listener onSnapshot deja de recibir cambios hasta que reconecta. Para que el
// usuario no tenga que refrescar a mano, forzamos un fetch + re-listener cada vez
// que la app vuelve a estar visible o la red vuelve.
let __lastForegroundSync = 0;
async function resyncFromFirestore(reason) {
    // Anti-rebote: si dos eventos disparan a la vez (ej. visibilitychange + focus),
    // no hacemos dos lecturas seguidas.
    const now = Date.now();
    if (now - __lastForegroundSync < 500) return;
    __lastForegroundSync = now;

    if (!navigator.onLine) return;
    const uid = window._firebase && window._firebase.uid;
    if (!uid) return;

    // Si el usuario tiene un panel de fila abierto (vista o editor), no
    // re-sincronizamos: loadDataFirestore haría renderUI y destruiría el
    // panel. Cuando el usuario lo cierre, se llama a resync manualmente.
    if (isAnyRowEditorOpen()) return;

    try {
        // Re-asegurar el listener global de la colección por si fue cancelado.
        ensureJournalCollectionListener();
        // Forzar lectura del documento de la fecha actual (re-crea el listener
        // por-fecha también, ver loadDataFirestore).
        await loadDataFirestore();
        // Refrescar resúmenes y capital por si cambió algo en otros días.
        try { scheduleGenerateSummaries(50); } catch (e) { /* ignore */ }
        try { scheduleCapitalRecalc(0); } catch (e) { /* ignore */ }
    } catch (err) {
        console.warn('resyncFromFirestore (' + reason + ') falló:', err);
    }
}

// 1) visibilitychange — cubre el caso "el usuario vuelve a la PWA tras tenerla en background".
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resyncFromFirestore('visibilitychange');
});

// 2) focus — cubre desktop (cambio de pestaña) y algunos webviews donde
//    visibilitychange no dispara fiable.
window.addEventListener('focus', () => resyncFromFirestore('focus'));

// 3) pageshow — cubre back/forward cache (el navegador "resucita" la página
//    sin recargar el JS). En iOS Safari es muy común.
window.addEventListener('pageshow', (e) => {
    if (e.persisted) resyncFromFirestore('pageshow-bfcache');
});

// 4) online — si el dispositivo recupera red tras estar offline.
window.addEventListener('online', () => resyncFromFirestore('online'));

// ==================== PWA: Service Worker + Instalación ====================
// Registra el Service Worker para soporte offline + instalación.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').then((reg) => {
            // Si hay una versión nueva esperando, activarla.
            if (reg.waiting) {
                reg.waiting.postMessage({ type: 'SKIP_WAITING' });
            }
            reg.addEventListener('updatefound', () => {
                const sw = reg.installing;
                if (!sw) return;
                sw.addEventListener('statechange', () => {
                    if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                        // Hay nueva versión disponible. La activamos en silencio.
                        sw.postMessage({ type: 'SKIP_WAITING' });
                    }
                });
            });
        }).catch((err) => {
            console.warn('Service Worker registration failed:', err);
        });

        // Cuando el SW activa una nueva versión, la página recarga sola
        let __reloading = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (__reloading) return;
            __reloading = true;
            // Recarga suave para tomar la nueva versión sin interrumpir al usuario
            // si está en medio de algo, lo posponemos.
            setTimeout(() => { try { location.reload(); } catch (e) {} }, 300);
        });
    });
}

// Captura el evento de instalación cuando el navegador detecta que la PWA
// es instalable (criterios: HTTPS o localhost, manifest válido, SW activo, etc.)
let __deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    __deferredInstallPrompt = e;
    const installBtn = document.getElementById('btn-install-pwa');
    if (installBtn) installBtn.classList.remove('hidden');
});

// Lanzado por el botón "Instalar app" del menú móvil
window.triggerInstall = async function triggerInstall() {
    if (!__deferredInstallPrompt) {
        // Detectar si ya está instalada o si el navegador no soporta instalación
        const isStandalone =
            window.matchMedia('(display-mode: standalone)').matches ||
            window.navigator.standalone === true;
        if (isStandalone) {
            showToast('La app ya está instalada en este dispositivo.', 'info', 3500);
        } else {
            // Probable iOS Safari u otro navegador sin beforeinstallprompt
            showToast('Para instalar: usa "Compartir → Añadir a inicio" en tu navegador.', 'info', 5000);
        }
        return;
    }
    try {
        __deferredInstallPrompt.prompt();
        const { outcome } = await __deferredInstallPrompt.userChoice;
        if (outcome === 'accepted') {
            showToast('¡App instalada!', 'success');
        }
    } catch (err) {
        console.warn('Install prompt error:', err);
    } finally {
        __deferredInstallPrompt = null;
        const installBtn = document.getElementById('btn-install-pwa');
        if (installBtn) installBtn.classList.add('hidden');
    }
};

// Cuando se completa la instalación, ocultar el botón
window.addEventListener('appinstalled', () => {
    __deferredInstallPrompt = null;
    const installBtn = document.getElementById('btn-install-pwa');
    if (installBtn) installBtn.classList.add('hidden');
    try { showToast('¡App instalada en tu dispositivo!', 'success', 3500); } catch (e) {}
});
// Limpiar el estado inválido (borde rojo) en cuanto el usuario empieza a corregir.
document.addEventListener('input', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('is-invalid')) {
        t.classList.remove('is-invalid');
    }
});
document.addEventListener('change', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('is-invalid')) {
        t.classList.remove('is-invalid');
    }
});
