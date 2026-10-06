// Runtime configuration. The Firebase web config is public by design (it identifies the project; access is
// enforced server-side by verifying the ID token). Change apiBase only if the API is hosted on another origin
// (and add this site's origin to the server's CORS_ORIGINS).
window.APP_CONFIG = {
  apiBase: '',
  firebase: {
    apiKey: 'AIzaSyDryrZCdCuYNZrx8PQe83U4x3YL0Ipz3Hg',
    authDomain: 'sng-pro.firebaseapp.com',
    projectId: 'sng-pro',
    storageBucket: 'sng-pro.firebasestorage.app',
    messagingSenderId: '194801948152',
    appId: '1:194801948152:web:f8b39e34b9fc558c11b20d',
  },
  pageSize: 50,          // rows fetched per request
  maxRenderedRows: 600,  // DOM cap per list; beyond this users are asked to refine the search
};
