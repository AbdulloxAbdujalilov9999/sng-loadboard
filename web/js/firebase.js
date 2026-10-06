// Firebase Auth only (Google sign-in). All data lives in PostgreSQL behind the API; the browser sends the
// Firebase ID token and the server verifies it. Module script => deferred, so session.js waits for the event.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

const app = initializeApp(window.APP_CONFIG.firebase);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

window.FirebaseAuth = {
  onChange: (cb) => onAuthStateChanged(auth, cb),
  async signIn() { return (await signInWithPopup(auth, provider)).user; },
  signOut: () => signOut(auth),
  /** ID token for the API; getIdToken() refreshes it automatically when it is about to expire. */
  getToken: (force = false) => (auth.currentUser ? auth.currentUser.getIdToken(force) : Promise.resolve(null)),
};
window.dispatchEvent(new Event('firebase-ready'));
