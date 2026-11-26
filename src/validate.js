/**
 * File      : src/validate.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Core check: do the accounts add up, and if not, on which row and why.
 * n8n node  : Check Arithmetic
 * Flow      : Parsed OK? -> [Check Arithmetic] -> Categorize Transactions
 */
// The core of the project: is the arithmetic of the statement correct, and if
// not, where is it wrong and what is the likely cause?
// --- imports ---
const { round2, sum, toDay, formatMoney } = require('./util');
// --- end imports ---

const TOLERANCE = 0.01;
const same = (a, b) => Math.abs(a - b) <= TOLERANCE + 1e-9;

// `difference` is what the statement shows minus what the arithmetic gives.
function diagnose(transactions, index, difference, nextDifference) {
  const tx = transactions[index];
  const previous = transactions[index - 1];
  const money = formatMoney(Math.abs(difference));

  if (nextDifference !== null && same(difference, -nextDifference)) {
    return {
      cause: 'WRONG_BALANCE_FIGURE',
      explanation:
        `The balance printed on this row is off by ${money}. The following row continues correctly ` +
        'from the calculated value, so the balance figure itself was probably altered or mistyped.',
    };
  }
  if (
    previous &&
    previous.date === tx.date &&
    previous.description === tx.description &&
    previous.debit === tx.debit &&
    previous.credit === tx.credit &&
    same(previous.balance, tx.balance)
  ) {
    return {
      cause: 'DUPLICATED_LINE',
      explanation: 'This line repeats the previous one, including its balance. It was probably copied twice.',
    };
  }
  if ((tx.debit !== 0 && same(difference, 2 * tx.debit)) || (tx.credit !== 0 && same(difference, -2 * tx.credit))) {
    return {
      cause: 'DEBIT_CREDIT_SWAPPED',
      explanation:
        `The error is exactly twice the amount, so this ${tx.debit !== 0 ? 'debit was applied as a credit' : 'credit was applied as a debit'} ` +
        '(wrong column or wrong sign).',
    };
  }
  const direction = difference > 0 ? 'credit' : 'debit';
  return {
    cause: 'WRONG_AMOUNT_OR_MISSING_ENTRY',
    explanation:
      `Either the amount on this row is wrong by ${money}, or a ${direction} of ${money} is missing just before it.`,
  };
}

function checkRunningBalance(transactions, openingBalance) {
  const differences = transactions.map((tx, i) => {
    const previous = i === 0 ? openingBalance : transactions[i - 1].balance;
    if (previous === null || previous === undefined) return null;
    const expected = round2(previous + tx.credit - tx.debit);
    return { expected, difference: same(expected, tx.balance) ? 0 : round2(tx.balance - expected) };
  });

  const mismatches = [];
  let explainedByPrevious = false;
  differences.forEach((entry, i) => {
    if (!entry || entry.difference === 0) {
      explainedByPrevious = false;
      return;
    }
    // A wrong balance figure also breaks the next row; report it only once.
    if (explainedByPrevious) {
      explainedByPrevious = false;
      return;
    }
    const tx = transactions[i];
    const next = differences[i + 1];
    const diagnosis = diagnose(transactions, i, entry.difference, next ? next.difference : null);
    explainedByPrevious = diagnosis.cause === 'WRONG_BALANCE_FIGURE';
    mismatches.push({
      row: tx.row,
      date: tx.date,
      description: tx.description,
      debit: tx.debit,
      credit: tx.credit,
      expectedBalance: entry.expected,
      shownBalance: tx.balance,
      difference: entry.difference,
      ...diagnosis,
    });
  });

  return { checked: differences.filter(Boolean).length, mismatches };
}

// Decides whether every arithmetic mismatch could come from lines we could not
// read. A balance gap counts only when an unread line sits inside that gap.
// Row numbers run downwards when a newest-first file was reversed.
function explainedByUnreadLines({ transactions, rejected, openingBalance, stated, totals, unmatchedSummary }) {
  // An unread summary line holds no transaction, so it cannot explain a gap.
  const lines = rejected.filter((r) => !r.summary);
  if (!lines.length) return false;
  const first = transactions[0];
  const last = transactions[transactions.length - 1];
  const direction = first.row > last.row ? -1 : 1;
  const unreadBefore = (tx) => lines.some((r) => (tx.row - r.row) * direction > 0);
  const unreadAfter = (tx) => lines.some((r) => (r.row - tx.row) * direction > 0);
  const unreadBetween = (a, b) => lines.some((r) => (r.row - a.row) * (b.row - r.row) > 0);
  const openingKnown = openingBalance !== null && openingBalance !== undefined;

  // Every gap is examined, including those not listed separately as faults.
  let net = 0;
  let gaps = 0;
  for (let i = 0; i < transactions.length; i += 1) {
    const tx = transactions[i];
    const previous = i === 0 ? openingBalance : transactions[i - 1].balance;
    if (previous === null || previous === undefined) continue;
    const expected = round2(previous + tx.credit - tx.debit);
    if (same(expected, tx.balance)) continue;
    if (!(i === 0 ? unreadBefore(tx) : unreadBetween(transactions[i - 1], tx))) return false;
    net = round2(net + tx.balance - expected);
    gaps += 1;
  }

  const trailing = unreadAfter(last);
  if (stated.closingBalance !== null && !same(stated.closingBalance, last.balance)) {
    if (!trailing) return false;
    net = round2(net + stated.closingBalance - last.balance);
  }

  // At an end with no printed balance, the money on an unread line is unknown.
  const openEnd = (trailing && stated.closingBalance === null) || (!openingKnown && unreadBefore(first));
  const canHoldMoney = openEnd || gaps > 0 || trailing;

  // Unread lines can only make a calculated total too small, never too large.
  const missing = {};
  for (const side of ['totalCredit', 'totalDebit']) {
    missing[side] = stated[side] === null ? null : round2(stated[side] - totals[side]);
    if (missing[side] === null || same(missing[side], 0)) continue;
    if (!canHoldMoney || missing[side] < 0) return false;
  }
  if (!openEnd) {
    // What is missing from the totals must agree with what is missing from the balances.
    const { totalCredit: credit, totalDebit: debit } = missing;
    if (credit !== null && debit !== null) {
      if (!same(round2(credit - debit), net)) return false;
    } else if (credit !== null && credit < net - TOLERANCE) return false;
    else if (debit !== null && debit < -net - TOLERANCE) return false;
  }

  if (!unmatchedSummary) return true;
  return canHoldMoney && unmatchedSummary.figures.every(({ label, calculated }) => {
    if (label === 'closingBalance') return trailing;
    if (label === 'openingBalance') return unreadBefore(first);
    return unmatchedSummary.printed.some((v) => v >= calculated - TOLERANCE);
  });
}

