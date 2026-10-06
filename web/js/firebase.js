// Firebase Auth only: Google, e-mail + password, and phone (SMS code). All data lives in PostgreSQL behind the
// API; the browser sends the Firebase ID token and the server verifies it. Module script => deferred, so
// session.js waits for the 'firebase-ready' event.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification,
  RecaptchaVerifier, signInWithPhoneNumber, EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

const app = initializeApp(window.APP_CONFIG.firebase);
const auth = getAuth(app);
const google = new GoogleAuthProvider();
google.setCustomParameters({ prompt: 'select_account' });

/** The small, serialisable view of the Firebase user that the rest of the app works with. */
function view(u) {
  if (!u) return null;
  const providers = u.providerData.map((p) => p.providerId);
  return {
    email: u.email || '',
    phone: u.phoneNumber || '',
    providers,
    hasPassword: providers.includes('password'),
    hasGoogle: providers.includes('google.com'),
    // An e-mail+password account must prove it owns the mailbox before the API will talk to it.
    needsVerification: Boolean(u.email) && !u.emailVerified && !providers.includes('google.com'),
  };
}

let phoneVerifier = null;
let phoneConfirmation = null;
function freshVerifier(buttonId) {
  try { phoneVerifier?.clear(); } catch { /* already cleared */ }
  phoneVerifier = new RecaptchaVerifier(auth, buttonId, { size: 'invisible' });
  return phoneVerifier;
}

const listeners = new Set();
window.FirebaseAuth = {
  onChange: (cb) => { listeners.add(cb); return onAuthStateChanged(auth, (u) => cb(view(u))); },
  info: () => view(auth.currentUser),

  /** E-mails and SMS are sent in the user's language (Firebase picks the matching template). */
  setLanguage: (code) => { auth.languageCode = code; },

  async signInGoogle() { await signInWithPopup(auth, google); },

  async signInEmail(email, password) { await signInWithEmailAndPassword(auth, email, password); },
  async signUpEmail(email, password) {
    const { user } = await createUserWithEmailAndPassword(auth, email, password);
    await sendEmailVerification(user);
  },
  resendVerification: () => sendEmailVerification(auth.currentUser),
  /** Re-reads the account (did they click the link?) and refreshes the token; returns the new view. */
  async reload() {
    await auth.currentUser.reload();
    await auth.currentUser.getIdToken(true);
    const v = view(auth.currentUser);
    listeners.forEach((cb) => cb(v));
    return v;
  },
  sendReset: (email) => sendPasswordResetEmail(auth, email),

  async phoneStart(phone, buttonId) {
    phoneConfirmation = await signInWithPhoneNumber(auth, phone, freshVerifier(buttonId));
  },
  async phoneConfirm(code) {
    if (!phoneConfirmation) throw Object.assign(new Error('no code requested'), { code: 'auth/missing-verification-code' });
    await phoneConfirmation.confirm(code);
    phoneConfirmation = null;
  },
  phoneReset() { phoneConfirmation = null; try { phoneVerifier?.clear(); } catch { /* ignore */ } phoneVerifier = null; },

  /** Change password while signed in: proves the current one first (Firebase requires a recent login). */
  async changePassword(current, next) {
    const user = auth.currentUser;
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, current));
    await updatePassword(user, next);
  },

  signOut: () => signOut(auth),
  /** ID token for the API; getIdToken() refreshes it automatically when it is about to expire. */
  getToken: (force = false) => (auth.currentUser ? auth.currentUser.getIdToken(force) : Promise.resolve(null)),
};
window.dispatchEvent(new Event('firebase-ready'));
