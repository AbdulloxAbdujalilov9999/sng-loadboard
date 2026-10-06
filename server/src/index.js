import { loadConfig } from './config.js';
import { start } from './start.js';
import { createFirebaseVerifier } from './auth.js';
import { createGeminiParser } from './lib/ai/gemini.js';

try {
  const config = loadConfig();
  const ai = config.geminiApiKey ? createGeminiParser({ apiKey: config.geminiApiKey, model: config.geminiModel }) : null;
  if (!ai) console.warn('GEMINI_API_KEY is not set: "paste loads with AI" is disabled.');
  await start({ config, verifyToken: createFirebaseVerifier({ projectId: config.firebaseProjectId }), ai });
} catch (err) {
  console.error('Failed to start:', err.message);
  process.exit(1);
}
