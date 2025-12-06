// firebase-init.js (type="module")
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import {
  getFirestore,
  enableIndexedDbPersistence,
  doc,
  getDoc,
  setDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut, linkWithPopup } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";

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
enableIndexedDbPersistence(db).catch((err) => {
  console.warn('No se pudo habilitar persistence (IndexedDB):', err);
});

// Iniciar sesión anónima por defecto. Cambia esto si prefieres email/Google sign-in.
// Hacemos un intento con logs y reintentos cortos para diagnosticar problemas de auth.
async function tryAnonymousSignIn(retries = 2) {
  try {
    console.log('Intentando signInAnonymously()...');
    await signInAnonymously(auth);
    console.log('Llamado signInAnonymously() correctamente. Esperando onAuthStateChanged...');
  } catch (err) {
    console.error('SignIn error (intentando anon):', err);
    if (retries > 0) {
      console.log('Reintentando signInAnonymously en 1s, intentos restantes=', retries - 1);
      setTimeout(() => tryAnonymousSignIn(retries - 1), 1000);
    }
  }
}
tryAnonymousSignIn();

// Exponer helper para forzar sign-in anónimo desde la consola (útil para depuración)
window.ensureAnonymousSignIn = async function() {
  try {
    console.log('ensureAnonymousSignIn: iniciando...');
    const res = await signInAnonymously(auth);
    console.log('ensureAnonymousSignIn: éxito', res);
    return res;
  } catch (err) {
    console.error('ensureAnonymousSignIn: error', err);
    throw err;
  }
};

// Exponer `db`, `auth` y `uid` en `window` para usar desde `app.js` sin convertirlo a módulo
window._firebase = { db, auth, uid: null };

// Wrappers para usar las funciones Firestore desde scripts no modulares
window.firebaseFirestoreDoc = (...args) => doc(...args);
window.firebaseFirestoreGetDoc = (ref) => getDoc(ref);
window.firebaseFirestoreSetDoc = (ref, data) => setDoc(ref, data);
window.firebaseFirestoreUpdateDoc = (ref, data) => updateDoc(ref, data);

onAuthStateChanged(auth, user => {
  window._firebase.uid = user ? user.uid : null;
  window.dispatchEvent(new Event('firebase-auth-ready'));
  // Intentar asegurar que Firestore esté en modo online cuando la auth esté lista
  (async () => {
    try {
      if (window._firebase && window._firebase.db) {
        // enableNetwork es importado dinámicamente para evitar dependencias de carga
        const mod = await import('https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js');
        await mod.enableNetwork(window._firebase.db);
        console.log('firebase-init: enableNetwork() ejecutado tras auth ready');
      }
    } catch (err) {
      console.warn('firebase-init: no se pudo enableNetwork tras auth:', err);
    }
  })();
});

// Helper para forzar que Firestore esté online desde la consola
window.ensureFirestoreOnline = async function() {
  try {
    if (!window._firebase || !window._firebase.db) throw new Error('Firestore no inicializado');
    const mod = await import('https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js');
    await mod.enableNetwork(window._firebase.db);
    console.log('ensureFirestoreOnline: enableNetwork OK');
  } catch (err) {
    console.error('ensureFirestoreOnline error:', err);
    throw err;
  }
};

// Google Auth helpers (expuestos en window)
const googleProvider = new GoogleAuthProvider();

window.signInWithGoogle = async function() {
  try {
    const a = window._firebase.auth;
    if (!a) throw new Error('Auth no inicializado');
    // Si el usuario actual es anónimo, linkear para conservar UID y datos
    if (a.currentUser && a.currentUser.isAnonymous) {
      await linkWithPopup(a.currentUser, googleProvider);
      console.log('Cuenta anónima enlazada con Google. uid:', a.currentUser.uid);
    } else {
      await signInWithPopup(a, googleProvider);
      console.log('Inicio de sesión con Google completado. uid:', a.currentUser.uid);
    }
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
