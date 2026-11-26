/**
 * File      : scripts/build-workflows.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Builds the n8n workflow JSON and the rules document from src/.
 * n8n node  : None. Developer tool: npm run build
 * Flow      : src/*.js -> workflows/bank-statement-verifier.json
 */
// Builds workflows/bank-statement-verifier.json from the tested code in src/,
// and docs/STATEMENT_RULES.md from the checklist. Edit src/, then run:
//   node scripts/build-workflows.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const AUTHOR = 'Hasan Gaffar';
const { SECTIONS } = require('../src/checklist');

// A module without its require/export lines, ready to paste into a Code node.
function moduleSource(name) {
  return fs
    .readFileSync(path.join(ROOT, 'src', `${name}.js`), 'utf8')
    .replace(/^\/\*\*[\s\S]*?\*\/\n/, '') // the file header is replaced by a node header
    .replace(/\/\/ --- imports ---[\s\S]*?\/\/ --- end imports ---\n/, '')
    .split('// --- exports ---')[0]
    .trim();
}

const code = (modules, run) => [...modules.map(moduleSource), `// --- node ---\n${run.trim()}`].join('\n\n');

const stableId = (name) => {
  const h = crypto.createHash('sha1').update(name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const nodes = [];
const connections = {};
function node(name, type, typeVersion, position, parameters, extra = {}) {
  nodes.push({ id: stableId(name), name, type: `n8n-nodes-base.${type}`, typeVersion, position, parameters, ...extra });
  return name;
}
function connect(from, to, output = 0) {
  connections[from] ??= { main: [] };
  while (connections[from].main.length <= output) connections[from].main.push([]);
  connections[from].main[output].push({ node: to, type: 'main', index: 0 });
}
const codeNode = (name, position, jsCode, extra) => node(name, 'code', 2, position, { jsCode }, extra);

const condition = (expression) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{
      id: stableId(expression), leftValue: expression, rightValue: true,
      operator: { type: 'boolean', operation: 'true', singleValue: true },
    }],
    combinator: 'and',
  },
  options: {},
});
const ifNode = (name, position, expression) => node(name, 'if', 2.2, position, condition(expression));

const AUDIT_TABLE = 'statement_audit_log';
const AUDIT_COLUMNS = {
  received_at: 'string', reference: 'string', account_holder: 'string', file_name: 'string', file_type: 'string',
  sha256: 'string', http_status: 'number', success: 'boolean', verdict: 'string', accounts_correct: 'string',
  transaction_count: 'number', fault_count: 'number', discrepancy_ids: 'string', error_code: 'string',
  ai_status: 'string', ai_route: 'string', ai_models: 'string', ai_input_tokens: 'number',
  ai_output_tokens: 'number', ai_cost_usd: 'number', duration_ms: 'number', execution_id: 'string',
  response_json: 'string', transactions_json: 'string',
  error_message: 'string', failed_node: 'string', ai_duration_ms: 'number', ai_errors: 'string',
  ai_usage_json: 'string',
};
const tableByName = { __rl: true, mode: 'name', value: AUDIT_TABLE };

// ---------------------------------------------------------------- intake
node('Receive Statement', 'webhook', 2, [0, 400], {
  httpMethod: 'POST', path: 'verify-statement', responseMode: 'responseNode', options: {},
}, { webhookId: stableId('verify-statement') });

node('Ensure Audit Table', 'dataTable', 1, [220, 400], {
  resource: 'table', operation: 'create', tableName: AUDIT_TABLE,
  columns: { column: Object.entries(AUDIT_COLUMNS).map(([name, type]) => ({ name, type })) },
  options: { createIfNotExists: true },
}, { executeOnce: true });

codeNode('Check Request', [440, 400], code(['util', 'parse', 'request'], `
const webhook = $('Receive Statement').first();
const body = webhook.json.body || {};
const binaries = webhook.binary || {};
const upload = binaries.statement || Object.values(binaries)[0];

// n8n reports sizes as text such as "11.1 kB".
const units = { B: 1, kB: 1000, MB: 1000000, GB: 1000000000 };
const [amount, unit] = String(upload?.fileSize || '0 B').split(' ');
const file = upload ? { fileName: upload.fileName || '', sizeBytes: Number(amount) * (units[unit] || 1) } : null;

const startedAt = new Date().toISOString();
const checked = checkRequest({ body, file, today: startedAt.slice(0, 10) });
const out = { json: { ...checked, startedAt, fileName: file?.fileName || '' } };
if (upload) out.binary = { statement: upload };
return [out];
`));

