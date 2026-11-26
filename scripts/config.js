/**
 * File      : scripts/config.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Reads local settings from .env, so no path or address is hard-coded.
 * n8n node  : None. Shared by the developer tools: npm run verify, npm run e2e
 * Flow      : environment + .env -> [config] -> scripts/verify.js, scripts/e2e.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// .env is optional. Variables already set in the real environment are not overwritten.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const read = (name, fallback = '') => (process.env[name] || '').trim() || fallback;

// "~" is the user's home folder. Relative paths start at the project root.
// An empty value stays empty.
function resolvePath(value) {
  if (!value) return '';
  const expanded = /^~(?=$|[\\/])/.test(value) ? path.join(os.homedir(), value.slice(1)) : value;
  return path.resolve(ROOT, expanded);
}

module.exports = {
  ROOT,
  resolvePath,
  baseUrl: read('N8N_BASE_URL', 'http://localhost:5678'),
  webhookPath: read('WEBHOOK_PATH', 'verify-statement'),
  sampleDir: resolvePath(read('SAMPLE_DIR', 'sample-data')),
  statementFile: resolvePath(read('STATEMENT_FILE')),
  accountHolder: read('ACCOUNT_HOLDER'),
  asOfDate: read('AS_OF_DATE'),
  aiReview: read('AI_REVIEW', 'false').toLowerCase() === 'true',
  authHeaderName: read('WEBHOOK_AUTH_HEADER_NAME'),
  authHeaderValue: read('WEBHOOK_AUTH_HEADER_VALUE'),
};
