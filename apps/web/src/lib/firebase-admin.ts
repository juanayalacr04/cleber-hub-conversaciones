import { initializeApp, getApps, cert, App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Firestore } from "firebase-admin/firestore";

let app: App;
let adminDb: Firestore;

const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

if (getApps().length === 0) {
  // In development/local, use application default credentials
  // In production (Vercel), use service account from env var
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    app = initializeApp({
      credential: cert(serviceAccount),
      projectId,
    });
  } else {
    // Use application default credentials (for local dev with gcloud auth)
    app = initializeApp({
      projectId,
    });
  }
} else {
  app = getApps()[0];
}

adminDb = getFirestore(app);

export const adminAuth = getAuth(app);
export { adminDb };