ifNode('Request OK?', [660, 400], '={{ $json.valid }}');

node('Fingerprint File', 'crypto', 1, [860, 300], {
  action: 'hash', type: 'SHA256', binaryData: true, binaryPropertyName: 'statement',
  dataPropertyName: 'sha256', encoding: 'hex',
});

// The hash node returns only JSON, so the uploaded file is attached again.
codeNode('Reattach File', [1010, 300], `
return [{ json: $input.first().json, binary: $('Check Request').first().binary }];
`);

const typeRule = (value) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{
      id: stableId(`type-${value}`), leftValue: "={{ $('Check Request').first().json.fileType }}",
      rightValue: value, operator: { type: 'string', operation: 'equals' },
    }],
    combinator: 'and',
  },
});
node('File Type', 'switch', 3.2, [1170, 300], {
  rules: { values: [typeRule('csv'), typeRule('xlsx'), typeRule('pdf')] }, options: {},
});

const extract = (name, y, parameters) =>
  node(name, 'extractFromFile', 1, [1340, y], { binaryPropertyName: 'statement', ...parameters },
    { onError: 'continueErrorOutput' });
extract('Extract CSV', 160, { operation: 'csv', options: { headerRow: true, includeEmptyCells: true, enableBOM: true } });
extract('Extract Excel', 300, { operation: 'xlsx', options: { headerRow: true, includeEmptyCells: true, rawData: true } });
extract('Extract PDF', 440, { operation: 'pdf', options: {} });

ifNode('PDF Has Text?', [1560, 440], '={{ ($json.text || "").trim().length >= 50 }}');

// ---------------------------------------------------------------- verification
codeNode('Parse Transactions', [1780, 300], code(['util', 'parse', 'parse-pdf'], `
const MAX_ROWS = 20000;
const fileType = $('Check Request').first().json.fileType;
const items = $input.all();
const fail = (code, message) => [{ json: { ok: false, httpStatus: 422, error: { code, message } } }];
try {
  const parsed = fileType === 'pdf' ? parsePdfText(items[0].json.text) : parseRows(items.map((i) => i.json));
  if (parsed.transactions.length + parsed.rejected.length > MAX_ROWS) {
    return [{ json: { ok: false, httpStatus: 413, error: { code: 'TOO_MANY_ROWS', message: 'More than 20,000 rows.' } } }];
  }
  if (!parsed.transactions.length) return fail('STATEMENT_UNREADABLE', 'No readable transactions in the statement.');
  return [{ json: { ok: true, parsed } }];
} catch (error) {
  const text = String(error.message);
  if (text.startsWith('LAYOUT_NOT_SUPPORTED')) return fail('LAYOUT_NOT_SUPPORTED', text.replace('LAYOUT_NOT_SUPPORTED: ', ''));
  if (text.startsWith('Missing column')) return fail('MISSING_COLUMNS', text);
  return fail('STATEMENT_UNREADABLE', text);
}
`));

ifNode('Parsed OK?', [2000, 300], '={{ $json.ok }}');

codeNode('Check Arithmetic', [2220, 240], code(['util', 'validate'], `
const { parsed } = $input.first().json;
return [{ json: { parsed, validation: validateStatement(parsed) } }];
`));
codeNode('Categorize Transactions', [2440, 240], code(['categorize'], `
const { parsed, validation } = $input.first().json;
return [{ json: { transactions: categorizeAll(parsed.transactions), rejected: parsed.rejected, validation } }];
`));
codeNode('Detect Patterns', [2660, 240], code(['util', 'categorize', 'fraud'], `
const data = $input.first().json;
return [{ json: { ...data, ...detectRisks(data.transactions) } }];
`));
codeNode('Analyse Account', [2880, 240], code(['util', 'analysis'], `
const data = $input.first().json;
return [{ json: { ...data, analysis: analyseAccount(data.transactions) } }];
`));

node('Find Earlier Submissions', 'dataTable', 1, [3100, 240], {
  resource: 'row', operation: 'get', dataTableId: tableByName,
  filters: { conditions: [{ keyName: 'sha256', condition: 'eq', keyValue: "={{ $('Fingerprint File').first().json.sha256 }}" }] },
  returnAll: true,
}, { alwaysOutputData: true, executeOnce: true });

