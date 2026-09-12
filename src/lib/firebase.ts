import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, doc, getDocFromServer, deleteDoc } from 'firebase/firestore';
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  sendPasswordResetEmail,
  signOut as fbSignOut,
  onAuthStateChanged,
  type User as FirebaseUser
} from 'firebase/auth';
import config from '../../firebase-applet-config.json';

const firebaseConfig = {
  apiKey: config.apiKey,
  authDomain: config.authDomain,
  projectId: config.projectId,
  storageBucket: config.storageBucket,
  messagingSenderId: config.messagingSenderId,
  appId: config.appId,
};

export const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
export const db = config.firestoreDatabaseId
  ? getFirestore(app, config.firestoreDatabaseId)
  : getFirestore(app);
export const auth = getAuth(app);
export const googleAuthProvider = new GoogleAuthProvider();

export async function loginWithFirebaseEmail(email: string, password: string): Promise<FirebaseUser> {
  const userCredential = await signInWithEmailAndPassword(auth, email, password);
  return userCredential.user;
}

export async function registerWithFirebaseEmail(email: string, password: string): Promise<FirebaseUser> {
  const userCredential = await createUserWithEmailAndPassword(auth, email, password);
  return userCredential.user;
}

export async function requestFirebasePasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email.trim());
}

export async function loginWithFirebaseGoogle(): Promise<FirebaseUser> {
  const userCredential = await signInWithPopup(auth, googleAuthProvider);
  return userCredential.user;
}

export async function logoutFirebase(): Promise<void> {
  await fbSignOut(auth);
}

// Connection check with server
export async function testFirestoreConnection(): Promise<boolean> {
  try {
    // Attempt to probe root connection
    await getDocFromServer(doc(db, '_connection_test', 'probe'));
    return true;
  } catch (error: any) {
    if (error?.message?.includes('the client is offline')) {
      console.warn('Firestore: Client appears offline, check network connectivity.');
      return false;
    }
    // Any permission-denied or document-not-found means connection to server succeeded!
    return true;
  }
}

// Remove project document from Firestore if synced
export async function deleteFirestoreProjectDoc(projectId: string): Promise<void> {
  try {
    const projectRef = doc(db, 'projects', projectId);
    await deleteDoc(projectRef);
  } catch (error: any) {
    // Non-blocking fallback for offline/unauthenticated
    console.debug('Firestore project delete notice:', error?.message);
  }
}

