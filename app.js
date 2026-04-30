// --- MODO OSCURO ---
function toggleTheme() {
    const html = document.documentElement;
    const icons = Array.from(document.querySelectorAll('.theme-icon'));

    if (html.classList.contains('dark')) {
        html.classList.remove('dark');
        icons.forEach(ic => { ic.classList.remove('fa-sun'); ic.classList.add('fa-moon'); });
        localStorage.setItem('theme', 'light');
    } else {
        html.classList.add('dark');
        icons.forEach(ic => { ic.classList.remove('fa-moon'); ic.classList.add('fa-sun'); });
        localStorage.setItem('theme', 'dark');
    }
}

// Cargar preferencia de tema al iniciar
(function loadTheme() {
    const savedTheme = localStorage.getItem('theme');
    const icons = Array.from(document.querySelectorAll('.theme-icon'));
    if (savedTheme === 'dark' || !savedTheme) {
        document.documentElement.classList.add('dark');
        icons.forEach(ic => { ic.classList.remove('fa-moon'); ic.classList.add('fa-sun'); });
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
function normalizeCurrentData() {
    if (!currentData || typeof currentData !== 'object') currentData = { tps: [], sls: [] };
    if (!Array.isArray(currentData.tps)) currentData.tps = [];
    if (!Array.isArray(currentData.sls)) currentData.sls = [];
}
// Capital dinámico: configuración y estado
const CAPITAL_STORAGE_KEY = 'trading_capital_config';
let capitalConfig = { initial: 1000 };
let capitalTimeline = []; // [{ dateKey, factor, capital, relativePct }]
let __capitalRecalcTimer = null;
let __isCalculatingCapital = false;
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
});

let _unsubscribeJournalCollectionListener = null;

function ensureJournalCollectionListener() {
    if (!window._firebase || !window._firebase.db) return;
    const uid = window._firebase.uid;
    if (!uid) return;
    if (_unsubscribeJournalCollectionListener) return;

    const collRef = window.firebaseFirestoreCollection(window._firebase.db, 'users', uid, 'journals');
    _unsubscribeJournalCollectionListener = window.firebaseFirestoreOnSnapshot(
        collRef,
        (snapshot) => {
            snapshot.docChanges().forEach(change => {
                const dateKey = change.doc.id;
                if (!dateKey) return;
                const storageKey = `trading_${dateKey}`;

                if (change.type === 'removed') {
                    localStorage.removeItem(storageKey);
                    if (dateKey === datePicker.value) {
                        currentData = { tps: [], sls: [] };
                        normalizeCurrentData();
                        renderUI();
                        scheduleGenerateSummaries();
                    }
                    return;
                }

                const docData = change.doc.data() || {};
                const normalized = {
                    tps: Array.isArray(docData.tps) ? docData.tps : [],
                    sls: Array.isArray(docData.sls) ? docData.sls : []
                };
                localStorage.setItem(storageKey, JSON.stringify(normalized));
                if (dateKey === datePicker.value) {
                    currentData = normalized;
                    normalizeCurrentData();
                    renderUI();
                    scheduleGenerateSummaries();
                }
            });
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
                } else if (forceRemote) {
                    await window.firebaseFirestoreSetDoc(docRef, { initialCapital: capitalConfig.initial });
                }
            }
        } catch (err) {
            console.warn('No se pudo cargar capital desde Firestore', err);
        }
    }

    try {
        localStorage.setItem(CAPITAL_STORAGE_KEY, JSON.stringify({ initial: capitalConfig.initial }));
    } catch (e) { /* ignore */ }

    const input = document.getElementById('capital-input');
    if (input) input.value = capitalConfig.initial;
}

async function saveCapitalConfigRemote(value) {
    if (!hasFirestore()) return;
    const uid = window._firebase.uid;
    if (!uid) return;
    try {
        const docRef = window.firebaseFirestoreDoc(window._firebase.db, 'users', uid, 'config', 'capital');
        await window.firebaseFirestoreSetDoc(docRef, { initialCapital: value });
    } catch (err) {
        console.warn('No se pudo guardar capital en Firestore', err);
    }
}