codeNode('Run Checklist', [3320, 240], code(['util', 'validate', 'checklist'], `
const data = $('Analyse Account').first().json;
const request = $('Check Request').first().json;
const sha256 = $('Fingerprint File').first().json.sha256;
const holder = (name) => String(name || '').trim().toLowerCase().replace(/\\s+/g, ' ');
const other = $input.all().map((i) => i.json).find(
  (r) => r.success && holder(r.account_holder) && holder(r.account_holder) !== holder(request.accountHolder));

const intake = {
  reference: request.reference || 'STM-' + request.startedAt.slice(0, 10).replace(/-/g, '') + '-' + sha256.slice(0, 8),
  accountHolder: request.accountHolder,
  asOfDate: request.asOfDate,
  fileName: request.fileName,
  fileType: request.fileType,
  sha256,
};
const sections = runChecklist({
  validation: data.validation, detections: data.detections, transactions: data.transactions,
  asOfDate: intake.asOfDate, accountHolder: intake.accountHolder, duplicateOf: other ? other.reference : null,
});
return [{ json: { ...data, intake, sections } }];
`));

// ---------------------------------------------------------------- AI review with model routing
ifNode('AI Review Requested?', [3540, 240], "={{ $('Check Request').first().json.aiReview }}");

codeNode('Build Haiku Requests', [3760, 80], code(['ai'], `
const data = $('Run Checklist').first().json;
const aiStartedAt = new Date().toISOString();
return buildTriageRequests({
  sections: data.sections, transactions: data.transactions, faults: data.validation.mismatches,
}).map((r) => ({ json: { ...r, aiStartedAt } }));
`));

const claude = (name, position, beta) =>
  node(name, 'httpRequest', 4.2, position, {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'anthropicApi',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'anthropic-version', value: '2026-10-21' },
        ...(beta ? [{ name: 'anthropic-beta', value: beta }] : []),
      ],
    },
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.request) }}',
    options: { timeout: 120000 },
  }, { onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 });

claude('Ask Claude Haiku', [3980, 80]);

codeNode('Route Models', [4200, 80], code(['util', 'validate', 'checklist', 'assemble', 'ai'], `
const data = $('Run Checklist').first().json;
const verdict = decide(data.validation, summarizeChecklist(data.sections).discrepancies).verdict;
const { route, triage, requests } = routeAfterTriage({
  sections: data.sections, transactions: data.transactions, faults: data.validation.mismatches, verdict,
  faultCount: data.validation.mismatches.length, unmatchedSummary: Boolean(data.validation.unmatchedSummary),
  triageKeys: $('Build Haiku Requests').all().map((i) => i.json.sectionKey),
  triageReplies: $input.all().map((i) => i.json),
});
if (!requests.length) return [{ json: { escalate: false, route, triage } }];
return requests.map((r) => ({ json: { escalate: true, route, triage, ...r } }));
`));

ifNode('Escalate?', [4420, 80], '={{ $json.escalate }}');
claude('Ask Escalation Model', [4640, 0], 'server-side-fallback-2026-07-01');

codeNode('Merge AI Review', [4860, 80], code(['ai'], `
const data = $('Run Checklist').first().json;
const { route, triage } = $('Route Models').first().json;
const escalationReplies = $('Ask Escalation Model').isExecuted && route.model
  ? $('Ask Escalation Model').all().map((i) => i.json) : [];
const merged = mergeAiReview({ sections: data.sections, route, triage, escalationReplies });
merged.aiReview.durationMs = Date.now() - Date.parse($('Build Haiku Requests').first().json.aiStartedAt);
return [{ json: merged }];
`));

codeNode('Assemble Response', [5080, 240], code(['util', 'validate', 'checklist', 'assemble'], `
const data = $('Run Checklist').first().json;
const ai = $('Merge AI Review').isExecuted ? $('Merge AI Review').first().json : null;
const response = assembleResponse({
  intake: data.intake, validation: data.validation, analysis: data.analysis,
  sections: ai ? ai.sections : data.sections, rejected: data.rejected,
  aiReview: ai ? ai.aiReview : undefined,
});
return [{ json: { httpStatus: 200, response, transactions: data.transactions } }];
`));

