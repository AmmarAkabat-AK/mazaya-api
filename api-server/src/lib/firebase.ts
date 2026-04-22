import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

let _db: Firestore;

export function getFirebaseDb(): Firestore {
  if (_db) return _db;

  if (!getApps().length) {
    let serviceAccount: object;

    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw && raw.startsWith("{")) {
      serviceAccount = JSON.parse(raw);
    } else {
      const cwd = process.cwd();
      const candidates = [
        resolve(cwd, "service-account.json"),
        resolve(cwd, "artifacts/api-server/service-account.json"),
      ];
      const found = candidates.find((p) => existsSync(p));
      if (!found) {
        throw new Error(
          `Firebase: service-account.json not found. Tried: ${candidates.join(", ")}. Set FIREBASE_SERVICE_ACCOUNT env var instead.`
        );
      }
      serviceAccount = JSON.parse(readFileSync(found, "utf-8"));
    }

    initializeApp({ credential: cert(serviceAccount as any) });
  }

  _db = getFirestore();
  return _db;
}
