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

// --- LÓGICA DE TRADING ---
let currentData = { tps: [], sls: [] };
const DEFAULT_START_CAPITAL = 100.00;
function normalizeCurrentData() {
    if (!currentData || typeof currentData !== 'object') currentData = { tps: [], sls: [] };
    if (!Array.isArray(currentData.tps)) currentData.tps = [];
    if (!Array.isArray(currentData.sls)) currentData.sls = [];
    if (typeof currentData.startCapital !== 'number') currentData.startCapital = DEFAULT_START_CAPITAL;
    if (typeof currentData.finalCapital !== 'number') currentData.finalCapital = computeFinalCapitalFromData(currentData);
}

function computeFinalCapitalFromData(data) {
    try {
        const start = (data && typeof data.startCapital === 'number') ? data.startCapital : DEFAULT_START_CAPITAL;
        const tp = Array.isArray(data.tps) ? data.tps.reduce((s, it) => s + (it && Number(it.value) ? Number(it.value) : 0), 0) : 0;
        const sl = Array.isArray(data.sls) ? data.sls.reduce((s, it) => s + (it && Number(it.value) ? Number(it.value) : 0), 0) : 0;
        const net = tp - sl;
        return Number((start + net).toFixed(2));
    } catch (e) {
        return DEFAULT_START_CAPITAL;
    }
}

// --- Gestión de capital por fecha ---
const CAPITAL_MAP_KEY = 'capital_by_date';
function loadCapitalMap() {
    try {
        const raw = localStorage.getItem(CAPITAL_MAP_KEY);
        if (!raw) return {};
        return JSON.parse(raw) || {};
    } catch (e) { return {}; }
}

function saveCapitalMap(map) {
    try { localStorage.setItem(CAPITAL_MAP_KEY, JSON.stringify(map)); } catch (e) { /* ignore */ }
}

function getAllKnownDates() {
    // union of trading keys and capital map keys
    const keys = new Set();
    try {
        const localDates = getLocalTradingKeys();
        localDates.forEach(d => keys.add(d));
    } catch (e) {}
    try {
        const map = loadCapitalMap();
        Object.keys(map || {}).forEach(k => keys.add(k));
    } catch (e) {}
    return Array.from(keys).sort();
}

function propagateCapitalFrom(startDateKey) {
    const map = loadCapitalMap();
    const allDates = getAllKnownDates();
    if (allDates.length === 0) return;

    // find starting index: first date >= startDateKey
    let startIdx = allDates.findIndex(d => d >= startDateKey);
    if (startIdx === -1) startIdx = 0;

    // determine previous final (start point)
    let prevFinal = null;
    // if there's a date before startIdx with final in map, use it
    for (let i = startIdx - 1; i >= 0; i--) {
        const d = allDates[i];
        if (map[d] && typeof map[d].final === 'number') { prevFinal = map[d].final; break; }
    }
    if (prevFinal === null) prevFinal = DEFAULT_START_CAPITAL;

    // propagate through allDates starting at startIdx
    for (let i = startIdx; i < allDates.length; i++) {
        const d = allDates[i];
        // read journal data for date (localStorage preferred)
        let journal = null;
        try {
            const raw = localStorage.getItem(`trading_${d}`);
            if (raw) journal = JSON.parse(raw);
        } catch (e) { journal = null; }

        const tp = (journal && Array.isArray(journal.tps)) ? journal.tps.reduce((s,it)=>s+ (Number(it.value)||0),0) : 0;
        const sl = (journal && Array.isArray(journal.sls)) ? journal.sls.reduce((s,it)=>s+ (Number(it.value)||0),0) : 0;
        const net = tp - sl;

        const start = prevFinal;
        const final = Number((start + net).toFixed(2));
        map[d] = { start, final };
        // persist start/final into the journal localStorage so each date keeps its capital history
        try {
            const key = `trading_${d}`;
            const existingRaw = localStorage.getItem(key);
            let existing = null;
            if (existingRaw) {
                try { existing = JSON.parse(existingRaw); } catch (e) { existing = null; }
            }
            if (!existing || typeof existing !== 'object') existing = { tps: [], sls: [] };
            existing.startCapital = start;
            existing.finalCapital = final;
            localStorage.setItem(key, JSON.stringify(existing));
            __journalCache.set(d, existing);
        } catch (e) { /* ignore storage errors */ }
        prevFinal = final;
    }

    saveCapitalMap(map);
}

