/**
 * File      : src/assemble.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Decides the verdict and builds the JSON response.
 * n8n node  : Assemble Response (also used by Route Models)
 * Flow      : AI Review Requested? / Merge AI Review -> [Assemble Response] -> Prepare Audit Record -> Save Audit Log -> Send Response
 */
// Decides the verdict and builds the JSON that the API returns.
// --- imports ---
const { round2, formatMoney } = require('./util');
const { summarizeChecklist } = require('./checklist');
// --- end imports ---

// When most of what we read does not add up, or much of it could not be read,
// the likelier explanation is a layout we do not understand. Say so instead of
// accusing the statement.
function readingIsUnreliable(v) {
  if (!v.balanceChecks) return true;
  const mostFail = v.mismatches.length >= 3 && v.mismatches.length / v.balanceChecks > 0.5;
  return mostFail || v.rejectedRows / v.totalRows > 0.2;
}

function decide(validation, discrepancies) {
  const arithmeticFault = discrepancies.some((d) => d.section === 'B');
  const has = (severity) => discrepancies.some((d) => d.severity === severity);

  if (readingIsUnreliable(validation)) {
    return {
      verdict: 'INCONCLUSIVE',
      accountsCorrect: null,
      headline: 'The statement could not be read reliably. This is not evidence of a fault; check the file layout.',
    };
  }

  // Gaps that sit where lines could not be read are our limitation, not a fault.
  // Other serious findings, outside the arithmetic, still count.
  const unreadGap = arithmeticFault && validation.explainedByUnreadLines;
  if (unreadGap && !discrepancies.some((d) => d.severity === 'HIGH' && d.section !== 'B')) {
    return {
      verdict: 'REVIEW_REQUIRED',
      accountsCorrect: null,
      headline: 'Some lines could not be read, and the figures do not add up around them. The accounts are not verified.',
    };
  }

  let accountsCorrect = !arithmeticFault;
  if (validation.rejectedRows && (accountsCorrect || unreadGap)) accountsCorrect = null;

  if (has('HIGH')) {
    const rows = validation.mismatches.map((m) => m.row);
    let headline = 'A serious fault was found. See discrepancies.';
    if (arithmeticFault && !unreadGap) {
      headline = rows.length
        ? `The accounts do not add up: ${rows.length} fault(s), first at row ${rows[0]}.`
        : 'The printed summary figures do not match the transactions.';
    }
    return { verdict: 'FAULTS_FOUND', accountsCorrect, headline };
  }
  if (has('MEDIUM')) {
    return {
      verdict: 'REVIEW_REQUIRED',
      accountsCorrect,
      headline: accountsCorrect
        ? 'The arithmetic is correct, but some items need a human to check them.'
        : 'Some lines could not be read, so the accounts are only partly verified.',
    };
  }
  return { verdict: 'VERIFIED', accountsCorrect, headline: 'The accounts add up and no item needs review.' };
}

function assembleResponse({ intake, validation, analysis, sections, rejected, aiReview }) {
  const { summary, discrepancies } = summarizeChecklist(sections);
  const result = decide(validation, discrepancies);
  const ai = aiReview || { requested: false, status: 'NOT_REQUESTED', concerns: [], failedSections: [] };
  const { totals, stated, mismatches } = validation;

  const manualHandling = discrepancies
    .filter((d) => d.severity !== 'LOW')
    .map((d) => `${d.sn} (${d.severity}): ${d.parameter}`);
  if (result.verdict === 'INCONCLUSIVE') manualHandling.unshift('Statement layout could not be read reliably.');
  if (ai.status === 'UNAVAILABLE') manualHandling.push('AI review was requested but did not return a usable answer.');
  if (ai.status === 'PARTIAL') manualHandling.push(`AI review is missing for section(s) ${ai.failedSections.join(', ')}.`);
  if (ai.concerns.length) manualHandling.push(`AI review raised ${ai.concerns.length} concern(s).`);

  const closingTarget = stated.closingBalance === null ? totals.lastRowBalance : stated.closingBalance;

  return {
    success: true,
    reference: intake.reference,
    accountHolder: intake.accountHolder,
    statement: {
      fileName: intake.fileName,
      fileType: intake.fileType,
      sha256: intake.sha256,
      periodStart: analysis.periodStart,
      periodEnd: analysis.periodEnd,
      transactionCount: analysis.transactionCount,
      verifiedAsOf: intake.asOfDate,
    },
    result,
    reconciliation: {
      openingBalance: totals.openingBalance,
      openingBalanceSource: totals.openingBalanceSource,
      totalCredit: totals.totalCredit,
      totalDebit: totals.totalDebit,
      calculatedClosingBalance: totals.calculatedClosingBalance,
      lastRowBalance: totals.lastRowBalance,
      printedClosingBalance: stated.closingBalance,
      printedTotalCredit: stated.totalCredit,
      printedTotalDebit: stated.totalDebit,
      unexplainedDifference: round2(closingTarget - totals.calculatedClosingBalance),
      balanceCalculationsChecked: validation.balanceChecks,
    },
    faults: mismatches.slice(0, 100).map((m) => ({
      ...m,
      summary:
        `Row ${m.row}, ${m.date}: expected ${formatMoney(m.expectedBalance)} but the statement shows ` +
        `${formatMoney(m.shownBalance)}.`,
    })),
    faultCount: mismatches.length,
    verification: { summary, discrepancies, sections },
    analysis,
    unreadLines: rejected.slice(0, 50).map(({ row, reason }) => ({ row, reason })),
    aiReview: ai,
    processing: {
      straightThrough: result.verdict === 'VERIFIED' && manualHandling.length === 0,
      manualHandling,
    },
  };
}

// --- exports ---
module.exports = { assembleResponse, decide };