// ---------------------------------------------------------------- errors, audit log, response
codeNode('Build Error Response', [2220, 720], `
const request = $('Check Request').first().json;
const item = $input.first().json;
const from = $prevNode.name;
let httpStatus;
let error;
let failedNode = '';
let errorDetail = '';
if (!request.valid) ({ httpStatus, error } = request);
else if (item.httpStatus && item.error?.code) ({ httpStatus, error } = item);
else if (from === 'PDF Has Text?') {
  httpStatus = 422;
  error = { code: 'OCR_REQUIRED', message: 'The PDF has no readable text (scanned image). OCR is not included.' };
} else if (from.startsWith('Extract ')) {
  httpStatus = 422;
  error = { code: 'STATEMENT_UNREADABLE', message: 'The file could not be read. It may be damaged or password protected.' };
  errorDetail = String(item.error?.message || item.error || '').slice(0, 1000);
} else {
  // A processing node crashed. The caller gets no internal detail; the audit log does.
  httpStatus = 500;
  error = { code: 'UNEXPECTED_ERROR', message: 'Processing failed unexpectedly. Quote the reference to find it in the audit log.' };
  failedNode = from;
  errorDetail = String(item.error?.message || item.error || 'Unknown error').slice(0, 1000);
}
const reference = request.reference || 'REQ-' + $execution.id;
return [{ json: { httpStatus, response: { success: false, reference, error }, failedNode, errorDetail } }];
`);

codeNode('Prepare Audit Record', [5300, 400], `
const { httpStatus, response, transactions, failedNode, errorDetail } = $input.first().json;
const request = $('Check Request').first().json;
const sha256 = $('Fingerprint File').isExecuted ? $('Fingerprint File').first().json.sha256 : '';
const ai = response.aiReview;
const correct = response.result?.accountsCorrect;
const durationMs = Date.now() - Date.parse(request.startedAt);
response.processing = { ...(response.processing || {}), durationMs };
const stages = ai?.routing?.stages || [];
return [{ json: {
  received_at: request.startedAt,
  reference: response.reference || '',
  account_holder: request.accountHolder || '',
  file_name: request.fileName || '',
  file_type: request.fileType || '',
  sha256,
  http_status: httpStatus,
  success: response.success,
  verdict: response.result?.verdict || '',
  accounts_correct: correct === true ? 'true' : correct === false ? 'false' : 'unknown',
  transaction_count: response.statement?.transactionCount || 0,
  fault_count: response.faultCount || 0,
  discrepancy_ids: (response.verification?.discrepancies || []).map((d) => d.sn).join(','),
  error_code: response.error?.code || '',
  ai_status: ai?.status || '',
  ai_route: ai?.routing?.tier || '',
  ai_models: [...new Set((ai?.routing?.stages || []).flatMap((s) => s.servedModels))].join(','),
  ai_input_tokens: ai?.usage?.inputTokens || 0,
  ai_output_tokens: ai?.usage?.outputTokens || 0,
  ai_cost_usd: ai?.usage?.estimatedCostUsd || 0,
  duration_ms: durationMs,
  execution_id: String($execution.id),
  response_json: JSON.stringify(response),
  transactions_json: JSON.stringify(transactions || []),
  error_message: errorDetail || response.error?.message || '',
  failed_node: failedNode || '',
  ai_duration_ms: ai?.durationMs || 0,
  ai_errors: stages.flatMap((s) => s.failed.map(
    (f) => 'stage ' + s.stage + ' ' + s.requestedModel + ' section ' + f.section + ': ' + f.why))
    .join(' | ').slice(0, 2000),
  ai_usage_json: JSON.stringify(stages),
} }];
`);

// If this insert fails the request fails: no result leaves without a record.
node('Save Audit Log', 'dataTable', 1, [5520, 400], {
  resource: 'row', operation: 'insert', dataTableId: tableByName,
  columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] }, options: {},
});

node('Send Response', 'respondToWebhook', 1.1, [5740, 400], {
  respondWith: 'json',
  responseBody: `={{ JSON.stringify(Object.assign(JSON.parse($('Prepare Audit Record').first().json.response_json), { audit: { table: '${AUDIT_TABLE}', rowId: $json.id, loggedAt: $json.createdAt } })) }}`,
  options: { responseCode: "={{ $('Prepare Audit Record').first().json.http_status }}" },
});

