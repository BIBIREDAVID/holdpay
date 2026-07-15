import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";

// Replace with your real Firebase project config once you've created it
// in the Firebase console (Project settings -> General -> Your apps).
const firebaseConfig = {
  apiKey: "AIzaSyBLburpurwFWCCkX0ByxtFyEWaGoN2gEw8",
  authDomain: "holdpay-f920a.firebaseapp.com",
  projectId: "holdpay-f920a",
  storageBucket: "holdpay-f920a.firebasestorage.app",
  messagingSenderId: "1033116225900",
  appId: "1:1033116225900:web:450a607a71b5536e022349"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Point at local emulators during development. Set VITE_USE_EMULATORS=false
// in a .env file (or just delete this block) once you deploy for real.
if (import.meta.env.DEV) {
  connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "localhost", 8080);
}

// Base URL for calling your Cloud Functions HTTPS endpoints
// (monnifyWebhook is Monnify-only; releaseFunds is called from here).
export const FUNCTIONS_BASE_URL = import.meta.env.DEV
  ? "http://localhost:5001/holdpay-dev/us-central1"
  : "https://us-central1-holdpay-dev.cloudfunctions.net";