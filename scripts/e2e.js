/**
 * File      : scripts/e2e.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Sends every sample to the running workflow and compares the results.
 * n8n node  : None. Developer tool: npm run e2e
 * Flow      : sample-data/ -> [e2e] -> POST /webhook/verify-statement
 */
// Needs a running n8n with the workflow active. Never requests the AI review.
// Each request adds a row to the audit table.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { send } = require('./verify');

// Fixed values, so the results do not depend on .env or on today's date.
const FIELDS = { as_of_date: '2026-11-26', ai_review: 'false' };

const verdict = (name, expected, faultCount) => ({ name, status: 200, verdict: expected, faultCount });
const rejected = (name, status, code) => ({ name, status, code });

const CASES = [
  verdict('01-correct.csv', 'VERIFIED'),
  verdict('02-altered-amount.csv', 'FAULTS_FOUND', 1),
  verdict('03-altered-balance.csv', 'FAULTS_FOUND', 1),
  verdict('04-missing-entry.csv', 'FAULTS_FOUND', 1),
  verdict('05-swapped-debit-credit.csv', 'FAULTS_FOUND', 1),
  verdict('06-duplicated-line.csv', 'FAULTS_FOUND', 1),
  verdict('07-wrong-printed-totals.csv', 'FAULTS_FOUND', 0),
  verdict('08-suspicious-pattern.csv', 'REVIEW_REQUIRED'),
  verdict('09-correct.xlsx', 'VERIFIED'),
  verdict('10-correct.pdf', 'VERIFIED'),
  verdict('11-altered-amount.pdf', 'FAULTS_FOUND', 1),
  verdict('12-wallet-correct.csv', 'VERIFIED'),
  rejected('13-missing-columns.csv', 422, 'MISSING_COLUMNS'),
  rejected('14-scanned-image.pdf', 422, 'OCR_REQUIRED'),
  rejected('15-unsupported.txt', 415, 'UNSUPPORTED_FILE_TYPE'),
  verdict('16-amounts-first-layout.pdf', 'VERIFIED'),
  verdict('17-multiple-faults.csv', 'FAULTS_FOUND', 3),
  rejected(null, 400, 'MISSING_FILE'),
];

// Returns a list of differences; an empty list means the case passed.
function compare(expected, status, body, faultRow) {
  const problems = [];
  const check = (label, actual, wanted) => {
    if (actual !== wanted) problems.push(`${label}: expected ${wanted}, got ${actual}`);
  };
  check('HTTP status', status, expected.status);
  check('success', body.success, Boolean(expected.verdict));
  if (expected.verdict) {
    check('verdict', body.result?.verdict, expected.verdict);
    if (expected.faultCount !== undefined) check('faultCount', body.faultCount, expected.faultCount);
    if (expected.verdict === 'VERIFIED') check('accountsCorrect', body.result?.accountsCorrect, true);
    if (expected.verdict === 'FAULTS_FOUND' && body.result?.accountsCorrect === true) {
      problems.push('accountsCorrect: must not be true when faults are expected');
    }
    if (faultRow !== undefined) check('fault row', body.faults?.[0]?.row, faultRow);
  } else {
    check('error code', body.error?.code, expected.code);
  }
  if (!Number.isInteger(body.audit?.rowId)) problems.push('audit.rowId is missing');
  return problems;
}

async function main() {
  const rows = JSON.parse(fs.readFileSync(path.join(config.sampleDir, 'expected-fault-rows.json'), 'utf8'));
  let failed = 0;
  for (const expected of CASES) {
    const label = expected.name || '(no file)';
    let problems;
    try {
      const file = expected.name ? path.join(config.sampleDir, expected.name) : null;
      const { status, json } = await send(file, FIELDS);
      problems = compare(expected, status, json, rows[expected.name]?.row);
    } catch (error) {
      if (error.unreachable) throw error;
      problems = [error.message];
    }
    if (problems.length) failed += 1;
    console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${label}`);
    for (const problem of problems) console.log(`      ${problem}`);
  }
  console.log(`\n${CASES.length - failed} of ${CASES.length} passed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