connect('Receive Statement', 'Ensure Audit Table');
connect('Ensure Audit Table', 'Check Request');
connect('Check Request', 'Request OK?');
connect('Request OK?', 'Fingerprint File', 0);
connect('Request OK?', 'Build Error Response', 1);
connect('Fingerprint File', 'Reattach File');
connect('Reattach File', 'File Type');
['Extract CSV', 'Extract Excel', 'Extract PDF'].forEach((name, i) => {
  connect('File Type', name, i);
  connect(name, name === 'Extract PDF' ? 'PDF Has Text?' : 'Parse Transactions', 0);
  connect(name, 'Build Error Response', 1);
});
connect('PDF Has Text?', 'Parse Transactions', 0);
connect('PDF Has Text?', 'Build Error Response', 1);
connect('Parse Transactions', 'Parsed OK?');
connect('Parsed OK?', 'Check Arithmetic', 0);
connect('Parsed OK?', 'Build Error Response', 1);
['Check Arithmetic', 'Categorize Transactions', 'Detect Patterns', 'Analyse Account', 'Find Earlier Submissions',
  'Run Checklist', 'AI Review Requested?'].reduce((from, to) => (connect(from, to), to));
connect('AI Review Requested?', 'Build Haiku Requests', 0);
connect('AI Review Requested?', 'Assemble Response', 1);
['Build Haiku Requests', 'Ask Claude Haiku', 'Route Models', 'Escalate?'].reduce((from, to) => (connect(from, to), to));
connect('Escalate?', 'Ask Escalation Model', 0);
connect('Escalate?', 'Merge AI Review', 1);
connect('Ask Escalation Model', 'Merge AI Review');
connect('Merge AI Review', 'Assemble Response');
connect('Assemble Response', 'Prepare Audit Record');
connect('Build Error Response', 'Prepare Audit Record');
connect('Prepare Audit Record', 'Save Audit Log');
connect('Save Audit Log', 'Send Response');

// ---------------------------------------------------------------- guarded nodes
// Without this, a crash can leave the caller with an empty HTTP 200.
const GUARDED = [
  'Fingerprint File', 'Reattach File', 'Parse Transactions', 'Check Arithmetic', 'Categorize Transactions',
  'Detect Patterns', 'Analyse Account', 'Find Earlier Submissions', 'Run Checklist', 'Build Haiku Requests',
  'Route Models', 'Merge AI Review', 'Assemble Response',
];
for (const name of GUARDED) {
  nodes.find((n) => n.name === name).onError = 'continueErrorOutput';
  connect(name, 'Build Error Response', 1);
}

// No result leaves without a record. If the audit table cannot be prepared or written,
// the caller gets HTTP 500, then the run is stopped with an error so that the
// safety net below still tries to record what happened.
node('Audit Unavailable Response', 'respondToWebhook', 1.1, [5740, 600], {
  respondWith: 'json',
  responseBody: "={{ JSON.stringify({ success: false, reference: 'REQ-' + $execution.id, error: { code: 'AUDIT_UNAVAILABLE', message: 'The audit record could not be saved, so no result is returned.' } }) }}",
  options: { responseCode: 500 },
});
node('Stop With Audit Error', 'stopAndError', 1, [5960, 600], {
  errorMessage: 'The audit record could not be prepared or saved.',
});
for (const name of ['Ensure Audit Table', 'Prepare Audit Record', 'Save Audit Log']) {
  nodes.find((n) => n.name === name).onError = 'continueErrorOutput';
  connect(name, 'Audit Unavailable Response', 1);
}
connect('Audit Unavailable Response', 'Stop With Audit Error');

// A guarded node has a success output (0) and an error output. A reference without
// an output number can read the empty error output, so every reference says 0.
const guardedNames = [...GUARDED, 'Ensure Audit Table', 'Prepare Audit Record', 'Save Audit Log'];
const readSuccessOutput = (value) => {
  if (typeof value === 'string') {
    return guardedNames.reduce((text, name) => text
      .split(`$('${name}').first()`).join(`$('${name}').first(0)`)
      .split(`$('${name}').all()`).join(`$('${name}').all(0)`), value);
  }
  if (Array.isArray(value)) return value.map(readSuccessOutput);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, readSuccessOutput(item)]));
  }
  return value;
};
for (const n of nodes) n.parameters = readSuccessOutput(n.parameters);

