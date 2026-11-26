/**
 * File      : src/parse.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Reads CSV and Excel rows into one common transaction format. Nothing is dropped silently.
 * n8n node  : Parse Transactions (also date parsing in Check Request)
 * Flow      : File Type -> Extract CSV / Extract Excel -> [Parse Transactions] -> Parsed OK?
 */
// Turns spreadsheet rows or PDF text into one common transaction format:
// { row, date, description, debit, credit, balance, reference }
// --- imports ---
const { round2 } = require('./util');
// --- end imports ---

// Bengali digits are the code points U+09E6 to U+09EF. Bengali text in this file is
// written as Unicode escapes; U+09F3 is the Taka sign.
const toAsciiDigits = (s) => String(s).replace(/[\u09E6-\u09EF]/g, (d) => d.charCodeAt(0) - 0x09e6);

const isBlank = (v) => v === null || v === undefined || ['', '-', '—'].includes(String(v).trim());

// Returns a number, or NaN when the text is not an amount. A trailing "DR" or
// surrounding parentheses make the value negative (overdrawn balance).
function parseAmount(raw) {
  if (isBlank(raw)) return 0;
  if (typeof raw === 'number') return round2(raw);
  let text = toAsciiDigits(raw).trim();
  let sign = 1;
  if (/^\(.*\)$/.test(text)) {
    sign = -1;
    text = text.slice(1, -1);
  }
  // "100/-" is a common way to write exactly 100.
  text = text.replace(/\u09F3|BDT|Tk\.?/gi, '').replace(/[,\s]/g, '').replace(/(\d)\/[-=]$/, '$1');
  const match = text.match(/^([+-]?)(\d+(?:\.\d+)?)(CR|DR)?$/i);
  if (!match) return NaN;
  if (match[1] === '-') sign *= -1;
  if (match[3] && match[3].toUpperCase() === 'DR') sign *= -1;
  return round2(sign * Number(match[2]));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function buildDate(year, month, day) {
  const y = year < 100 ? 2000 + year : year;
  const date = new Date(Date.UTC(y, month - 1, day));
  const real = date.getUTCFullYear() === y && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? date.toISOString().slice(0, 10) : null;
}

// Numeric dates are read day-first (DD/MM/YYYY), the usual order in Bangladesh.
function parseDate(raw) {
  if (isBlank(raw)) return null;
  // Excel stores dates as the number of days since 1899-12-30.
  if (typeof raw === 'number') {
    if (raw < 20000 || raw > 80000) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(raw) * 86400000).toISOString().slice(0, 10);
  }
  const text = toAsciiDigits(raw).trim();
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (m) return buildDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?:\s.*)?$/);
  if (m) return buildDate(Number(m[3]), Number(m[2]), Number(m[1]));
  m = text.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s,-]+(\d{4}|\d{2})(?:\s.*)?$/);
  if (m) {
    const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    return month ? buildDate(Number(m[3]), month, Number(m[1])) : null;
  }
  return null;
}

// The last alias of date, description, debit, credit and balance is the Bengali column title.
const HEADER_ALIASES = {
  date: ['date', 'transaction date', 'txn date', 'trans date', 'posting date', 'date time', 'datetime', '\u09A4\u09BE\u09B0\u09BF\u0996'],
  description: ['description', 'particulars', 'narration', 'details', 'transaction details', 'remarks', '\u09AC\u09BF\u09AC\u09B0\u09A3'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'debit amount', 'dr', 'money out', 'paid out', '\u0996\u09B0\u099A'],
  credit: ['credit', 'deposit', 'deposits', 'credit amount', 'cr', 'money in', 'paid in', '\u099C\u09AE\u09BE'],
  amount: ['amount', 'transaction amount'],
  direction: ['type', 'dr/cr', 'cr/dr', 'direction', 'txn type', 'transaction type'],
  fee: ['fee', 'fees', 'charge', 'charges'],
  balance: ['balance', 'running balance', 'closing balance', 'available balance', '\u09AC\u09CD\u09AF\u09BE\u09B2\u09C7\u09A8\u09CD\u09B8'],
  reference: ['reference', 'ref', 'ref no', 'reference no', 'trxid', 'trx id', 'transaction id', 'cheque no', 'chq no'],
};

