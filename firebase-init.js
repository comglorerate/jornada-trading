// firebase-init.js (type="module")
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import {
  getFirestore,
  enableIndexedDbPersistence,
  doc,
  collection,
  getDoc,
  setDoc,
  updateDoc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword  } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";

// CONFIG: reemplaza si necesitas valores distintos (copiado desde Firebase Console)
const firebaseConfig = {
  apiKey: "AIzaSyBbCrkyJcQw285HhhEkoIFRQnLWdePHcJE",
  authDomain: "trading-journal-579dd.firebaseapp.com",
  projectId: "trading-journal-579dd",
  storageBucket: "trading-journal-579dd.firebasestorage.app",
  messagingSenderId: "427651445884",
  appId: "1:427651445884:web:af49563b09a265d1c6c5f9"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Intentar persistencia offline (IndexedDB)
// Desactivado temporalmente: da problemas con el SDK 12.x en este proyecto
// enableIndexedDbPersistence(db).catch((err) => {
//   console.warn('No se pudo habilitar persistence (IndexedDB):', err);
// });


// Nota: se ha eliminado la lógica de usuarios anónimos. No se crearán ni manejarán
// cuentas anónimas en este proyecto.

// Exponer `db`, `auth` y `uid` en `window` para usar desde `app.js` sin convertirlo a módulo
window._firebase = { db, auth, uid: null };

// Wrappers para usar las funciones Firestore desde scripts no modulares
window.firebaseFirestoreDoc = (...args) => doc(...args);
window.firebaseFirestoreCollection = (...args) => collection(...args);
window.firebaseFirestoreGetDoc = (ref) => getDoc(ref);
window.firebaseFirestoreSetDoc = (ref, data, options) => setDoc(ref, data, options);
window.firebaseFirestoreUpdateDoc = (ref, data) => updateDoc(ref, data);
window.firebaseFirestoreOnSnapshot = (ref, cb, errCb) => onSnapshot(ref, cb, errCb);

onAuthStateChanged(auth, user => {
  window._firebase.uid = user ? user.uid : null;
  window.dispatchEvent(new Event('firebase-auth-ready'));
});


// Helper para forzar que Firestore esté online desde la consola
// Por ahora NO forzamos nada de red: Firestore ya gestiona esto solo.
window.ensureFirestoreOnline = async function() {
  return;
};


// Google Auth helpers (expuestos en window)
const googleProvider = new GoogleAuthProvider();

window.signInWithGoogle = async function() {
  try {
    const a = window._firebase.auth;
    if (!a) throw new Error('Auth no inicializado');
    // Abrir popup para iniciar sesión con Google. No linkeamos cuentas anónimas
    // porque la lógica de usuarios anónimos fue eliminada.
    await signInWithPopup(a, googleProvider);
    console.log('Inicio de sesión con Google completado.');
  } catch (err) {
    console.error('Error signInWithGoogle:', err);
    throw err;
  }
};

window.signOutUser = async function() {
  try {
    await signOut(window._firebase.auth);
    console.log('Usuario desconectado');
  } catch (err) {
    console.error('Error signOut:', err);
  }
};

// Registro con email y contraseña
window.registerWithEmailPassword = async function(email, password) {
  try {
    const a = window._firebase && window._firebase.auth;
    if (!a) throw new Error('Auth no inicializado');
    const cred = await createUserWithEmailAndPassword(a, email, password);
    console.log('Usuario creado con email:', cred.user.uid);
    return cred.user;
  } catch (err) {
    console.error('Error registerWithEmailPassword:', err);
    throw err;
  }
};

// Login con email y contraseña
window.loginWithEmailPassword = async function(email, password) {
  try {
    const a = window._firebase && window._firebase.auth;
    if (!a) throw new Error('Auth no inicializado');
    const cred = await signInWithEmailAndPassword(a, email, password);
    console.log('Login con email OK, uid:', cred.user.uid);
    return cred.user;
  } catch (err) {
    console.error('Error loginWithEmailPassword:', err);
    throw err;
  }
};


// --- Helpers de diagnóstico ---
window.debug_printUid = function() {
  console.log('debug: current uid =', window._firebase && window._firebase.uid);
  return window._firebase && window._firebase.uid;
};

window.debug_listJournalDates = async function() {
  if (!window._firebase || !window._firebase.db) {
    console.warn('Firestore no inicializado');
    return null;
  }
  const uid = window._firebase.uid;
  if (!uid) {
    console.warn('No hay uid (usuario no autenticado)');
    return null;
  }
  try {
    const mod = await import('https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js');
    const { collection, getDocs } = mod;
    const collRef = collection(window._firebase.db, 'users', uid, 'journals');
    const snap = await getDocs(collRef);
    console.log('debug: documents found =', snap.size);
    const out = [];
    snap.forEach(d => { console.log(d.id, d.data()); out.push({ id: d.id, data: d.data() }); });
    return out;
  } catch (err) {
    console.error('debug_listJournalDates error:', err);
    throw err;
  }
};

window.debug_getJournal = async function(dateKey) {
  if (!window._firebase || !window._firebase.db) {
    console.warn('Firestore no inicializado');
    return null;
  }
  const uid = window._firebase.uid;
  if (!uid) {
    console.warn('No hay uid (usuario no autenticado)');
    return null;
  }
  if (!dateKey) {
    console.warn('Pasa una fecha en formato YYYY-MM-DD');
    return null;
  }
  try {
    const mod = await import('https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js');
    const { doc, getDoc } = mod;
    const ref = doc(window._firebase.db, 'users', uid, 'journals', dateKey);
    const snap = await getDoc(ref);
    console.log('debug_getJournal', dateKey, snap && snap.exists && snap.exists() ? snap.data() : null);
    return snap;
  } catch (err) {
    console.error('debug_getJournal error:', err);
    throw err;
  }
};
