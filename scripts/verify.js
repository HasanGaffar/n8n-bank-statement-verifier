/**
 * File      : scripts/verify.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Sends one statement to the running n8n and prints a short result.
 * n8n node  : None. Developer tool: npm run verify -- [file] [--json]
 * Flow      : .env / argument -> [verify] -> POST /webhook/verify-statement
 */
// Exit code 0 means the statement was processed, not that it passed: read the verdict.
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Sends one request. `file` is a path, or null to send no file. Throws an Error
// with a readable message unless the reply is JSON with a boolean "success".
async function send(file, fields) {
  const form = new FormData();
  if (file) form.set('statement', new Blob([fs.readFileSync(file)]), path.basename(file));
  for (const [name, value] of Object.entries(fields)) if (value) form.set(name, value);

  const { authHeaderName, authHeaderValue } = config;
  if (Boolean(authHeaderName) !== Boolean(authHeaderValue)) {
    throw new Error('Set both WEBHOOK_AUTH_HEADER_NAME and WEBHOOK_AUTH_HEADER_VALUE, or neither.');
  }
  let headers;
  try {
    headers = new Headers(authHeaderName ? { [authHeaderName]: authHeaderValue } : {});
  } catch {
    // The original error text is not printed, because it can contain the secret value.
    throw new Error('WEBHOOK_AUTH_HEADER_NAME or WEBHOOK_AUTH_HEADER_VALUE is not a valid HTTP header.');
  }
  const url = `${config.baseUrl.replace(/\/+$/, '')}/webhook/${config.webhookPath.replace(/^\/+/, '')}`;

  let status;
  let text;
  try {
    const response = await fetch(url, {
      method: 'POST',
      body: form,
      headers,
      redirect: 'error', // never forward a statement or the secret header to another address
      signal: AbortSignal.timeout(300000),
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'timed out' : error.cause?.code || error.cause?.message || 'request failed';
    const failure = new Error(`No reply from ${url} (${reason}). Check that n8n is running and N8N_BASE_URL is correct.`);
    failure.unreachable = true;
    throw failure;
  }

  if (!text.trim()) throw new Error(`HTTP ${status} with an empty response. Treat this as a failure.`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${status} with a response that is not JSON. Treat this as a failure.`);
  }
  if (typeof json?.success !== 'boolean') {
    const hint = status === 404 ? ' Check that the workflow is active and WEBHOOK_PATH is correct.' : '';
    throw new Error(`HTTP ${status} without a boolean "success" field. Treat this as a failure.${hint}`);
  }
  return { status, json, text };
}

function summary(status, body) {
  const lines = [`HTTP status     : ${status}`];
  if (body.success) {
    lines.push(`Verdict         : ${body.result?.verdict}`, `accountsCorrect : ${body.result?.accountsCorrect}`);
    if (body.result?.headline) lines.push(`Headline        : ${body.result.headline}`);
    lines.push(`Faults          : ${body.faultCount}`);
    for (const fault of body.faults || []) lines.push(`  row ${fault.row}: ${fault.cause}`);
    const hidden = body.faultCount - (body.faults || []).length;
    if (hidden > 0) lines.push(`  ... and ${hidden} more (use --json for the response)`);
  } else {
    lines.push(`Error           : ${body.error?.code}`, `Message         : ${body.error?.message}`);
    if (body.reference) lines.push(`Reference       : ${body.reference}`);
  }
  if (body.processing) lines.push(`durationMs      : ${body.processing.durationMs}`);
  const ai = body.aiReview;
  if (ai?.requested) {
    lines.push(`AI review       : ${ai.status}`);
    if (ai.routing) lines.push(`AI route        : ${ai.routing.tier}`);
    if (ai.usage) lines.push(`AI tokens       : ${ai.usage.inputTokens} input, ${ai.usage.outputTokens} output`);
  }
  lines.push(`Audit rowId     : ${body.audit?.rowId ?? 'none'}`);
  return lines.join('\n');
}

async function main(args) {
  const asJson = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  if (rest.length > 1 || rest[0]?.startsWith('--')) {
    throw new Error('Usage: npm run verify -- [file] [--json]. Put quotes around a path that contains spaces.');
  }
  const file = rest[0] ? config.resolvePath(rest[0]) : config.statementFile;
  if (!file) throw new Error('No statement file. Give one (npm run verify -- <file>) or set STATEMENT_FILE in .env.');
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Statement file not found: ${file}\nRelative paths start at the project folder.`);
  }
  const { status, json, text } = await send(file, {
    account_holder: config.accountHolder,
    as_of_date: config.asOfDate,
    ai_review: String(config.aiReview),
  });
  console.log(asJson ? text : summary(status, json));
  if (status !== 200 || !json.success) process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { send };