// ---------------------------------------------------------------- unexpected failures
// n8n runs this branch when any node above fails unexpectedly in a published
// execution: a workflow with an Error Trigger is its own error workflow.
node('On Unexpected Error', 'errorTrigger', 1, [4420, 760], {});
node('Ensure Audit Table For Error', 'dataTable', 1, [4640, 760], {
  resource: 'table', operation: 'create', tableName: AUDIT_TABLE,
  columns: { column: Object.entries(AUDIT_COLUMNS).map(([name, type]) => ({ name, type })) },
  options: { createIfNotExists: true },
}, { executeOnce: true });
codeNode('Prepare Error Record', [4860, 760], `
const failure = $('On Unexpected Error').first().json;
const execution = failure.execution || {};
const message = String(execution.error?.message || failure.trigger?.error?.message || 'Unknown error').slice(0, 1000);
const executionId = String(execution.id || '');
const reference = 'ERR-' + (executionId || Date.now());
return [{ json: {
  received_at: new Date().toISOString(),
  reference,
  account_holder: '', file_name: '', file_type: '', sha256: '',
  http_status: 500,
  success: false,
  verdict: '', accounts_correct: 'unknown', transaction_count: 0, fault_count: 0, discrepancy_ids: '',
  error_code: 'UNEXPECTED_ERROR',
  ai_status: '', ai_route: '', ai_models: '', ai_input_tokens: 0, ai_output_tokens: 0, ai_cost_usd: 0,
  duration_ms: 0,
  execution_id: executionId,
  response_json: JSON.stringify({ success: false, reference, error: { code: 'UNEXPECTED_ERROR', message } }),
  transactions_json: '[]',
  error_message: message,
  failed_node: execution.lastNodeExecuted || '',
  ai_duration_ms: 0, ai_errors: '', ai_usage_json: '[]',
} }];
`);
node('Save Error Record', 'dataTable', 1, [5080, 760], {
  resource: 'row', operation: 'insert', dataTableId: tableByName,
  columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] }, options: {},
});
connect('On Unexpected Error', 'Ensure Audit Table For Error');
connect('Ensure Audit Table For Error', 'Prepare Error Record');
connect('Prepare Error Record', 'Save Error Record');

// ---------------------------------------------------------------- canvas notes
const ruleLines = (section) =>
  section.items.map((i) => `- **${i.sn}** ${i.parameter} _(${i.severity})_`).join('\n');
const note = (name, position, width, height, content) =>
  node(name, 'stickyNote', 1, position, { content, width, height });
note('Note API', [0, 0], 640, 320,
  '## Bank Statement Verification API\n`POST /webhook/verify-statement` (multipart)\n\n' +
  '`statement` file (csv, xlsx, text PDF), required\n`account_holder`, `reference`, `as_of_date`, `ai_review=true` optional\n\n' +
  'Question answered: **do the accounts add up, and if not, where and why?**\n\n' +
  `Every handled request, including errors, is saved in the Data Table **${AUDIT_TABLE}** before the response is sent, ` +
  'with response time, token usage and cost. Unexpected node failures are recorded too.');
note('Note Rules AB', [0, 900], 560, 500,
  `## Statement checker rules\nHIGH = fault, MEDIUM = review, LOW = information\n\n### A. ${SECTIONS[0].name}\n${ruleLines(SECTIONS[0])}\n\n### B. ${SECTIONS[1].name}\n${ruleLines(SECTIONS[1])}`);
note('Note Rules CD', [580, 900], 560, 500,
  `### C. ${SECTIONS[2].name}\n${ruleLines(SECTIONS[2])}\n\n### D. ${SECTIONS[3].name}\n${ruleLines(SECTIONS[3])}`);
note('Note Rules E', [1160, 900], 560, 500,
  `### E. ${SECTIONS[4].name}\n${ruleLines(SECTIONS[4])}\n\n### Verdict\n- **INCONCLUSIVE** statement not read reliably\n- **FAULTS_FOUND** any HIGH discrepancy\n- **REVIEW_REQUIRED** any MEDIUM discrepancy\n- **VERIFIED** otherwise\n\nFull wording: docs/STATEMENT_RULES.md`);
note('Note Routing', [3740, -300], 880, 260,
  '## AI model routing (optional, advisory only)\n1. **Haiku** reviews every section.\n2. **Sonnet** re-checks sections with HIGH/MEDIUM issues, Haiku concerns or Haiku failures.\n3. **Opus** is used instead when there are 3+ balance faults, unexplained summary figures, or an unreadable statement.\n\nAI never changes a check, a figure or the verdict. Select your **Anthropic** credential on both Claude nodes.');