// Gives each label the printed figure equal to our own calculation. One label
// and one figure left over is a clear mismatch; more than that cannot be
// assigned safely, so they are reported as unmatched.
function matchDetachedSummary({ labels, values }, calculated) {
  const remaining = [...values];
  const matched = {};
  const unmatched = [];
  for (const label of labels) {
    const at = remaining.findIndex((v) => same(v, calculated[label]));
    if (at >= 0) matched[label] = remaining.splice(at, 1)[0];
    else unmatched.push(label);
  }
  if (unmatched.length === 1) {
    matched[unmatched[0]] = remaining[0];
    return { matched, unmatched: null };
  }
  return {
    matched,
    unmatched: unmatched.length
      ? { figures: unmatched.map((label) => ({ label, calculated: calculated[label] })), printed: remaining }
      : null,
  };
}

function validateStatement({ transactions, rejected, openingBalance: givenOpening, stated: givenStated = {} }) {
  const first = transactions[0];
  let stated = givenStated;
  let openingBalance = givenOpening;
  let unmatchedSummary = null;
  if (givenStated.detached) {
    const credit = round2(sum(transactions.map((t) => t.credit)));
    const debit = round2(sum(transactions.map((t) => t.debit)));
    const result = matchDetachedSummary(givenStated.detached, {
      openingBalance: openingBalance ?? round2(first.balance - first.credit + first.debit),
      closingBalance: transactions[transactions.length - 1].balance,
      totalCredit: credit,
      totalDebit: debit,
    });
    stated = { ...givenStated, ...result.matched };
    openingBalance = openingBalance ?? result.matched.openingBalance ?? null;
    unmatchedSummary = result.unmatched;
  }
  const openingStated = openingBalance !== null && openingBalance !== undefined;
  // Without a stated opening balance the first row cannot be verified.
  const opening = openingStated ? openingBalance : round2(first.balance - first.credit + first.debit);

  const { checked, mismatches } = checkRunningBalance(transactions, openingStated ? openingBalance : null);

  const totalCredit = round2(sum(transactions.map((t) => t.credit)));
  const totalDebit = round2(sum(transactions.map((t) => t.debit)));
  const lastBalance = transactions[transactions.length - 1].balance;

  let outOfOrder = 0;
  let longestGapDays = 0;
  const outOfOrderRows = [];
  for (let i = 1; i < transactions.length; i += 1) {
    const gap = toDay(transactions[i].date) - toDay(transactions[i - 1].date);
    if (gap < 0) {
      outOfOrder += 1;
      outOfOrderRows.push(transactions[i].row);
    }
    longestGapDays = Math.max(longestGapDays, gap);
  }

  const totals = {
    openingBalance: opening,
    openingBalanceSource: openingStated ? 'stated' : 'derived from first row',
    totalCredit,
    totalDebit,
    calculatedClosingBalance: round2(opening + totalCredit - totalDebit),
    lastRowBalance: lastBalance,
  };
  const printed = {
    openingBalance: openingStated ? openingBalance : null,
    closingBalance: stated.closingBalance ?? null,
    totalCredit: stated.totalCredit ?? null,
    totalDebit: stated.totalDebit ?? null,
    periodStart: stated.periodStart ?? null,
    periodEnd: stated.periodEnd ?? null,
  };

  const total = transactions.length + rejected.length;
  return {
    totalRows: total,
    parsedRows: transactions.length,
    rejectedRows: rejected.length,
    balanceChecks: checked,
    mismatches,
    outOfOrder,
    outOfOrderRows,
    longestGapDays,
    totals,
    stated: printed,
    explainedByUnreadLines: explainedByUnreadLines({
      transactions, rejected, openingBalance: printed.openingBalance, stated: printed, totals, unmatchedSummary,
    }),
    summaryLayout: givenStated.detached ? 'figures printed apart from their labels' : 'figures beside their labels',
    unmatchedSummary,
  };
}

// --- exports ---
module.exports = { validateStatement, TOLERANCE };