function getLatestProcessedDate() {
    const map = loadCapitalMap();
    const keys = Object.keys(map || {});
    if (keys.length === 0) return null;
    return keys.sort().slice(-1)[0];
}
const DATE_STORAGE_KEY = 'trading_selected_date';

const datePicker = document.getElementById('datePicker');
const today = new Date().toISOString().split('T')[0];
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

// Sincronización automática al iniciar sesión / restaurar auth
window.addEventListener('firebase-auth-ready', async () => {
    // 1) Cargar datos remotos de la fecha actual y enganchar listener en tiempo real
    try { await loadDataFirestore(); } catch (e) { /* ignore */ }

    // 2) Actualizar UI de autenticación
    updateAuthUI();

    // 3) Si el usuario está autenticado con cuenta (no anónima),
    //    intentar migrar automáticamente datos locales que aún no estén en Firestore.
    try {
        const uid = window._firebase && window._firebase.uid;
        const user = window._firebase && window._firebase.auth && window._firebase.auth.currentUser;
        const localKeys = getLocalTradingKeys();

        // Solo migrar automáticamente si el usuario tiene una cuenta (email)
        if (uid && user && user.email && localKeys.length > 0) {
            // Migrar en background sin mostrar botón ni forzar interacción.
            migrateLocalToFirestore(false).catch(err => {
                console.warn('Error en migración automática local->Firestore', err);
            });
        }
    } catch (e) {
        console.warn('Error comprobando migración automática local->firestore', e);
    }
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
});

