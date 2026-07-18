// Pruebas puras de la lógica de Jornada de Trading.
// Reproduce las funciones críticas tal como están en app.js para detectar bugs.

const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log('  ✔ ' + name); passed++; }
    catch (e) { console.log('  ✘ ' + name + '\n     → ' + (e.message || e)); failed++; }
}
function section(t) { console.log('\n— ' + t + ' —'); }

// =====================================================
// 1) Reproducir la versión actual: toISOString().split('T')[0]
// =====================================================
section('Date keys — versión actual (toISOString)');

function currentKey(date) {
    return date.toISOString().split('T')[0];
}

test('Local midnight 2024-01-15 en UTC-5 (Bogotá) produce "2024-01-15"', () => {
    // Simulamos UTC-5: local midnight 2024-01-15 = UTC 2024-01-15T05:00:00Z
    const d = new Date('2024-01-15T05:00:00.000Z'); // mismo instant que medianoche local UTC-5
    assert.strictEqual(currentKey(d), '2024-01-15');
});

test('Local midnight 2024-01-15 en UTC+1 (Madrid) produce "2024-01-14" (BUG)', () => {
    // Simulamos UTC+1: local midnight 2024-01-15 = UTC 2024-01-14T23:00:00Z
    const d = new Date('2024-01-14T23:00:00.000Z');
    // Esto demuestra el bug: la clave queda 1 día antes
    assert.strictEqual(currentKey(d), '2024-01-14');
});

// =====================================================
// 2) Versión propuesta: localDateKey
// =====================================================
section('Date keys — versión propuesta (localDateKey)');

