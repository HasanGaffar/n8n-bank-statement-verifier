/**
 * File      : src/engine.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Runs the same steps as the workflow outside n8n.
 * n8n node  : None. Used by the automated tests.
 * Flow      : parse -> validate -> categorize -> fraud -> analysis -> checklist -> assemble
 */
// Runs the same steps, in the same order, as the n8n workflow. Used by the tests;
// inside n8n each step is its own Code node.
const { parseRows } = require('./parse');
const { parsePdfText } = require('./parse-pdf');
const { validateStatement } = require('./validate');
const { categorizeAll } = require('./categorize');
const { detectRisks } = require('./fraud');
const { analyseAccount } = require('./analysis');
const { runChecklist } = require('./checklist');
const { assembleResponse } = require('./assemble');

function analyze({ rows, pdfText, intake, duplicateOf = null }) {
  const parsed = pdfText === undefined ? parseRows(rows) : parsePdfText(pdfText);
  if (!parsed.transactions.length) throw new Error('No readable transactions in the statement.');
  const validation = validateStatement(parsed);
  const { transactions, detections } = detectRisks(categorizeAll(parsed.transactions));
  const analysis = analyseAccount(transactions);
  const sections = runChecklist({
    validation, detections, transactions, duplicateOf,
    asOfDate: intake.asOfDate, accountHolder: intake.accountHolder,
  });
  return assembleResponse({ intake, validation, analysis, sections, rejected: parsed.rejected });
}

module.exports = { analyze };
