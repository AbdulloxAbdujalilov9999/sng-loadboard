import { loadConfig } from './config.js';
import { start } from './start.js';
import { createFirebaseVerifier } from './auth.js';
import { createGeminiParser } from './lib/ai/gemini.js';
import { createHeuristicParser } from './lib/ai/heuristic.js';

try {
  const config = loadConfig();
  let ai = null;
  if (config.geminiApiKey) ai = createGeminiParser({ apiKey: config.geminiApiKey, model: config.geminiModel });
  else if (config.aiFallback) { ai = createHeuristicParser(); console.warn('GEMINI_API_KEY is not set: "paste loads" runs in BASIC mode (rule-based reader). Set the key for full AI.'); }
  else console.warn('GEMINI_API_KEY is not set: "paste loads" is disabled.');
  await start({ config, verifyToken: createFirebaseVerifier({ projectId: config.firebaseProjectId }), ai });
} catch (err) {
  console.error('Failed to start:', err.message);
  process.exit(1);
}