function persistCapitalConfig(value) {
    capitalConfig.initial = sanitizeCapitalValue(value, capitalConfig.initial);
    try { localStorage.setItem(CAPITAL_STORAGE_KEY, JSON.stringify({ initial: capitalConfig.initial })); } catch (e) { /* ignore */ }
    saveCapitalConfigRemote(capitalConfig.initial);
    scheduleCapitalRecalc(0);
    renderCapitalDisplays(getCurrentNet());
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
    return {
        id: Number.isFinite(id) ? id : idx,
        value,
        asset: (item && item.asset ? String(item.asset).trim().toUpperCase() : '---') || '---',
        type
    };
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

    for (const dateKey of keys) {
        const data = journalMap[dateKey];
        if (!data) continue;
        const tpSum = (data.tps || []).reduce((acc, tp) => acc + (Number(tp.value) || 0), 0);
        const slSum = (data.sls || []).reduce((acc, sl) => acc + (Number(sl.value) || 0), 0);
        const dailyNet = tpSum - slSum;
        if (!dailyNet) continue;

        cumulativeNet += dailyNet;
        const capital = capitalConfig.initial + cumulativeNet;
        const relativePct = (cumulativeNet / capitalConfig.initial) * 100;

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
    const base = {
        factor: 1,
        capital: capitalConfig.initial,
        relativePct: 0
    };
    if (!capitalTimeline || capitalTimeline.length === 0) return base;
    return capitalTimeline[capitalTimeline.length - 1];
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
        absEl.innerText = '$' + formatCurrency(abs);
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
        const netSign = net > 0 ? '+' : '';
        const netColor = net > 0
            ? 'text-green-500 dark:text-green-400'
            : (net < 0 ? 'text-red-500 dark:text-red-400' : 'text-slate-400 dark:text-slate-500');
        const arrow = net > 0 ? '▲' : (net < 0 ? '▼' : '·');
        mainEl.innerHTML = `<span class="${netColor}">${arrow} ${netSign}${net.toFixed(2)}%</span>`;
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
        series.push({ dateKey: key, capital: initial + cum, dailyNet });
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
    }
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
    const isUp = last > initial;
    const isDown = last < initial;
    const stroke = isUp ? '#22c55e' : (isDown ? '#ef4444' : '#94a3b8');
    const fillId = isUp ? 'sparkGreen' : (isDown ? 'sparkRed' : 'sparkGray');
    const fillStop = isUp ? '#22c55e' : (isDown ? '#ef4444' : '#94a3b8');

    // Punto final destacado
    const lastX = xAt(n - 1);
    const lastY = yAt(last);

    container.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${fillStop}" stop-opacity="0.32" />
            <stop offset="100%" stop-color="${fillStop}" stop-opacity="0" />
          </linearGradient>
        </defs>
        <path d="${areaPath}" fill="url(#${fillId})" />
        <path d="${linePath}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <line class="kpi-sparkline-hover-line" id="spark-vline" x1="0" y1="${padY}" x2="0" y2="${H - padY}" />
        <circle class="kpi-sparkline-dot" id="spark-dot-end" cx="${lastX.toFixed(2)}" cy="${lastY.toFixed(2)}" r="3.5" stroke="${stroke}" />
        <circle class="kpi-sparkline-dot" id="spark-dot" cx="0" cy="0" r="0" stroke="${stroke}" style="opacity:0" />
      </svg>
      <div class="kpi-sparkline-tooltip" id="spark-tooltip">
        <div class="tt-date"></div>
        <div class="tt-value"></div>
      </div>
    `;

    // Meta: variación absoluta vs capital inicial en la ventana visible
    if (metaEl) {
        const startCap = points[0].capital;
        const delta = last - startCap;
        const pct = startCap > 0 ? (delta / startCap) * 100 : 0;
        const sign = delta > 0 ? '+' : (delta < 0 ? '−' : '');
        const cls = delta > 0 ? 'text-green-500 dark:text-green-400' : (delta < 0 ? 'text-red-500 dark:text-red-400' : '');
        metaEl.innerHTML = `<span>${n} días · </span><span class="${cls}">${sign}${Math.abs(pct).toFixed(2)}%</span>`;
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
        ttValue.innerText = '$' + formatCurrency(points[bestI].capital);
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
            const fullPct = `${sign}${Math.abs(info.net).toFixed(2)}%`;
            // Versión corta para mostrar dentro de la celda (1 decimal, sin %)
            const compactPct = `${sign}${Math.abs(info.net).toFixed(1)}`;
            title = `${day}: ${fullPct} (TP +${info.tp.toFixed(2)}% / SL −${info.sl.toFixed(2)}%)`;
            pctHtml = `<div class="heatmap-cell-pct">${compactPct}</div>`;
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
            const remote = snap.data() || { tps: [], sls: [] };
            const remoteHasTrades = (Array.isArray(remote.tps) && remote.tps.length) || (Array.isArray(remote.sls) && remote.sls.length);
            const localHasTrades = (Array.isArray(currentData.tps) && currentData.tps.length) || (Array.isArray(currentData.sls) && currentData.sls.length);

            // Si remoto tiene trades, tiene preferencia (regla de "fuente de verdad").
            // Si remoto está vacío pero local tiene datos (ej. el usuario añadió cosas
            // sin estar logueado), conservamos local y disparamos un saveData()
            // para subirlo a la nube.
            if (remoteHasTrades || !localHasTrades) {
                currentData = remote;
            } else {
                // mantener local; programar subida
                setTimeout(() => { saveData().catch(()=>{}); }, 100);
            }
        }
        // Si el doc remoto NO existe, NO sobrescribimos currentData:
        // así preservamos lo que el usuario haya ingresado local antes de loguearse.
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
        await window.firebaseFirestoreSetDoc(docRef, currentData);
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

    const raw = (input.value || '').toString().replace(',', '.').trim();
    const value = parseFloat(raw);
    const asset = (assetInput && assetInput.value || '').trim().toUpperCase();

    if (!Number.isFinite(value) || value <= 0) {
        showToast('Ingresa un porcentaje válido (mayor a 0)', 'error');
        input.focus();
        return;
    }

    // Tope sano: nadie razonable mete >1000% en un solo trade
    if (value > 1000) {
        showToast('El porcentaje parece demasiado alto. Verifica el valor.', 'error');
        input.focus();
        return;
    }

    const entry = {
        id: Date.now() + Math.floor(Math.random() * 1000), // evitar colisión si se añaden 2 en el mismo ms
        value: Math.round(value * 100) / 100, // normalizar a 2 decimales
        asset: asset || '---'
    };

    if (type === 'tp') currentData.tps.push(entry);
    else currentData.sls.push(entry);

    input.value = '';
    if (assetInput) assetInput.value = '';
    saveData();
    // Devolver foco al campo de activo para encadenar entradas rápido
    if (assetInput) assetInput.focus();
}

function deleteEntry(type, id) {
    // Animar salida si la fila está visible, luego borrar
    const row = document.querySelector(`[data-entry-id="${id}"][data-entry-type="${type}"]`);
    const finalize = () => {
        if (type === 'tp') currentData.tps = currentData.tps.filter(item => item.id !== id);
        else currentData.sls = currentData.sls.filter(item => item.id !== id);
        saveData();
    };
    if (row) {
        row.classList.add('is-leaving');
        setTimeout(finalize, 220);
    } else {
        finalize();
    }
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
        const dailyContainer = document.getElementById('daily-summary-list'); if (dailyContainer) dailyContainer.innerHTML = '';
        const summariesSection = document.getElementById('summaries-section'); if (summariesSection) summariesSection.classList.add('hidden');
    } catch (e) { /* ignore */ }

    // No volver a guardar datos vacíos localmente; en su lugar, forzar recarga desde Firestore tras eliminar en la nube

    showToast(removedLocal > 0 ? `Eliminados ${removedLocal} día(s) en este navegador` : 'No se encontraron datos locales', 'success', 2200);

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
        const dailyContainer = document.getElementById('daily-summary-list'); if (dailyContainer) dailyContainer.innerHTML = '';
    } catch (e) { /* ignore */ }

    // Recargar la página para que la UI se actualice inmediatamente
    try { setTimeout(() => { location.reload(); }, 150); } catch (e) { /* ignore */ }
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
        const safeValue = Number(item && item.value);
        const valueNum = Number.isFinite(safeValue) ? safeValue : 0;
        const safeAsset = (item && item.asset) ? String(item.asset) : '---';
        const row = document.createElement('div');
        row.dataset.entryId = item.id;
        row.dataset.entryType = type;
        row.className = "trade-entry-row flex justify-between items-center py-2 px-3 rounded hover:bg-slate-50 dark:hover:bg-slate-700/50 border border-transparent hover:border-slate-100 dark:hover:border-slate-600 transition group";
        row.innerHTML = `
            <div class="flex items-center gap-3">
                <span id="asset-${type}-${item.id}" class="font-bold text-slate-700 dark:text-slate-200 text-xs bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded">${safeAsset}</span>
                <span id="value-${type}-${item.id}" data-value="${valueNum}" class="value-span font-bold ${valueColor} text-sm">${sign}${valueNum.toFixed(2)}%</span>
                <div id="editor-${type}-${item.id}" class="inline-editor hidden flex items-center gap-2">
                    <input type="text" class="w-20 px-2 py-1 rounded text-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100" placeholder="PAR" />
                    <input type="number" step="0.01" min="0.01" class="w-20 px-2 py-1 rounded text-sm border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100" />
                    <button onclick="saveEdit('${type}', ${item.id})" title="Guardar" class="text-black dark:text-white bg-slate-200 dark:bg-slate-700 px-2 py-1 rounded"><i class="fa-solid fa-floppy-disk"></i></button>
                    <button onclick="cancelEdit('${type}', ${item.id})" title="Cancelar" class="text-slate-500 px-2 py-1 rounded"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onclick="startEdit('${type}', ${item.id})" title="Editar" class="entry-action-btn entry-edit text-slate-400 hover:text-slate-50 text-xs"><i class="fa-solid fa-pen-to-square"></i></button>
                <button onclick="deleteEntry('${type}', ${item.id})" title="Eliminar" class="entry-action-btn entry-delete text-red-300 hover:text-red-500 text-xs"><i class="fa-solid fa-xmark"></i></button>
            </div>
        `;
        container.appendChild(row);
    });
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

    bumpIfChanged(document.getElementById('tp-total-display'), tpTotal.toFixed(2) + '%');
    bumpIfChanged(document.getElementById('sl-total-display'), slTotal.toFixed(2) + '%');
    bumpIfChanged(document.getElementById('footer-tp'), '+' + tpTotal.toFixed(2) + '%');
    bumpIfChanged(document.getElementById('footer-sl'), '-' + slTotal.toFixed(2) + '%');

    const netEl = document.getElementById('footer-net');
    const sign = net > 0 ? '+' : '';
    const colorClass = net > 0 ? 'text-green-500 dark:text-green-400' : (net < 0 ? 'text-red-500 dark:text-red-400' : 'text-slate-800 dark:text-slate-200');
    bumpIfChanged(netEl, sign + net.toFixed(2) + '%');
    if (netEl) netEl.className = "font-bold text-lg tabular-nums " + colorClass;

    renderCapitalDisplays(net);
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
    if (window._isGeneratingSummaries) {
        console.log('generateSummaries: ya en ejecución, omitiendo llamada duplicada');
        return;
    }
    window._isGeneratingSummaries = true;
    try { showSummariesLoading(); } catch(e) {}
    try {
        const selectedDate = new Date(datePicker.value + "T00:00:00");
        const dayOfWeek = selectedDate.getDay() || 7;
        const baseMonday = new Date(selectedDate);
        baseMonday.setDate(selectedDate.getDate() - dayOfWeek + 1);

        const monthlyContainer = document.getElementById('monthly-summaries');
        const dailyContainer = document.getElementById('daily-summary-list');
        if (!dailyContainer && !monthlyContainer) return;
        if (monthlyContainer) monthlyContainer.innerHTML = '';
        if (dailyContainer) dailyContainer.innerHTML = '';

        // Recolectar todos los diarios disponibles (localStorage + Firestore)
        let allJournals = {};
        try {
            allJournals = await fetchAllJournalsMerged();
        } catch (e) {
            console.warn('No se pudieron leer todos los diarios para generar resúmenes', e);
            allJournals = {};
        }

        // Rellenar la vista 'Día' solo con los días de la semana actual (baseMonday..baseMonday+6)
        try {
            if (dailyContainer) {
                // Ya limpiado arriba; ahora iterar la semana actual (leer en batch)
                const weekStart = new Date(baseMonday);
                const wkKeys = [];
                const wkDates = [];
                for (let i = 0; i < 7; i++) {
                    const d = new Date(weekStart);
                    d.setDate(weekStart.getDate() + i);
                    wkDates.push(d);
                    wkKeys.push(localDateKey(d));
                }
                try {
                    // Si previamente cargamos todos los diarios (fetchAllJournalsMerged), reutilizarlos
                    if (allJournals && Object.keys(allJournals).length > 0) {
                        for (let i = 0; i < wkKeys.length; i++) {
                            const key = wkKeys[i];
                            const data = allJournals[key];
                            if (data && ((data.tps && data.tps.length > 0) || (data.sls && data.sls.length > 0))) {
                                const tp = (data.tps || []).reduce((s, it) => s + (Number(it.value) || 0), 0);
                                const sl = (data.sls || []).reduce((s, it) => s + (Number(it.value) || 0), 0);
                                const net = tp - sl;
                                addDailyRow(wkDates[i], tp, sl, net);
                            }
                        }
                    } else {
                        const weekMap = await readManyJournalForDates(wkKeys);
                        for (let i = 0; i < wkKeys.length; i++) {
                            const key = wkKeys[i];
                            const data = weekMap[key];
                            if (data && ((data.tps && data.tps.length > 0) || (data.sls && data.sls.length > 0))) {
                                const tp = (data.tps || []).reduce((s, it) => s + it.value, 0);
                                const sl = (data.sls || []).reduce((s, it) => s + it.value, 0);
                                const net = tp - sl;
                                addDailyRow(wkDates[i], tp, sl, net);
                            }
                        }
                    }
                } catch (e) {
                    console.warn('Error leyendo semana en batch', e);
                }
            }
        } catch (e) {
            console.warn('Error rellenando vista Día', e);
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
                    const signM = stats.net > 0 ? '+' : '';
                    const monthNetClass = stats.net > 0 ? 'text-green-500 dark:text-green-400' : (stats.net < 0 ? 'text-red-500 dark:text-red-400' : 'text-slate-800 dark:text-slate-200');
                    const winRate = stats.totalDays > 0 ? ((stats.winDays / stats.totalDays) * 100).toFixed(1) : '0.0';

                    const monthId = `month-${ymKey}`;
                    const monthCard = document.createElement('div');
                    monthCard.className = 'muted-card p-4 month-card';
                    monthCard.innerHTML = `
                        <button type="button" class="month-card-trigger w-full text-left" aria-expanded="false" aria-controls="${monthId}-weeks">
                            <div class="flex justify-between items-center mb-3">
                                <div class="flex items-center gap-2">
                                    <i class="fa-solid fa-chevron-right month-chevron text-slate-400 dark:text-slate-500 transition-transform"></i>
                                    <div class="font-bold text-slate-700 dark:text-slate-200">${monthNameCap}</div>
                                </div>
                                <div class="font-bold text-lg ${monthNetClass} tabular-nums">${signM}${stats.net.toFixed(2)}%</div>
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

// --- VISTAS DE RESUMEN (Día / Mes) ---
function setSummaryView(view) {
    try {
        // Solo se aceptan 'day' o 'month' (la vista 'week' fue retirada;
        // las semanas viven dentro del despliegue de cada mes)
        if (view !== 'day' && view !== 'month') view = 'day';

        const dailyPanel = document.getElementById('daily-panel');
        const monthlyPanel = document.getElementById('monthly-panel');

        if (dailyPanel) dailyPanel.classList.toggle('hidden', view !== 'day');
        if (monthlyPanel) monthlyPanel.classList.toggle('hidden', view !== 'month');

        // Actualizar estados de botones
        const dayBtn = document.getElementById('summary-view-day');
        const monthBtn = document.getElementById('summary-view-month');
        [dayBtn, monthBtn].forEach(b => {
            if (!b) return;
            b.classList.remove('bg-blue-600','text-white');
            b.classList.add('text-slate-600','dark:text-slate-200');
        });
        const active = document.querySelector(`#summary-view-toggle button[data-view="${view}"]`);
        if (active) {
            active.classList.add('bg-blue-600','text-white');
            active.classList.remove('text-slate-600','dark:text-slate-200');
        }

        localStorage.setItem('summary_view', view);

        // Si la sección de resúmenes está visible, asegurar que el contenido
        // está al día al cambiar de pestaña (genera si no había nada).
        const section = document.getElementById('summaries-section');
        if (section && !section.classList.contains('hidden')) {
            scheduleGenerateSummaries(50);
        }
    } catch (e) {
        console.warn('setSummaryView error', e);
    }
}

function initSummaryView() {
    const toggle = document.getElementById('summary-view-toggle');
    if (!toggle) return;
    const dayBtn = document.getElementById('summary-view-day');
    const monthBtn = document.getElementById('summary-view-month');
    [dayBtn, monthBtn].forEach(b => {
        if (!b) return;
        b.addEventListener('click', () => {
            const v = b.dataset && b.dataset.view ? b.dataset.view : (b.id || '').replace('summary-view-','');
            setSummaryView(v);
        });
    });

    // Migrar preferencia legada 'week' a 'day'
    let saved = localStorage.getItem('summary_view') || 'day';
    if (saved === 'week') saved = 'day';
    setSummaryView(saved);
}

// Asegurar inicialización tras carga del DOM (scripts están al final, pero por si acaso)
window.addEventListener('DOMContentLoaded', initSummaryView);

function addDailyRow(dateObj, tp, sl, net) {
    const container = document.getElementById('daily-summary-list');
    const dateStr = dateObj.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    const dateCap = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);

    const netColor = net > 0 ? 'text-green-600 dark:text-green-400' : (net < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-300');
    const dotColor = net > 0 ? 'text-green-500' : (net < 0 ? 'text-red-500' : 'text-gray-300');
    const sign = net > 0 ? '+' : '';

    const div = document.createElement('div');
    // Hacer la fila clicable para navegar al día
    div.className = "bg-slate-50 dark:bg-slate-700/50 rounded p-3 flex justify-between items-center border border-slate-100 dark:border-slate-600 cursor-pointer hover:shadow-md";
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
    // Asociar acción click: llevar al usuario al día correspondiente
    try {
        const dateKey = localDateKey(dateObj);
        div.addEventListener('click', (e) => {
            // Evitar que clicks en botones internos (si los hubiera) desencadenen navegación
            if (e.target && (e.target.tagName === 'BUTTON' || e.target.closest && e.target.closest('button'))) return;
            const picker = document.getElementById('datePicker');
            if (picker) {
                picker.value = dateKey;
                try { localStorage.setItem(DATE_STORAGE_KEY, dateKey); } catch (err) { /* ignore */ }
            }
            // Cargar datos del día seleccionado pero MANTENER los resúmenes abiertos
            try { loadData(); } catch (err) { console.warn('Error cargando datos tras click resumen', err); }
            // Llevar la vista al tope de la página para que el usuario vea el selector y las listas
            try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {}
        });
    } catch (e) {
        console.warn('addDailyRow: no se pudo asignar click al row', e);
    }

    container.appendChild(div);
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
            <label class="inline-flex items-center text-sm"><input type="checkbox" id="modal-suppress-checkbox" class="mr-2">No mostrar de nuevo este mensaje</label>
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
                    toggleBtn.innerHTML = '<i class="fa-solid fa-eye-slash"></i> Ocultar Resúmenes';
                }
                // Generar resúmenes inmediatamente (silenciar errores)
                try { generateSummaries(); } catch (e) { /* ignore */ }
            } catch (e) {
                console.warn('Error forzando sección de resúmenes visible:', e);
            }
        } else {
            // Si no está autenticado, ocultar la sección y actualizar texto del botón
            if (summariesSection) summariesSection.classList.add('hidden');
            if (toggleBtn) toggleBtn.innerHTML = '<i class="fa-solid fa-chart-column"></i> Ver Resúmenes';
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
    // Migración silenciosa de datos locales si el usuario tiene cuenta con email
    try {
        const uid = window._firebase && window._firebase.uid;
        const user = window._firebase && window._firebase.auth && window._firebase.auth.currentUser;
        const localKeys = getLocalTradingKeys();
        if (uid && user && user.email && localKeys.length > 0) {
            migrateLocalToFirestore(false).catch(err => {
                console.warn('Error en migración local->Firestore', err);
            });
        }
    } catch (e) { /* ignore */ }
}