function localDateKey(date) {
    if (!(date instanceof Date) || isNaN(date)) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

test('Devuelve fecha local correcta independiente de zona horaria', () => {
    // Construido como local: el día siempre debe coincidir con getDate()
    const d = new Date(2024, 0, 15); // Año=2024, Mes=Enero (0), Día=15 — siempre local
    assert.strictEqual(localDateKey(d), '2024-01-15');
});

test('Maneja meses y días con padding cero', () => {
    const d = new Date(2024, 2, 5); // 5 de marzo
    assert.strictEqual(localDateKey(d), '2024-03-05');
});

test('Maneja diciembre / final de año', () => {
    const d = new Date(2024, 11, 31);
    assert.strictEqual(localDateKey(d), '2024-12-31');
});

test('Devuelve "" para Date inválido', () => {
    assert.strictEqual(localDateKey(new Date('invalid')), '');
});

// =====================================================
// 3) Reconstrucción de "monday" para una semana dada
// =====================================================
section('Cálculo del lunes de la semana');

function getWeekMonday(date) {
    const dayOfWeek = date.getDay() || 7; // dom=0 -> 7
    const monday = new Date(date);
    monday.setDate(date.getDate() - dayOfWeek + 1);
    return monday;
}

test('Lunes de un lunes = mismo día', () => {
    const mon = new Date(2024, 0, 15); // 15 ene 2024 = lunes
    assert.strictEqual(localDateKey(getWeekMonday(mon)), '2024-01-15');
});

test('Lunes de un viernes = 4 días antes', () => {
    const fri = new Date(2024, 0, 19);
    assert.strictEqual(localDateKey(getWeekMonday(fri)), '2024-01-15');
});

test('Lunes de un domingo = 6 días antes', () => {
    const sun = new Date(2024, 0, 21);
    assert.strictEqual(localDateKey(getWeekMonday(sun)), '2024-01-15');
});

test('Lunes en cambio de mes (1 ene 2024 = lunes)', () => {
    const d = new Date(2024, 0, 7); // 7 ene = domingo
    assert.strictEqual(localDateKey(getWeekMonday(d)), '2024-01-01');
});

// =====================================================
// 4) Sumatorias TP / SL / Net
// =====================================================
section('Cálculo de totales TP/SL/Net');

function calcTotals(data) {
    const tps = (data && data.tps) || [];
    const sls = (data && data.sls) || [];
    const tp = tps.reduce((s, it) => s + (Number(it.value) || 0), 0);
    const sl = sls.reduce((s, it) => s + (Number(it.value) || 0), 0);
    return { tp, sl, net: tp - sl };
}

test('TP simple', () => {
    const r = calcTotals({ tps: [{ value: 1.5 }, { value: 2 }], sls: [] });
    assert.strictEqual(r.tp, 3.5);
    assert.strictEqual(r.sl, 0);
    assert.strictEqual(r.net, 3.5);
});

test('SL resta del net', () => {
    const r = calcTotals({ tps: [{ value: 5 }], sls: [{ value: 2 }] });
    assert.strictEqual(r.net, 3);
});

test('Valores como string se coercen', () => {
    const r = calcTotals({ tps: [{ value: '1.5' }, { value: '2.25' }], sls: [{ value: '0.5' }] });
    assert.strictEqual(r.tp, 3.75);
    assert.strictEqual(r.sl, 0.5);
    assert.strictEqual(r.net, 3.25);
});

test('Valores no numéricos no rompen la suma', () => {
    const r = calcTotals({ tps: [{ value: 1 }, { value: 'foo' }, { value: NaN }], sls: [] });
    assert.strictEqual(r.tp, 1);
});

test('Datos vacíos = ceros', () => {
    const r = calcTotals({});
    assert.deepStrictEqual(r, { tp: 0, sl: 0, net: 0 });
});

// =====================================================
// 5) Capital acumulado
// =====================================================
section('Cálculo del timeline de capital');

function computeCapital(initial, journals) {
    // Copia de computeCapitalTimelineFromJournals (app.js): con initial <= 0
    // la base es 0 y relativePct queda en 0 — nunca NaN/Infinity.
    const base = Number(initial) > 0 ? Number(initial) : 0;
    const keys = Object.keys(journals).sort();
    const timeline = [];
    let cum = 0;
    for (const k of keys) {
        const d = journals[k];
        const tp = (d.tps || []).reduce((s, it) => s + (Number(it.value) || 0), 0);
        const sl = (d.sls || []).reduce((s, it) => s + (Number(it.value) || 0), 0);
        const dailyNet = tp - sl;
        if (!dailyNet) continue;
        cum += dailyNet;
        timeline.push({ dateKey: k, cumulativeNet: cum, capital: base + cum, relativePct: base > 0 ? (cum / base) * 100 : 0 });
    }
    return timeline;
}

test('Capital crece linealmente con net%', () => {
    const j = {
        '2024-01-15': { tps: [{ value: 5 }], sls: [] }, // +5%
        '2024-01-16': { tps: [{ value: 2 }], sls: [{ value: 1 }] } // +1%
    };
    const tl = computeCapital(1000, j);
    assert.strictEqual(tl.length, 2);
    assert.strictEqual(tl[0].capital, 1005);
    assert.strictEqual(tl[1].capital, 1006);
    assert.strictEqual(tl[1].relativePct, 0.6);
});

test('Días sin net no aparecen en timeline', () => {
    const j = {
        '2024-01-15': { tps: [{ value: 5 }], sls: [{ value: 5 }] }, // 0 net
        '2024-01-16': { tps: [{ value: 1 }], sls: [] }
    };
    const tl = computeCapital(1000, j);
    assert.strictEqual(tl.length, 1);
    assert.strictEqual(tl[0].dateKey, '2024-01-16');
});

// =====================================================
// 5b) Capital inicial 0 (default nuevo) — sin NaN/Infinity
// =====================================================
section('Capital inicial 0 — porcentajes sin NaN/Infinity');

test('initial=0: capital = neto acumulado y relativePct = 0', () => {
    const j = {
        '2024-01-15': { tps: [{ value: 5 }], sls: [{ value: 2 }] }, // +3
        '2024-01-16': { tps: [], sls: [{ value: 1 }] } // -1
    };
    const tl = computeCapital(0, j);
    assert.strictEqual(tl.length, 2);
    assert.strictEqual(tl[0].capital, 3);
    assert.strictEqual(tl[1].capital, 2);
    assert.strictEqual(tl[0].relativePct, 0);
    assert.strictEqual(tl[1].relativePct, 0);
});

test('initial=0: ningún campo es NaN/Infinity', () => {
    const j = { '2024-01-15': { tps: [{ value: 5 }], sls: [] } };
    for (const row of computeCapital(0, j)) {
        assert.ok(Number.isFinite(row.capital), 'capital finito');
        assert.ok(Number.isFinite(row.relativePct), 'relativePct finito');
        assert.ok(Number.isFinite(row.cumulativeNet), 'cumulativeNet finito');
    }
});

test('initial negativo o inválido se trata como base 0 (sin dividir)', () => {
    const j = { '2024-01-15': { tps: [{ value: 5 }], sls: [] } };
    for (const bad of [-100, NaN, undefined, null, 'foo']) {
        const tl = computeCapital(bad, j);
        assert.strictEqual(tl[0].relativePct, 0);
        assert.ok(Number.isFinite(tl[0].capital));
    }
});

test('initial>0 conserva el comportamiento anterior (sin cambios)', () => {
    const j = { '2024-01-15': { tps: [{ value: 6 }], sls: [] } };
    const tl = computeCapital(1000, j);
    assert.strictEqual(tl[0].capital, 1006);
    assert.strictEqual(tl[0].relativePct, 0.6);
});

// =====================================================
// 5c) sanitizeCapitalValue — acepta 0, rechaza negativos
// =====================================================
section('sanitizeCapitalValue (default 0)');

function sanitizeCapitalValue(val, fallback = 0) {
    // Copia exacta de app.js
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return n;
}

test('Acepta 0 (sobrevive una carga)', () => assert.strictEqual(sanitizeCapitalValue(0), 0));
test('Acepta positivos', () => assert.strictEqual(sanitizeCapitalValue(110), 110));
test('Rechaza negativos → fallback 0', () => assert.strictEqual(sanitizeCapitalValue(-5), 0));
test('Rechaza NaN/undefined → fallback dado', () => {
    assert.strictEqual(sanitizeCapitalValue(NaN, 7), 7);
    assert.strictEqual(sanitizeCapitalValue(undefined, 7), 7);
});

// =====================================================
// 5d) Reset de clearAll — capital, depósitos y retiros a default
// =====================================================
section('clearAll — reset de capitalConfig y snapshot');

// Copia de getCapitalSnapshot (app.js): capital = initial + (depósitos − retiros),
// y si hay timeline usa el último punto sumándole el neto de movimientos.
function capitalSnapshot(config, timeline) {
    const sum = list => (Array.isArray(list) ? list : []).reduce((s, m) => s + (Number(m.amount) || 0), 0);
    const net = sum(config.deposits) - sum(config.withdrawals);
    const base = { capital: config.initial + net, relativePct: 0, cumulativeNet: 0 };
    if (!timeline || timeline.length === 0) return base;
    const last = timeline[timeline.length - 1];
    return Object.assign({}, last, { capital: last.capital + net });
}

// Reset que aplica clearAll (app.js): default con capital 0 y sin movimientos.
function clearAllCapitalReset() {
    return { config: { initial: 0, withdrawals: [], deposits: [] }, timeline: [] };
}

test('Tras el reset, snapshot queda en 0 y sin %', () => {
    // Estado previo con datos (initial 110, depósito 50, retiro 20, un trade +5)
    let config = { initial: 110, withdrawals: [{ amount: 20 }], deposits: [{ amount: 50 }] };
    let timeline = computeCapital(config.initial, { '2024-01-15': { tps: [{ value: 5 }], sls: [] } });
    const before = capitalSnapshot(config, timeline);
    assert.strictEqual(before.capital, 145); // 110 + 5 + 50 − 20
    // Reset de clearAll
    const reset = clearAllCapitalReset();
    config = reset.config; timeline = reset.timeline;
    const snap = capitalSnapshot(config, timeline);
    assert.strictEqual(snap.capital, 0);
    assert.strictEqual(snap.relativePct, 0);
    assert.strictEqual(snap.cumulativeNet, 0);
});

test('Tras el reset, los totales de movimientos son 0 (chips ocultos)', () => {
    const { config } = clearAllCapitalReset();
    const total = kind => (Array.isArray(config[kind]) ? config[kind] : []).reduce((s, m) => s + (Number(m.amount) || 0), 0);
    // updateCapMoveUI oculta el chip cuando total <= 0
    assert.strictEqual(total('withdrawals'), 0);
    assert.strictEqual(total('deposits'), 0);
});

test('El reset sobrevive a sanitize (0 es válido, no vuelve a 1000)', () => {
    const { config } = clearAllCapitalReset();
    assert.strictEqual(sanitizeCapitalValue(config.initial), 0);
});

// =====================================================
// 6) Validación de entradas (addEntry)
// =====================================================
section('Validación de input addEntry');

function isValidEntry(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) && n > 0;
}

