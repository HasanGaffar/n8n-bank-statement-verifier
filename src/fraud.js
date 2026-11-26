/**
 * File      : src/fraud.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Detects unusual patterns that a person should look at.
 * n8n node  : Detect Patterns
 * Flow      : Categorize Transactions -> [Detect Patterns] -> Analyse Account
 */
// Pattern detection. A detection is a reason for a human to look, not proof of fraud.
// --- imports ---
const { sum, median, toDay, AVG_DAYS_PER_MONTH } = require('./util');
const { NON_OPERATING_CREDITS } = require('./categorize');
// --- end imports ---

const THRESHOLDS = {
  lateWindowDays: 14,
  lateMinPriorDays: 45,
  lateShareOfMonthlyIncome: 0.5,
  lateTimesMedianCredit: 4,
  roundTripShareOfMonthlyIncome: 0.4,
  roundTripDays: 3,
  roundTripAmountTolerance: 0.02,
  outlierTimesMedian: 10,
  outlierMinEntries: 10,
};

const isIncome = (t) => t.credit > 0 && !NON_OPERATING_CREDITS.includes(t.category);

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()];
}

// Large deposits just before applying ("window dressing").
// Returns null when there is too little earlier history to compare with.
function findLateDeposits(transactions, first, last) {
  const windowStart = last - THRESHOLDS.lateWindowDays + 1;
  const priorDays = windowStart - first;
  if (priorDays < THRESHOLDS.lateMinPriorDays) return null;
  const prior = transactions.filter((t) => isIncome(t) && toDay(t.date) < windowStart);
  if (!prior.length) return null;
  const monthlyIncome = sum(prior.map((t) => t.credit)) / (priorDays / AVG_DAYS_PER_MONTH);
  const typicalCredit = median(prior.map((t) => t.credit));
  return transactions.filter(
    (t) =>
      isIncome(t) &&
      toDay(t.date) >= windowStart &&
      t.credit >= THRESHOLDS.lateShareOfMonthlyIncome * monthlyIncome &&
      t.credit >= THRESHOLDS.lateTimesMedianCredit * typicalCredit,
  );
}

// A large credit that leaves again, almost unchanged, within a few days.
function findRoundTrips(transactions, monthlyIncome) {
  const used = new Set();
  const pairs = [];
  transactions.forEach((credit, i) => {
    if (!isIncome(credit) || credit.credit < THRESHOLDS.roundTripShareOfMonthlyIncome * monthlyIncome) return;
    const match = transactions.findIndex(
      (debit, j) =>
        j > i &&
        !used.has(j) &&
        debit.debit > 0 &&
        toDay(debit.date) - toDay(credit.date) <= THRESHOLDS.roundTripDays &&
        Math.abs(debit.debit - credit.credit) <= THRESHOLDS.roundTripAmountTolerance * credit.credit,
    );
    if (match >= 0) {
      used.add(match);
      pairs.push({ credit, debit: transactions[match] });
    }
  });
  return pairs;
}

// Amounts far above what is usual for that side of the account.
// Returns null when neither side has enough entries to say what is usual.
function findOutliers(transactions) {
  // Many tiny charges would drag "usual" down, so they are left out of it.
  const ordinary = transactions.filter((t) => !['BANK_CHARGE', 'REVERSAL'].includes(t.category));
  const sides = ['credit', 'debit']
    .map((side) => ({ side, entries: ordinary.filter((t) => t[side] > 0) }))
    .filter((s) => s.entries.length >= THRESHOLDS.outlierMinEntries);
  if (!sides.length) return null;
  return sides.flatMap(({ side, entries }) => {
    const usual = median(entries.map((t) => t[side]));
    return entries.filter((t) => t[side] > THRESHOLDS.outlierTimesMedian * usual).map((t) => t.row);
  });
}

function detectRisks(transactions) {
  const days = transactions.map((t) => toDay(t.date));
  // reduce, because spreading a very large array into Math.min overflows the stack.
  const first = days.reduce((a, b) => Math.min(a, b), Infinity);
  const last = days.reduce((a, b) => Math.max(a, b), -Infinity);
  const monthlyIncome =
    sum(transactions.filter(isIncome).map((t) => t.credit)) / ((last - first + 1) / AVG_DAYS_PER_MONTH);

  const lateDeposits = findLateDeposits(transactions, first, last);
  const roundTrips = findRoundTrips(transactions, monthlyIncome);
  const duplicateReferences = groupBy(
    transactions.filter((t) => t.reference),
    (t) => `${t.reference}|${t.debit}|${t.credit}`,
  ).filter((g) => g.length > 1);

  const repeatedEntries = groupBy(
    transactions.filter((t) => !t.reference),
    (t) => `${t.date}|${t.description}|${t.debit}|${t.credit}`,
  ).filter((g) => g.length > 1);

  return {
    transactions,
    detections: {
      outlierRows: findOutliers(transactions),
      lateDeposits: lateDeposits && lateDeposits.map((t) => ({ row: t.row, date: t.date, amount: t.credit })),
      roundTrips: roundTrips.map((p) => ({
        creditRow: p.credit.row, debitRow: p.debit.row, amount: p.credit.credit, date: p.credit.date,
      })),
      duplicateReferences: duplicateReferences.map((g) => ({ reference: g[0].reference, rows: g.map((t) => t.row) })),
      repeatedEntryRows: repeatedEntries.flat().map((t) => t.row),
      bounceRows: transactions.filter((t) => t.category === 'BOUNCE_CHARGE').map((t) => t.row),
    },
  };
}

// --- exports ---
module.exports = { detectRisks, THRESHOLDS };
