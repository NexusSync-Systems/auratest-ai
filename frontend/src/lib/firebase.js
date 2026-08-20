import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

// Konfigurace jde z env, aby šlo oddělit dev / staging / produkci.
// Fallback na dosavadní hodnoty zachovává chování bez .env souboru.
// (Firebase Web apiKey není tajemství — přístup hlídají firestore.rules.)
const firebaseConfig = {
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'auratest-ai-86058',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:402356334321:web:9f051942fd09f9c1e44350',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'auratest-ai-86058.firebasestorage.app',
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyB1bi6iSVzYq4-9ky9nZZ_UbjhOU8iGu54',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'auratest-ai-86058.firebaseapp.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '402356334321',
};

export const firebaseApp = initializeApp(firebaseConfig);
export const firebaseAuth = getAuth(firebaseApp);
export const firebaseDb = getFirestore(firebaseApp);
