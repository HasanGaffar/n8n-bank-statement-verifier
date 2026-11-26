/**
 * File      : src/analysis.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Account analysis: monthly flow, categories and balances.
 * n8n node  : Analyse Account
 * Flow      : Detect Patterns -> [Analyse Account] -> Find Earlier Submissions
 */
// Descriptive analysis of the account: monthly flow, categories and balances.
// --- imports ---
const { round2, sum, mean, toDay, fromDay } = require('./util');
// --- end imports ---

function monthlyFlow(transactions) {
  const months = new Map();
  for (const t of transactions) {
    const key = t.date.slice(0, 7);
    if (!months.has(key)) months.set(key, { month: key, transactions: 0, credit: 0, debit: 0, closingBalance: 0 });
    const m = months.get(key);
    m.transactions += 1;
    m.credit = round2(m.credit + t.credit);
    m.debit = round2(m.debit + t.debit);
    m.closingBalance = t.balance;
  }
  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({ ...m, net: round2(m.credit - m.debit) }));
}

function categoryTotals(transactions) {
  const totals = new Map();
  for (const t of transactions) {
    if (!totals.has(t.category)) totals.set(t.category, { category: t.category, transactions: 0, credit: 0, debit: 0 });
    const c = totals.get(t.category);
    c.transactions += 1;
    c.credit = round2(c.credit + t.credit);
    c.debit = round2(c.debit + t.debit);
  }
  return [...totals.values()].sort((a, b) => b.credit + b.debit - (a.credit + a.debit));
}

// reduce, because spreading a very large array into Math.min overflows the stack.
const lowest = (values) => values.reduce((a, b) => Math.min(a, b), Infinity);
const highest = (values) => values.reduce((a, b) => Math.max(a, b), -Infinity);

// Average end-of-day balance over every calendar day in the statement.
function averageDailyBalance(transactions) {
  const closing = new Map();
  for (const t of transactions) closing.set(toDay(t.date), t.balance);
  const days = [...closing.keys()];
  const balances = [];
  const first = lowest(days);
  const last = highest(days);
  let current = closing.get(first);
  for (let day = first; day <= last; day += 1) {
    if (closing.has(day)) current = closing.get(day);
    balances.push(current);
  }
  return round2(mean(balances));
}

const brief = (t) => t && { row: t.row, date: t.date, description: t.description, amount: round2(t.credit + t.debit) };

function analyseAccount(transactions) {
  const days = transactions.map((t) => toDay(t.date));
  const balances = transactions.map((t) => t.balance);
  const largest = (side) =>
    brief([...transactions].filter((t) => t[side] > 0).sort((a, b) => b[side] - a[side])[0]) || null;
  return {
    periodStart: fromDay(lowest(days)),
    periodEnd: fromDay(highest(days)),
    transactionCount: transactions.length,
    creditCount: transactions.filter((t) => t.credit > 0).length,
    debitCount: transactions.filter((t) => t.debit > 0).length,
    netChange: round2(sum(transactions.map((t) => t.credit - t.debit))),
    averageDailyBalance: averageDailyBalance(transactions),
    lowestBalance: round2(lowest(balances)),
    highestBalance: round2(highest(balances)),
    largestCredit: largest('credit'),
    largestDebit: largest('debit'),
    monthly: monthlyFlow(transactions),
    categories: categoryTotals(transactions),
  };
}

// --- exports ---
module.exports = { analyseAccount };
