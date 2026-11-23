import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getStorage, type FirebaseStorage } from "firebase/storage";

/**
 * Firebase del cliente: SOLO lo usan las pantallas de Ventas y Servicio que todavía leen Firestore (se mudan a
 * hub_cleber en su fase). Valuación, el login y la sesión ya no dependen de Firebase.
 *
 * Sin NEXT_PUBLIC_FIREBASE_API_KEY no se inicializa nada: importar este módulo no falla (antes getAuth lanzaba
 * auth/invalid-api-key y tiraba toda la app), y `auth`, `db` y `storage` quedan en null. Ventas y Servicio no se
 * muestran mientras tanto (lib/modules.ts).
 */
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const firebaseConfigurado = !!firebaseConfig.apiKey && !!firebaseConfig.projectId;

const app: FirebaseApp | null = firebaseConfigurado ? (getApps().length ? getApp() : initializeApp(firebaseConfig)) : null;

// Tipados como no nulos para no tocar las pantallas de Ventas y Servicio que los usan; solo se usan si firebaseConfigurado.
export const auth = (app ? getAuth(app) : null) as Auth;
export const db = (app ? getFirestore(app, process.env.NEXT_PUBLIC_FIRESTORE_DATABASE || "(default)") : null) as Firestore;
export const storage = (app ? getStorage(app) : null) as FirebaseStorage;