// Capital input: permitir editar el capital base (porcentaje)
try {
    const capitalInput = document.getElementById('capital-input');
    if (capitalInput) {
        capitalInput.addEventListener('change', () => {
            const v = parseFloat(capitalInput.value);
            if (!isNaN(v)) {
                currentData.startCapital = v;
                saveData();
            }
        });
    }
} catch (e) { /* ignore if DOM not ready */ }

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
                    sls: Array.isArray(docData.sls) ? docData.sls : [],
                    startCapital: typeof docData.startCapital === 'number' ? docData.startCapital : DEFAULT_START_CAPITAL,
                    finalCapital: typeof docData.finalCapital === 'number' ? docData.finalCapital : null
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
    currentData = parsed ? parsed : { tps: [], sls: [], startCapital: DEFAULT_START_CAPITAL };
    // Determinar startCapital usando el mapa persistente de capitals
    try {
        const map = loadCapitalMap();
        const selected = date;
        // If exact date has stored start, use it
        if (map[selected] && typeof map[selected].start === 'number') {
            currentData.startCapital = map[selected].start;
        } else {
            // Find the most recent previous date in map
            const keys = Object.keys(map || {}).sort();
            let prev = null;
            for (let i = keys.length - 1; i >= 0; i--) {
                if (keys[i] < selected) { prev = keys[i]; break; }
            }
            if (prev && typeof map[prev].final === 'number') {
                currentData.startCapital = map[prev].final;
            } else {
                currentData.startCapital = DEFAULT_START_CAPITAL;
            }
        }

        // Nota: No forzamos el startCapital al último final procesado aquí.
        // La propagación y actualización de capital hacia fechas posteriores
        // se realiza en `propagateCapitalFrom()` cuando se guardan cambios.
    } catch (e) { /* fallback ya establecido */ }

    normalizeCurrentData();
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

    ensureJournalCollectionListener();

    const db = window._firebase.db;
    const docRef = window.firebaseFirestoreDoc(db, 'users', uid, 'journals', date);

    try {
        // 1) Leer una vez para inicializar la UI
        const snap = await window.firebaseFirestoreGetDoc(docRef);
        if (snap && snap.exists && snap.exists()) {
            currentData = snap.data() || { tps: [], sls: [], startCapital: DEFAULT_START_CAPITAL };
        } else {
            currentData = { tps: [], sls: [], startCapital: DEFAULT_START_CAPITAL };
        }
        normalizeCurrentData();
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
    // Calcular y guardar finalCapital antes de persistir
    try {
        currentData.finalCapital = computeFinalCapitalFromData(currentData);
    } catch (e) { /* ignore */ }
    // Siempre mantén un cache local por velocidad
    localStorage.setItem(storageKey, JSON.stringify(currentData));
    // Actualizar mapa de capital para esta fecha y propagar a fechas posteriores
    try {
        const map = loadCapitalMap();
        map[date] = { start: currentData.startCapital, final: currentData.finalCapital };
        saveCapitalMap(map);
        propagateCapitalFrom(date);
    } catch (e) { console.warn('Error actualizando capital map', e); }
    renderUI();

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

        // éxito
        if (statusSync) {
            statusSync.classList.remove('animate-pulse','bg-yellow-400');
            statusSync.classList.add('bg-green-400');
            statusSync.title = 'Sincronización OK';
        }
        showToast('sincronizado correctamente', 'success', 1800);
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
    // Si el usuario no está autenticado, mostrar advertencia (y respetar preferencia)
    const uid = window._firebase && window._firebase.uid;
    if (!uid) {
        const ok = await showAddWarningIfNeeded();
        if (!ok) return;
    }
    const inputId = type === 'tp' ? 'tp-input' : 'sl-input';
    const assetId = type === 'tp' ? 'tp-asset' : 'sl-asset'; // ID del Activo

    const input = document.getElementById(inputId);
    const assetInput = document.getElementById(assetId);
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
    const ok = await showConfirmModal('¿Eliminar todos los datos locales y en la nube? Esta acción es irreversible. ¿Deseas continuar?');
    if (!ok) return;

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
    currentData = { tps: [], sls: [], startCapital: DEFAULT_START_CAPITAL };
    normalizeCurrentData();
    renderUI();
    saveData(); // también intentará sincronizar/actualizar estado

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
            // actualizar listeners/UI
            loadDataFirestore().catch(()=>{});
        }
    } catch (err) {
        console.error('Error eliminando datos en la nube', err);
        showToast('Ocurrió un error al eliminar datos en la nube', 'error', 4000);
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
                <button onclick="startEdit('${type}', ${item.id})" title="Editar" class="entry-action-btn entry-edit text-slate-400 hover:text-slate-50 text-xs"><i class="fa-solid fa-pen-to-square"></i></button>
                <button onclick="deleteEntry('${type}', ${item.id})" title="Eliminar" class="entry-action-btn entry-delete text-red-300 hover:text-red-500 text-xs"><i class="fa-solid fa-xmark"></i></button>
            </div>
        `;
        container.appendChild(row);
    });
}

function updateTotals() {
    const tpTotal = currentData.tps.reduce((acc, curr) => acc + curr.value, 0);
    const slTotal = currentData.sls.reduce((acc, curr) => acc + curr.value, 0);
    const net = tpTotal - slTotal;

    // Calcular capital dinámico: startCapital + net (ambos en %)
    const startCapital = (typeof currentData.startCapital === 'number') ? currentData.startCapital : DEFAULT_START_CAPITAL;
    const capital = startCapital + net;
    const capitalEl = document.getElementById('capital-input');
    if (capitalEl) {
        // actualizar visualmente (sin el símbolo % dentro del input)
        capitalEl.value = capital.toFixed(2);
    }
    // Mantener finalCapital en memoria para uso inmediato
    try { currentData.finalCapital = Number(capital.toFixed(2)); } catch (e) { /* ignore */ }

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

        const weeklyContainer = document.getElementById('weekly-summaries');
        const monthlyContainer = document.getElementById('monthly-summaries');
        const dailyContainer = document.getElementById('daily-summary-list');
        if (!weeklyContainer && !dailyContainer && !monthlyContainer) return;
        if (weeklyContainer) weeklyContainer.innerHTML = '';
        if (monthlyContainer) monthlyContainer.innerHTML = '';
        if (dailyContainer) dailyContainer.innerHTML = '';

        // Usar helpers superiores: readJournalForDate / readManyJournalForDates

        // Generar 4 semanas: semana actual (w=0) y las 3 anteriores (w=1..3)
        for (let w = 0; w < 4; w++) {
            const monday = new Date(baseMonday);
            monday.setDate(baseMonday.getDate() - (w * 7));
            const sunday = new Date(monday);
            sunday.setDate(monday.getDate() + 6);

            const options = { day: '2-digit', month: '2-digit' };
            const rangeText = `${monday.toLocaleDateString('es-ES', options)} - ${sunday.toLocaleDateString('es-ES', options)}/${monday.getFullYear()}`;

            let weeklyNet = 0;
            let totalDays = 0;
            let winDays = 0;
            let lossDays = 0;
            const dailyRows = [];

            // Preparar lectura paralela de los 7 días de la semana
            const weekDates = [];
            for (let i = 0; i < 7; i++) {
                const tempDate = new Date(monday);
                tempDate.setDate(monday.getDate() + i);
                weekDates.push(new Date(tempDate));
            }

            const weekKeys = weekDates.map(d => d.toISOString().split('T')[0]);
            // Intentar leer en batch (localStorage/cache + Firestore 'in' en chunks)
            const weekMap = await readManyJournalForDates(weekKeys);

            // Procesar resultados en memoria
            for (let i = 0; i < weekKeys.length; i++) {
                const data = weekMap[weekKeys[i]];
                if (data && ((data.tps && data.tps.length > 0) || (data.sls && data.sls.length > 0))) {
                    const tempDate = weekDates[i];
                    const dailyTp = (data.tps || []).reduce((s, it) => s + it.value, 0);
                    const dailySl = (data.sls || []).reduce((s, it) => s + it.value, 0);
                    const dailyNet = dailyTp - dailySl;
                    weeklyNet += dailyNet;
                    totalDays++;
                    if (dailyNet > 0) winDays++;
                    else if (dailyNet < 0) lossDays++;
                    dailyRows.push({ date: new Date(tempDate), tp: dailyTp, sl: dailySl, net: dailyNet });
                }
            }

            // Ocultar semanas sin trades
            if (totalDays === 0) {
                continue; // no renderizar esta semana
            }

            // Crear tarjeta de semana con botón toggle
            const card = document.createElement('div');
            card.className = 'sub-surface p-4';
            const weekNetSign = weeklyNet > 0 ? '+' : '';
            const weekNetClass = weeklyNet > 0 ? 'text-green-500 dark:text-green-400' : (weeklyNet < 0 ? 'text-red-500 dark:text-red-400' : 'text-slate-800 dark:text-slate-200');
            const weekId = `week-${monday.toISOString().split('T')[0]}`;
            const isCurrentWeek = (w === 0);
            card.innerHTML = `
                <div class="flex justify-between items-start mb-3">
                    <div class="flex items-center gap-3">
                        <div class="font-medium text-slate-600 dark:text-slate-300 text-sm">Semana ${rangeText}</div>
                        <button type="button" class="toggle-week-btn text-xs px-2 py-1 border rounded text-slate-600 dark:text-slate-200 bg-white dark:bg-slate-700" data-week-id="${weekId}" aria-expanded="false">Ver días</button>
                    </div>
                    <div class="font-bold text-lg ${weekNetClass}">${weekNetSign}${weeklyNet.toFixed(2)}%</div>
                </div>
                <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                    <div>
                        <div class="text-xs text-slate-500 dark:text-slate-400 mb-1">Total Días</div>
                        <div class="font-bold text-slate-800 dark:text-slate-200">${totalDays}</div>
                    </div>
                    <div>
                        <div class="text-xs text-green-600 dark:text-green-400 mb-1">Días Ganadores</div>
                        <div class="font-bold text-green-600 dark:text-green-400">${winDays}</div>
                    </div>
                    <div>
                        <div class="text-xs text-red-500 dark:text-red-400 mb-1">Días Perdedores</div>
                        <div class="font-bold text-red-500 dark:text-red-400">${lossDays}</div>
                    </div>
                    <div>
                        <div class="text-xs text-blue-500 dark:text-blue-400 mb-1">Tasa de Éxito</div>
                        <div class="font-bold text-blue-600 dark:text-blue-400">${(totalDays>0?((winDays/totalDays)*100).toFixed(1):'0.0')}%</div>
                    </div>
                </div>
            `;

            // Lista de días dentro de la tarjeta
            if (dailyRows.length > 0) {
                const daysWrapper = document.createElement('div');
                // Por defecto ocultar los días en todas las semanas
                daysWrapper.className = 'mt-3 space-y-2 hidden';
                daysWrapper.id = weekId;
                dailyRows.forEach(row => {
                    const dateStr = row.date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
                    const dateCap = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);
                    const netColor = row.net > 0 ? 'text-green-600 dark:text-green-400' : (row.net < 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-300');
                    const dotColor = row.net > 0 ? 'text-green-500' : (row.net < 0 ? 'text-red-500' : 'text-gray-300');
                    const sign = row.net > 0 ? '+' : '';

                    const div = document.createElement('div');
                    div.className = "bg-slate-50 dark:bg-slate-700/50 rounded p-3 flex justify-between items-center border border-slate-100 dark:border-slate-600 cursor-pointer hover:shadow-md";
                    div.innerHTML = `
                        <div class="flex items-center gap-3">
                            <i class="fa-solid fa-circle text-[10px] ${dotColor}"></i>
                            <div>
                                <div class="text-sm font-bold text-slate-700 dark:text-slate-200">${dateCap}</div>
                                <div class="text-xs text-slate-400">TP: +${row.tp.toFixed(2)}% | SL: -${row.sl.toFixed(2)}%</div>
                            </div>
                        </div>
                        <div class="font-bold ${netColor}">${sign}${row.net.toFixed(2)}%</div>
                    `;

                    const dateKey = row.date.toISOString().split('T')[0];
                    div.addEventListener('click', (e) => {
                        if (e.target && (e.target.tagName === 'BUTTON' || e.target.closest && e.target.closest('button'))) return;
                        const picker = document.getElementById('datePicker');
                        if (picker) {
                            picker.value = dateKey;
                            try { localStorage.setItem(DATE_STORAGE_KEY, dateKey); } catch (err) {}
                        }
                        try { loadData(); } catch (err) { console.warn('Error cargando datos tras click resumen', err); }
                        const summaries = document.getElementById('summaries-section');
                        if (summaries) summaries.classList.add('hidden');
                        const toggleBtn = document.getElementById('btn-toggle-summary');
                        if (toggleBtn) toggleBtn.innerHTML = '<i class="fa-solid fa-chart-column"></i> Ver Resúmenes';
                        try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {}
                    });

                    daysWrapper.appendChild(div);
                    });
                    card.appendChild(daysWrapper);
                    // Asociar comportamiento al botón toggle de esta tarjeta
                    const toggleBtn = card.querySelector(`button.toggle-week-btn[data-week-id="${weekId}"]`);
                    if (toggleBtn) {
                        toggleBtn.addEventListener('click', (ev) => {
                            ev.stopPropagation();
                            const target = document.getElementById(weekId);
                            if (!target) return;
                            const wasHidden = target.classList.toggle('hidden');
                            // Actualizar texto y atributo aria-expanded
                            toggleBtn.innerText = wasHidden ? 'Ver días' : 'Ocultar días';
                            toggleBtn.setAttribute('aria-expanded', String(!wasHidden));
                        });
                    }
            } else {
                const empty = document.createElement('div');
                empty.className = 'text-center text-slate-400 dark:text-slate-500 text-sm py-3';
                empty.innerText = 'No hay registros esta semana';
                card.appendChild(empty);
            }

            weeklyContainer.appendChild(card);
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
                    wkKeys.push(d.toISOString().split('T')[0]);
                }
                try {
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
                } catch (e) {
                    console.warn('Error leyendo semana en batch', e);
                }
            }
        } catch (e) {
            console.warn('Error rellenando vista Día', e);
        }

        // Generar resumen mensual para el mes seleccionado (mostrar siempre en la vista "Mes")

        if (monthlyContainer) {
            const year = selectedDate.getFullYear();
            const month = selectedDate.getMonth();
            const first = new Date(year, month, 1);
            const last = new Date(year, month + 1, 0);

            let monthNet = 0, monthTotalDays = 0, monthWinDays = 0, monthLossDays = 0;
            // Construir lista de keys para el mes y leer en paralelo
            const monthKeys = [];
            for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
                monthKeys.push(new Date(d).toISOString().split('T')[0]);
            }
            const monthMap = await readManyJournalForDates(monthKeys);
            for (let i = 0; i < monthKeys.length; i++) {
                const data = monthMap[monthKeys[i]];
                if (data && ((data.tps && data.tps.length > 0) || (data.sls && data.sls.length > 0))) {
                    const tp = (data.tps || []).reduce((s, it) => s + it.value, 0);
                    const sl = (data.sls || []).reduce((s, it) => s + it.value, 0);
                    const net = tp - sl;
                    monthNet += net;
                    monthTotalDays++;
                    if (net > 0) monthWinDays++; else if (net < 0) monthLossDays++;
                }
            }

            const monthCard = document.createElement('div');
            monthCard.className = 'muted-card p-4';
            const monthName = first.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
            const signM = monthNet > 0 ? '+' : '';
            const monthNetClass = monthNet > 0 ? 'text-green-500 dark:text-green-400' : (monthNet < 0 ? 'text-red-500 dark:text-red-400' : 'text-slate-800 dark:text-slate-200');
            monthCard.innerHTML = `
                <div class="flex justify-between items-center mb-3">
                    <div class="font-bold text-slate-700 dark:text-slate-200">Resumen mensual — ${monthName}</div>
                    <div class="font-bold ${monthNetClass}">${signM}${monthNet.toFixed(2)}%</div>
                </div>
                <div class="grid grid-cols-3 gap-4 text-center">
                    <div>
                        <div class="text-xs text-slate-500 dark:text-slate-400 mb-1">Días registrados</div>
                        <div class="font-bold">${monthTotalDays}</div>
                    </div>
                    <div>
                        <div class="text-xs text-green-600 dark:text-green-400 mb-1">Días Ganadores</div>
                        <div class="font-bold text-green-600 dark:text-green-400">${monthWinDays}</div>
                    </div>
                    <div>
                        <div class="text-xs text-red-500 dark:text-red-400 mb-1">Días Perdedores</div>
                        <div class="font-bold text-red-500 dark:text-red-400">${monthLossDays}</div>
                    </div>
                </div>
            `;

            monthlyContainer.appendChild(monthCard);
        }
    } finally {
        try { hideSummariesLoading(); } catch (e) {}
        window._isGeneratingSummaries = false;
    }
}

// --- VISTAS DE RESUMEN (Día / Semana / Mes) ---
function setSummaryView(view) {
    try {
        const dailyPanel = document.getElementById('daily-panel');
        const weeklyPanel = document.getElementById('weekly-panel');
        const monthlyPanel = document.getElementById('monthly-panel');

        if (dailyPanel) dailyPanel.classList.toggle('hidden', view !== 'day');
        if (weeklyPanel) weeklyPanel.classList.toggle('hidden', view !== 'week');
        if (monthlyPanel) monthlyPanel.classList.toggle('hidden', view !== 'month');

        // Actualizar estados de botones
        const dayBtn = document.getElementById('summary-view-day');
        const weekBtn = document.getElementById('summary-view-week');
        const monthBtn = document.getElementById('summary-view-month');
        const allBtns = [dayBtn, weekBtn, monthBtn];
        allBtns.forEach(b => {
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
    } catch (e) {
        console.warn('setSummaryView error', e);
    }
}

function initSummaryView() {
    const toggle = document.getElementById('summary-view-toggle');
    if (!toggle) return;
    const dayBtn = document.getElementById('summary-view-day');
    const weekBtn = document.getElementById('summary-view-week');
    const monthBtn = document.getElementById('summary-view-month');
    [dayBtn, weekBtn, monthBtn].forEach(b => {
        if (!b) return;
        b.addEventListener('click', () => {
            const v = b.dataset && b.dataset.view ? b.dataset.view : (b.id || '').replace('summary-view-','');
            setSummaryView(v);
        });
    });

    const saved = localStorage.getItem('summary_view') || 'day';
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
        const dateKey = dateObj.toISOString().split('T')[0];
        div.addEventListener('click', (e) => {
            // Evitar que clicks en botones internos (si los hubiera) desencadenen navegación
            if (e.target && (e.target.tagName === 'BUTTON' || e.target.closest && e.target.closest('button'))) return;
            const picker = document.getElementById('datePicker');
            if (picker) {
                picker.value = dateKey;
                try { localStorage.setItem(DATE_STORAGE_KEY, dateKey); } catch (err) { /* ignore */ }
            }
            // Cargar datos y ocultar resumen para mostrar la vista principal
            try { loadData(); } catch (err) { console.warn('Error cargando datos tras click resumen', err); }
            const summaries = document.getElementById('summaries-section');
            if (summaries) summaries.classList.add('hidden');
            const toggleBtn = document.getElementById('btn-toggle-summary');
            if (toggleBtn) toggleBtn.innerHTML = '<i class="fa-solid fa-chart-column"></i> Ver Resúmenes';
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
        status.classList.remove('hidden');
        statusText.innerText = 'No conectado';
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
        // Asegurar que la sección desplegable de resúmenes esté oculta si el usuario no está logueado
        if (summariesSection && !isLoggedIn) summariesSection.classList.add('hidden');
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

// Watch for auth changes when firebase becomes available
function watchAuthChanges() {
    if (window._firebase && window._firebase.auth) {
        const auth = window._firebase.auth;
        auth.onAuthStateChanged(() => {
            if (window._firebase && window._firebase.uid) {
                ensureJournalCollectionListener();
            } else {
                cleanupJournalCollectionListener();
            }
            updateAuthUI();
        });
        // initial update
        updateAuthUI();
        if (window._firebase && window._firebase.uid) {
            ensureJournalCollectionListener();
        } else {
            cleanupJournalCollectionListener();
        }
    } else {
        window.addEventListener('firebase-auth-ready', () => {
            if (window._firebase && window._firebase.auth) {
                window._firebase.auth.onAuthStateChanged(() => updateAuthUI());
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

function openAuthModal(mode = 'register') {
    authModalMode = mode;
    const overlay = document.getElementById('auth-modal-overlay');
    const title = document.getElementById('auth-modal-title');
    const submitBtn = document.getElementById('auth-modal-submit');
    const switchText = document.getElementById('auth-modal-switch-text');
    const switchBtn = document.getElementById('auth-modal-switch');

    if (!overlay || !title || !submitBtn || !switchText || !switchBtn) return;

    if (mode === 'register') {
        title.innerText = 'Crear cuenta';
        submitBtn.innerText = 'Registrarme';
        switchText.innerText = '¿Ya tienes cuenta?';
        switchBtn.innerText = 'Inicia sesión aquí';
    } else {
        title.innerText = 'Iniciar sesión';
        submitBtn.innerText = 'Iniciar sesión';
        switchText.innerText = '¿Aún no tienes cuenta?';
        switchBtn.innerText = 'Regístrate aquí';
    }

    overlay.classList.remove('hidden');
}

function closeAuthModal() {
    const overlay = document.getElementById('auth-modal-overlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
}

function setupAuthModal() {
    const overlay = document.getElementById('auth-modal-overlay');
    if (!overlay) return;

    const closeBtn = document.getElementById('auth-modal-close');
    const submitBtn = document.getElementById('auth-modal-submit');
    const switchBtn = document.getElementById('auth-modal-switch');
    const googleBtn = document.getElementById('auth-google-btn');

    // Cerrar
    closeBtn.addEventListener('click', closeAuthModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeAuthModal();
    });

    // Cambiar entre modo registro / login
    switchBtn.addEventListener('click', () => {
        openAuthModal(authModalMode === 'register' ? 'login' : 'register');
    });

    // Submit email/password
    submitBtn.addEventListener('click', async () => {
        const email = document.getElementById('auth-email').value.trim();
        const password = document.getElementById('auth-password').value;

        if (!email || !password) {
            showToast('Completa correo y contraseña', 'error');
            return;
        }
        if (password.length < 6) {
            showToast('La contraseña debe tener al menos 6 caracteres', 'error');
            return;
        }

        try {
            if (authModalMode === 'register') {
                await window.registerWithEmailPassword(email, password);
                showToast('Cuenta creada e iniciada sesión', 'success');
            } else {
                await window.loginWithEmailPassword(email, password);
                showToast('Sesión iniciada', 'success');
            }
            closeAuthModal();
        } catch (err) {
            console.error(err);
            const msg = (err && err.message) || 'Error de autenticación';
            showToast(msg, 'error');
        }
    });

    // Google dentro del modal
    googleBtn.addEventListener('click', async () => {
        try {
            await window.signInWithGoogle();
            showToast('Sesión iniciada con Google', 'success');
            closeAuthModal();
        } catch (err) {
            console.error(err);
            showToast('Error al iniciar sesión con Google', 'error');
        }
    });
}

// Ejecutar al cargar
setupAuthModal();

watchAuthChanges();
// Inicializar selector de vista de resúmenes inmediatamente
try { initSummaryView(); } catch (e) { /* ignore */ }