const cleanHeader = (header) =>
  String(header)
    .replace(/^﻿/, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[_.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function mapHeaders(headers) {
  const columns = {};
  for (const header of headers) {
    const cleaned = cleanHeader(header);
    const field = Object.keys(HEADER_ALIASES).find((key) => HEADER_ALIASES[key].includes(cleaned));
    if (field && !columns[field]) columns[field] = header;
  }
  const missing = [];
  if (!columns.date) missing.push('Date');
  if (!columns.balance) missing.push('Balance');
  if (!columns.description && !columns.direction) missing.push('Description');
  if (!(columns.debit && columns.credit) && !(columns.amount && columns.direction)) {
    missing.push('Debit + Credit (or Amount + Type)');
  }
  if (missing.length) {
    throw new Error(`Missing column(s): ${missing.join(', ')}. Found: ${headers.join(', ')}`);
  }
  return columns;
}

const CREDIT_WORDS = /^(cr|credit|in|cash in|add money|received|received money|deposit|payment received)$/i;
const DEBIT_WORDS = /^(dr|debit|out|cash out|send money|payment|withdraw|withdrawal|mobile recharge|pay bill)$/i;

const SUMMARY_LABEL = /^(closing balance|totals?|grand total|total (debits?|credits?|withdrawals?|deposits?)|balance (c\/f|carried forward))\s*:?$/i;
const OPENING_LABEL = /^(opening balance|balance brought forward|brought forward|balance b\/f)\s*:?$/i;

// How many running balances do not follow from the one before, in this order.
function countBreaks(transactions, openingBalance) {
  return transactions.filter((t, i) => {
    const previous = i === 0 ? openingBalance : transactions[i - 1].balance;
    return typeof previous === 'number' && Math.abs(round2(previous + t.credit - t.debit - t.balance)) > 0.01;
  }).length;
}

// Bank exports are sometimes newest-first; the balance check needs oldest-first.
// When the first and last dates are equal they do not show the order, so the
// direction in which more running balances reconcile is used.
function oldestFirst(transactions, openingBalance = null) {
  if (transactions.length < 2) return transactions;
  const first = transactions[0].date;
  const last = transactions[transactions.length - 1].date;
  if (first > last) return [...transactions].reverse();
  if (first === last) {
    const reversed = [...transactions].reverse();
    if (countBreaks(reversed, openingBalance) < countBreaks(transactions, openingBalance)) return reversed;
  }
  return transactions;
}

const optionalAmount = (raw) => {
  if (isBlank(raw)) return null;
  const value = parseAmount(raw);
  return Number.isNaN(value) ? null : value;
};

// A negative figure in a debit or credit column is normally a reversal and must
// keep its sign. Only when a whole column is negative is the minus just the
// bank's way of writing that column.
function normaliseColumnSigns(transactions) {
  const flip = {};
  for (const side of ['debit', 'credit']) {
    const used = transactions.filter((t) => t[side] !== 0);
    flip[side] = used.length > 1 && used.every((t) => t[side] < 0);
  }
  return transactions.map((t) => ({
    ...t,
    debit: flip.debit && t.debit !== 0 ? -t.debit : t.debit,
    credit: flip.credit && t.credit !== 0 ? -t.credit : t.credit,
  }));
}

// In the Amount + Type layout a minus sign is either the export's way of marking
// a direction (dropped) or a reversal (kept). It can be a reversal only if other
// rows show that this direction is also written without a minus, and it is
// treated as one only if a running balance proves it.
function applyReversalSigns(transactions, minus, openingBalance) {
  const positive = (side) => transactions.some((t) => t[side] > 0 && minus.get(t.row)?.side !== side);
  const eligible = { debit: positive('debit'), credit: positive('credit') || positive('debit') };
  const reversed = (t) => {
    const { side, amount } = minus.get(t.row);
    return { ...t, [side]: round2(t[side] - 2 * amount) };
  };
  const candidate = (t) => minus.has(t.row) && eligible[minus.get(t.row).side];
  const proven = {};
  transactions.forEach((t, i) => {
    const previous = i === 0 ? openingBalance : transactions[i - 1].balance;
    if (!candidate(t) || typeof previous !== 'number') return;
    const signed = reversed(t);
    if (Math.abs(round2(previous + signed.credit - signed.debit - t.balance)) <= 0.01) {
      proven[minus.get(t.row).side] = true;
    }
  });
  return transactions.map((t) => (candidate(t) && proven[minus.get(t.row).side] ? reversed(t) : t));
}

// Every row ends up in `transactions` or `rejected`, or is a recognised
// opening/summary line. Nothing is dropped silently.
function parseRows(rows) {
  if (!rows.length) throw new Error('The statement has no data rows.');
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const col = mapHeaders(headers);
  const transactions = [];
  const rejected = [];
  const stated = {};
  const printed = {}; // summary figures, including the opening balance
  const conflicting = new Set();
  const minus = new Map(); // Amount + Type rows printed with a minus sign

  rows.forEach((record, index) => {
    const rowNumber = index + 2; // row 1 is the header
    if (Object.values(record).every(isBlank)) return;
    const read = (field) => (col[field] ? record[col[field]] : undefined);
    const description = String(read('description') ?? read('direction') ?? '').trim();
    const dateText = String(read('date') ?? '').trim();
    const label = [description, dateText].find((t) => OPENING_LABEL.test(t) || SUMMARY_LABEL.test(t));

    // A label counts only on its own, so "Total gas bill" stays a transaction.
    if (label) {
      // A summary figure that cannot be used is listed as unread. Without a date
      // the line cannot be a transaction, so it never explains a balance gap.
      const dated = parseDate(read('date')) !== null;
      const unread = (reason) =>
        rejected.push({ row: rowNumber, reason, raw: JSON.stringify(record), summary: !dated });
      const figures = {};
      let unreadable = false;
      for (const field of ['debit', 'credit', 'amount', 'fee', 'balance']) {
        const raw = read(field);
        if (isBlank(raw)) continue;
        const value = parseAmount(raw);
        if (Number.isNaN(value)) unreadable = true;
        else figures[field] = value;
      }
      const found = {};
      if (OPENING_LABEL.test(label)) {
        found.openingBalance = figures.balance ?? figures.amount;
      } else {
        found.totalDebit = figures.debit;
        found.totalCredit = figures.credit;
        found.closingBalance = figures.balance;
        if (figures.amount !== undefined) {
          const field = /debit|withdrawal/i.test(label) ? 'totalDebit'
            : /credit|deposit/i.test(label) ? 'totalCredit'
              : /balance/i.test(label) ? 'closingBalance' : null;
          if (field && found[field] === undefined) found[field] = figures.amount;
          else unreadable = true;
        }
      }
      const usable = Object.entries(found).filter(([, value]) => value !== undefined);
      let conflict = false;
      for (const [field, value] of usable) {
        if (printed[field] === undefined) printed[field] = value;
        else if (Math.abs(printed[field] - value) > 0.001) {
          conflicting.add(field);
          conflict = true;
        }
      }
      if (unreadable) unread('Unreadable summary figure');
      else if (conflict) unread('Summary figure conflicts with an earlier one');
      else if (dated && !usable.length) unread('Summary line without a readable figure');
      return;
    }

    const reject = (reason) => rejected.push({ row: rowNumber, reason, raw: JSON.stringify(record) });
    const date = parseDate(read('date'));
    if (!date) return reject('Unreadable date');
    const balance = parseAmount(read('balance'));
    if (isBlank(read('balance')) || Number.isNaN(balance)) return reject('Unreadable balance');

    let debit = 0;
    let credit = 0;
    let signed = null;
    if (col.debit && col.credit) {
      debit = parseAmount(read('debit'));
      credit = parseAmount(read('credit'));
    } else {
      const value = parseAmount(read('amount'));
      const amount = Math.abs(value);
      const direction = String(read('direction') ?? '').trim();
      if (CREDIT_WORDS.test(direction)) credit = amount;
      else if (DEBIT_WORDS.test(direction)) debit = amount;
      else return reject(`Unknown transaction type "${direction}"`);
      if (value < 0) signed = { side: credit ? 'credit' : 'debit', amount };
    }
    const fee = Math.abs(parseAmount(read('fee')));
    if ([debit, credit, fee].some(Number.isNaN)) return reject('Unreadable amount');
    debit = round2(debit + fee);
    if (debit === 0 && credit === 0) return reject('No debit or credit amount');
    if (signed) minus.set(rowNumber, signed);

    transactions.push({
      row: rowNumber,
      date,
      description: description || '(no description)',
      debit,
      credit,
      balance,
      reference: String(read('reference') ?? '').trim(),
    });
  });

  // Two different printed values for one figure: neither can be relied on.
  for (const [field, value] of Object.entries(printed)) {
    if (field !== 'openingBalance' && !conflicting.has(field)) stated[field] = value;
  }
  const openingBalance = conflicting.has('openingBalance') ? null : printed.openingBalance ?? null;

  const ordered = col.debit && col.credit
    ? oldestFirst(normaliseColumnSigns(transactions), openingBalance)
    : applyReversalSigns(oldestFirst(transactions, openingBalance), minus, openingBalance);
  return { transactions: ordered, rejected, openingBalance, stated };
}

// --- exports ---
module.exports = { toAsciiDigits, parseAmount, parseDate, mapHeaders, parseRows, isBlank, optionalAmount, oldestFirst, normaliseColumnSigns };