test('Rechaza 0', () => assert.strictEqual(isValidEntry('0'), false));
test('Rechaza negativos', () => assert.strictEqual(isValidEntry('-1'), false));
test('Rechaza vacío', () => assert.strictEqual(isValidEntry(''), false));
test('Rechaza letras', () => assert.strictEqual(isValidEntry('abc'), false));
test('Acepta 0.01', () => assert.strictEqual(isValidEntry('0.01'), true));
test('Acepta enteros', () => assert.strictEqual(isValidEntry('5'), true));
test('Acepta con coma decimal? NO', () => assert.strictEqual(isValidEntry('1,5'), true)); // parseFloat('1,5') = 1, OK pero no como esperado

// =====================================================
// 7) Migración local→remote: empty data
// =====================================================
section('Migración local→firestore: comportamiento');

function shouldMigrate(localData, remoteExists, remoteData) {
    const emptyLocal = !localData || (((!localData.tps || !localData.tps.length) && (!localData.sls || !localData.sls.length)));
    if (emptyLocal) return false;
    if (remoteExists) {
        const emptyRemote = !remoteData || ((!remoteData.tps || !remoteData.tps.length) && (!remoteData.sls || !remoteData.sls.length));
        return emptyRemote; // migra si remoto está vacío
    }
    return true;
}

test('Migra cuando remoto no existe', () => {
    assert.strictEqual(shouldMigrate({ tps: [{value: 1}], sls: [] }, false, null), true);
});
test('No migra cuando local está vacío', () => {
    assert.strictEqual(shouldMigrate({ tps: [], sls: [] }, false, null), false);
});
test('No migra cuando remoto ya tiene datos', () => {
    assert.strictEqual(shouldMigrate({ tps: [{value:1}], sls: [] }, true, { tps: [{value:5}], sls: [] }), false);
});

console.log(`\nResultados: ${passed} OK / ${failed} FALLÓ`);
process.exit(failed ? 1 : 0);