// Watch for auth changes when firebase becomes available
function watchAuthChanges() {
    let __previousUid = (window._firebase && window._firebase.uid) || null;

    const onAuthChange = () => {
        const newUid = (window._firebase && window._firebase.uid) || null;

        if (newUid && newUid !== __previousUid) {
            // Transición: anónimo/desconectado → conectado, o cambio de cuenta.
            // Hacer un refresh completo para que la UI refleje los datos del usuario.
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
        if (icon) { icon.className = 'fa-solid fa-user-plus text-lg'; }
        submitText.innerText = 'Registrarme';
        switchText.innerText = '¿Ya tienes cuenta?';
        switchBtn.innerText = 'Inicia sesión aquí';
        if (passInput) passInput.setAttribute('autocomplete', 'new-password');
        if (forgotRow) forgotRow.classList.add('hidden');
    } else {
        title.innerText = 'Iniciar sesión';
        if (subtitle) subtitle.innerText = 'Bienvenido de vuelta. Accede a tu cuenta.';
        if (icon) { icon.className = 'fa-solid fa-right-to-bracket text-lg'; }
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
                icon.classList.toggle('fa-eye', showing);
                icon.classList.toggle('fa-eye-slash', !showing);
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
// Inicializar selector de vista de resúmenes inmediatamente
try { initSummaryView(); } catch (e) { /* ignore */ }