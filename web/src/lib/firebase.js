import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getStorage, connectStorageEmulator } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyBLburpurwFWCCkX0ByxtFyEWaGoN2gEw8",
  authDomain: "holdpay-f920a.firebaseapp.com",
  projectId: "holdpay-f920a",
  storageBucket: "holdpay-f920a.firebasestorage.app",
  messagingSenderId: "1033116225900",
  appId: "1:1033116225900:web:450a607a71b5536e022349",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

// Point at local emulators during development. Set VITE_USE_EMULATORS=false
// in a .env file (or just delete this block) once you deploy for real.
if (import.meta.env.DEV) {
  connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "localhost", 8080);
  connectStorageEmulator(storage, "localhost", 9199);
}

// Base URL for calling your Cloud Functions HTTPS endpoints.
// NOTE: this previously pointed at "holdpay-dev" in production while
// firebaseConfig.projectId above is "holdpay-f920a" — a real mismatch that
// would have 404'd every function call once deployed. Fixed to match.
export const FUNCTIONS_BASE_URL = import.meta.env.DEV
  ? "http://localhost:5001/holdpay-f920a/us-central1"
  : "https://us-central1-holdpay-f920a.cloudfunctions.net";