note('Note Author', [660, 0], 360, 120, `### n8n Bank Statement Verifier\n**Author:** ${AUTHOR}`);

// Every Code node starts with a header saying who wrote it and where its data
// comes from and goes. The flow lines come from the real connections.
for (const n of nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
  const from = Object.keys(connections).filter((s) => connections[s].main.flat().some((c) => c.node === n.name));
  const to = (connections[n.name]?.main || []).flat().map((c) => c.node);
  n.parameters.jsCode = [
    '/**',
    ` * n8n node  : ${n.name}`,
    ` * Author    : ${AUTHOR}`,
    ' * Project   : n8n Bank Statement Verifier',
    ` * Input from: ${from.join(', ')}`,
    ` * Output to : ${to.join(', ')}`,
    ' * Source    : generated from src/ by scripts/build-workflows.js',
    ' */',
    n.parameters.jsCode,
  ].join('\n');
}

const workflow = {
  name: 'Bank Statement Verifier',
  nodes,
  connections,
  settings: {
    executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all',
    saveManualExecutions: true, saveExecutionProgress: true,
  },
  pinData: {},
};

function rulesDocument() {
  const lines = [
    '# Statement checker rules', '',
    `**Author:** ${AUTHOR}`, '',
    'Generated from `src/checklist.js` by `npm run build`. These rules are an illustrative verification policy, not a regulatory standard.', '',
    'Each check ends as **OK**, **DISCREPANCY** or **NA** (not applicable). Severity of a discrepancy: **HIGH** = fault, **MEDIUM** = needs review, **LOW** = information. A few checks raise or lower their severity depending on the count.', '',
  ];
  for (const s of SECTIONS) {
    lines.push(`## ${s.key}. ${s.name}`, '', '| ID | Check | Severity | Rule |', '|---|---|---|---|');
    for (const i of s.items) lines.push(`| ${i.sn} | ${i.parameter} | ${i.severity} | ${i.rule} |`);
    lines.push('');
  }
  lines.push(
    '## Verdict (first match wins)', '',
    '| Verdict | Condition |', '|---|---|',
    '| INCONCLUSIVE | No balance can be checked; or 3 or more balance checks fail and they are over half of all checks; or over 20% of lines are unread. |',
    '| FAULTS_FOUND | Any HIGH discrepancy. |',
    '| REVIEW_REQUIRED | Any MEDIUM discrepancy. |',
    '| VERIFIED | Otherwise. |', '',
    '`accountsCorrect` is `false` when any section B check fails, `null` when it cannot be established, and `true` otherwise.', '',
    '## Likely cause of a balance fault', '',
    '| Cause | How it is recognised |', '|---|---|',
    '| WRONG_BALANCE_FIGURE | The next row is wrong by the same amount in the opposite direction. |',
    '| DUPLICATED_LINE | The row repeats the previous row, including its balance. |',
    '| DEBIT_CREDIT_SWAPPED | The difference is exactly twice the amount. |',
    '| WRONG_AMOUNT_OR_MISSING_ENTRY | None of the above. |', '',
    '## Reading rules', '',
    '- A negative figure in a debit or credit column is a reversal and keeps its sign. If a whole column is negative, the sign is only the bank\'s notation.',
    '- When a PDF row has one amount and a balance, debit or credit follows from how the balance moved.',
    '- When a PDF row prints both columns, the column order is learned from the whole statement and applied to every row.',
    '- Printed summary figures that are separated from their labels are matched against calculated totals; two or more unexplained figures fail check B006.',
    '- A line carrying an amount and a balance is read as a transaction or reported; it is never silently dropped. An isolated undated line with a single amount is not reported.', '',
  );
  return lines.join('\n');
}

const outputs = {
  'workflows/bank-statement-verifier.json': `${JSON.stringify(workflow, null, 2)}\n`,
  'docs/STATEMENT_RULES.md': rulesDocument(),
};

if (require.main === module) {
  for (const [file, content] of Object.entries(outputs)) {
    fs.mkdirSync(path.dirname(path.join(ROOT, file)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, file), content);
  }
  console.log(`Built ${Object.keys(outputs).join(', ')} (${nodes.length} nodes)`);
}

module.exports = { outputs, workflow };
