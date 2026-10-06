import { loadConfig } from './config.js';
import { start } from './start.js';
import { createFirebaseVerifier } from './auth.js';

try {
  const config = loadConfig();
  await start({ config, verifyToken: createFirebaseVerifier({ projectId: config.firebaseProjectId }) });
} catch (err) {
  console.error('Failed to start:', err.message);
  process.exit(1);
}
