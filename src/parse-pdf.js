/**
 * File      : src/parse-pdf.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Reads the text of a PDF statement, including multi-line rows, reversals and the printed summary.
 * n8n node  : Parse Transactions
 * Flow      : File Type -> Extract PDF -> PDF Has Text? -> [Parse Transactions] -> Parsed OK?
 */
// Reads the text that n8n's "Extract From File" node returns for a text PDF.
// One transaction may be spread over several lines:
//   03-01-2026 NEFT SALARY CREDIT
//   ACME PRIVATE LTD
//   120,000.00 204,913.55            <- amount(s) and balance
// Other banks print the amounts first and the description after them.
// The text does not keep column positions, so when a line has only an amount
// and a balance, debit or credit is decided by how the balance moved. When both
// columns are printed (one as 0.00), the column order is learned from the whole
// statement and then applied to every row, so a wrong column is still caught.
// --- imports ---
const { round2 } = require('./util');
const { toAsciiDigits, parseAmount, parseDate, oldestFirst, normaliseColumnSigns } = require('./parse');
// --- end imports ---

const DATE = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})|\d{1,2}[ -][A-Za-z]{3}[ -](?:\d{4}|\d{2}))`;
const RECORD_START = new RegExp(`^(${DATE})(?:\\s+(.*))?$`);
const PERIOD = new RegExp(`(${DATE})\\s*(?:to|-|–|—)\\s*(${DATE})`, 'i');
const MONEY = String.raw`\(?-?(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2}\)?(?:CR|DR)?`;
const MONEY_TOKEN = new RegExp(`^${MONEY}$`, 'i');
// Two amounts printed with no space between them.
const GLUED = new RegExp(`(\\.\\d{2})(?=${MONEY}(?:\\s|$))`, 'gi');

const STATED_LABELS = [
  ['openingBalance', /^(openingbalance|balancebroughtforward|broughtforward|balanceb\/f)/],
  ['closingBalance', /^(closingbalance|endingbalance|finalbalance|balancecarriedforward|balancec\/f)/],
  ['totalCredit', /^total(credits?|deposits?)(?![a-z])|^total(credits?|deposits?)(amount|inr|bdt)/],
  ['totalDebit', /^total(debits?|withdrawals?)(?![a-z])|^total(debits?|withdrawals?)(amount|inr|bdt)/],
];
const SUMMARY_LINE = /^(total|subtotal|grandtotal|closing|opening|summary|pagetotal)/;
// A totals row that has no other words, such as "Grand Total:".
const BARE_TOTAL = /^(sub|grand|page)?-?(totals?|closing|opening|summary)(balance|amount)?(\((bdt|inr|usd|tk\.?)\))?:?$/;
// Counts the summary labels in a piece of text.
const ANY_LABEL = /openingbalance|closingbalance|endingbalance|finalbalance|broughtforward|carriedforward|balance[bc]\/f|total(credit|deposit|debit|withdrawal)/g;
// A narration line such as "24-11-26 10:15:22" is a timestamp, not a new row.
const TIME_FIRST = /^\d{1,2}:\d{2}/;
// Page furniture ends a description.
const PAGE_BREAK = /^(page\s*\d+\s*of\s*\d+|©|date\s+(narration|description|particulars|details))|page\s+\d+\s+of\s+\d+$/i;
const MAX_TRAILING_DESCRIPTION_LINES = 6;
const BARE_AMOUNT = new RegExp(`^(?:(?:BDT|INR|USD|Tk\\.?|\u09F3)\\s*)?(${MONEY})$`, 'i');

const LONG_DATE = /\d{1,2}[ -][A-Za-z]{3,9}[ ,-]+\d{4}|[A-Za-z]{3,9} \d{1,2},? \d{4}/g;
const ANY_DATE = new RegExp(DATE, 'g');
// Digits written like money, including forms the reader cannot parse.
const LOOSE_MONEY = /\d\.\d{1,2}(?![\d.])|\d,\d{3}(?!\d)|\d\.\d{3},\d{2}/;
const withoutDates = (text) =>
  text.replace(ANY_DATE, ' ').replace(LONG_DATE, ' ').replace(/page\s*\d+(\s*of\s*\d+)?/gi, ' ');
const looseTokens = (text) =>
  withoutDates(text).split(/\s+/).filter((t) => LOOSE_MONEY.test(t) && !t.endsWith('%'));
// A whole number of this many digits at the end of a line may be a figure.
const endsInNumber = (text, digits) => {
  const last = withoutDates(text).trim().split(/\s+/).pop();
  const match = last.match(/^[^\d]{0,4}(\d+)[^\d]{0,4}$/);
  return Boolean(match && match[1].length >= digits && match[1].length < 10);
};
// True when a summary line shows a figure that was not understood.
const unreadFigure = (line) => {
  const loose = looseTokens(line.replace(GLUED, '$1 '));
  return loose.some((t) => !MONEY_TOKEN.test(t)) || (!moneyIn(line).length && endsInNumber(line, 1));
};
// True when a dated line that never became a transaction seems to show money.
const showsMoney = (text) =>
  looseTokens(text).length > 0 || /(?:^|\s)\d{2,9}\s+\d{2,9}\D{0,5}$/.test(withoutDates(text).trim());

// Letter-spaced headings such as "O P E N I N G" compare equal once collapsed.
const collapse = (line) => line.replace(/\s+/g, '').toLowerCase();

const moneyIn = (line) => line.split(/\s+/).filter((t) => MONEY_TOKEN.test(t));

// Balances that banks print for information only. They need not match any row.
const INFORMATIONAL = /available|current|average|uncleared|lien|hold|limit|minimum|requirement|insur|rate/i;
// "100/-" and "11,400.50/-" become ordinary amounts before anything is read.
const SLASH_DASH = /(\d(?:[\d,]*\d)?)(\.\d{1,2})?\s?\/[-=](?![\w/])/g;
const plainAmounts = (line) =>
  toAsciiDigits(line).replace(SLASH_DASH, (_, whole, decimals) => whole + (decimals ? decimals.padEnd(3, '0') : '.00'));

// Splits "text 1,000.00 5,000.00 CR" into text, amounts and the CR/DR marker.
function splitAmounts(line) {
  const tokens = line.replace(GLUED, '$1 ').split(/\s+/).filter(Boolean);
  let marker = null;
  if (/^(cr|dr)$/i.test(tokens[tokens.length - 1] || '')) marker = tokens.pop().toUpperCase();
  const amounts = [];
  while (tokens.length && (MONEY_TOKEN.test(tokens[tokens.length - 1]) || tokens[tokens.length - 1] === '-')) {
    amounts.unshift(tokens.pop());
  }
  return { text: tokens.join(' '), amounts, marker };
}

const amountCount = (line) => splitAmounts(line).amounts.filter((a) => a !== '-').length;

// Pairs each figure on a summary line with the text before it. A CR or DR
// printed after a figure belongs to that figure. `assignable` is true only when
// every figure has exactly one label of its own and no label is left without one.
function readSummary(line) {
  const pairs = [];
  let words = [];
  for (const token of line.replace(GLUED, '$1 ').split(/\s+/).filter(Boolean)) {
    if (MONEY_TOKEN.test(token)) {
      pairs.push({ text: words.join(' '), value: parseAmount(token) });
      words = [];
    } else if (/^(cr|dr)$/i.test(token) && !words.length && pairs.length) {
      const pair = pairs[pairs.length - 1];
      if (token.toUpperCase() === 'DR') pair.value = -Math.abs(pair.value);
    } else words.push(token);
  }
  const labelCount = (text) => (collapse(text).match(ANY_LABEL) || []).length;
  for (const pair of pairs) {
    const key = collapse(pair.text).replace(/^[^a-z]+/, '').replace(/^(bdt|inr|usd|tk)[^a-z]*/, '');
    const found = STATED_LABELS.find(([, pattern]) => pattern.test(key));
    pair.label = found && labelCount(pair.text) <= 1 ? found[0] : null;
  }
  const assignable = pairs.length > 0 && pairs.every((p) => p.label) && !labelCount(words.join(' '));
  return { pairs, assignable, labels: labelCount(line) };
}

// Some banks end with a block of labels whose figures sit elsewhere in the text,
// in an order that need not match the labels. Collect both; validate.js matches
// them against our own totals.
function findDetachedSummary(lines) {
  const trimmed = lines.map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < trimmed.length; i += 1) {
    const labels = [];
    let j = i;
    while (j < trimmed.length && !moneyIn(trimmed[j]).length) {
      const label = STATED_LABELS.find(([, pattern]) => pattern.test(collapse(trimmed[j])));
      if (!label) break;
      labels.push(label[0]);
      j += 1;
    }
    if (labels.length < 2) continue;
    const bare = (from, step) => {
      const values = [];
      for (let k = from; k >= 0 && k < trimmed.length && values.length < labels.length; k += step) {
        const match = trimmed[k].match(BARE_AMOUNT);
        if (!match) break;
        values.push(parseAmount(match[1]));
      }
      return values;
    };
    const before = bare(i - 1, -1).reverse();
    const values = before.length === labels.length ? before : bare(j, 1);
    if (values.length === labels.length) return { labels, values };
    i = j;
  }
  return null;
}

function collectRecords(lines) {
  const records = [];
  const stray = [];
  const stated = {};
  const detached = findDetachedSummary(lines);
  if (detached) stated.detached = detached;
  let open = null; // record still waiting for its amounts
  let last = null; // most recently completed record
  const totalsRows = []; // bare totals rows, checked once the entries are known
  const used = new Set(); // later lines already taken as the figure of a label
  const unusedBalances = [];
  const isDetachedFigure = (line) => {
    const match = detached && line.match(BARE_AMOUNT);
    return Boolean(match) && detached.values.includes(parseAmount(match[1]));
  };

  const report = (index, raw, reason) => stray.push({ row: index + 1, reason, raw });
  const printed = {}; // every printed copy of each summary figure, in order
  const keep = (key, value, index) => {
    if (detached && detached.labels.includes(key)) return;
    (printed[key] = printed[key] || []).push({ value, row: index + 1, raw: lines[index].trim(), after: records.length });
    if (stated[key] === undefined) stated[key] = value;
  };

  // A dated line that never gets any amount is a heading or a date in the page
  // header. One that has an amount but no balance may be a damaged row.
  const abandon = () => {
    const text = open ? [open.rest, ...open.description].join(' ').trim() : '';
    if (open && (open.amounts.some((a) => a !== '-') || showsMoney(text) || (text && endsInNumber(text, 3)))) {
      stray.push({ row: open.line, reason: 'Dated line without an amount and a balance', raw: open.raw });
    }
    open = null;
  };
  const stopDescription = () => {
    if (last) last.accepting = false;
  };

  const feed = (record, part, index) => {
    const { text, amounts, marker } = splitAmounts(part);
    record.amounts.push(...amounts);
    if (marker) record.marker = marker;
    if (text) record.description.push(text);
    if (record.amounts.filter((a) => a !== '-').length >= 2) {
      // Money left inside the description may be a damaged row that was absorbed.
      if (looseTokens(record.description.join(' ')).length >= 2) {
        report(index, lines[index].trim(), 'Line with amounts that could not be read');
      }
      records.push(record);
      // Amounts directly after the date: the description is still to come.
      last = { record, accepting: record.description.length === 0, taken: 0 };
      open = null;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const key = collapse(line);

    // A line with an amount and a balance is never skipped as a heading.
    const count = amountCount(line);

    // A dated line is page furniture only when nothing but the page number follows.
    const datedText = (line.match(RECORD_START) || [])[2];
    const onlyFurniture = datedText === undefined || /^(page\s*\d+\s*of\s*\d+)?$/i.test(datedText);
    if (PAGE_BREAK.test(line) && count < 2 && onlyFurniture) {
      if (looseTokens(line).length >= 2) report(i, line, 'Line with amounts that could not be read');
      stopDescription();
      continue;
    }

    if (STATED_LABELS.some(([, pattern]) => pattern.test(key))) {
      const summary = readSummary(line);
      // "Total Deposit 100.00 99,999.00" may be the second line of a transaction.
      if (open && count >= 2 && !summary.assignable) {
        feed(open, line, i);
        continue;
      }
      // "Total Deposit 100.00" with the balance alone on the next line.
      if (open && !open.amounts.length && count === 1 && BARE_AMOUNT.test((lines[i + 1] || '').trim())) {
        feed(open, line, i);
        continue;
      }
      abandon();
      stopDescription();
      const garbled = unreadFigure(line);
      if (garbled) report(i, line, 'Summary line with a figure that could not be read');
      if (summary.assignable) {
        summary.pairs.forEach((p) => keep(p.label, p.value, i));
      } else if (summary.pairs.length) {
        if (!garbled) report(i, line, 'Summary line whose figures could not be assigned');
      } else if (!garbled) {
        // No figure here: it may be on the line after the label.
        const below = (lines[i + 1] || '').trim();
        const next = readSummary(below).pairs;
        const figureOnly = /^\D{0,5}\d[\d.,]*\D{0,5}$/.test(below) && !parseDate(below);
        if (!next.length && figureOnly && unreadFigure(below)) {
          report(i + 1, below, 'Summary line with a figure that could not be read');
        }
        if (next.length === 1) used.add(i + 1);
        if (next.length === 1 && !detached) {
          if (summary.labels > 1) report(i, line, 'Summary line whose figures could not be assigned');
          else keep(STATED_LABELS.find(([, pattern]) => pattern.test(key))[0], next[0].value, i);
        }
      }
      continue;
    }

    const start = line.match(RECORD_START);
    const dated = Boolean(start && parseDate(start[1]));

    // A dated row may mention a period too; only a period at its start is a header.
    const period = line.match(PERIOD);
    if (period && count < 2 && !(open && count) && (!dated || period.index === 0) && looseTokens(line).length < 2 &&
        (/period|from/i.test(line) || period[0].length === line.length)) {
      const from = parseDate(period[1]);
      const to = parseDate(period[2]);
      if (from && to && stated.periodStart === undefined) Object.assign(stated, { periodStart: from, periodEnd: to });
      stopDescription();
      continue;
    }

    if (dated && !TIME_FIRST.test(start[2] || '')) {
      const rest = start[2] || '';
      const restKey = collapse(rest);
      const inTable = STATED_LABELS.find(([, pattern]) => pattern.test(restKey));
      abandon();
      stopDescription();
      if (inTable) {
        const summary = readSummary(rest);
        if (summary.assignable) {
          if (unreadFigure(rest)) report(i, line, 'Summary line with a figure that could not be read');
          summary.pairs.forEach((p) => keep(p.label, p.value, i));
          continue;
        }
        const row = splitAmounts(rest);
        const figures = row.amounts.map((v) => (v === '-' ? 0 : parseAmount(v)));
        const balanceRow = /Balance$/.test(inTable[0]) && figures.length > 1 && figures.slice(0, -1).every((v) => v === 0);
        if (balanceRow) {
          const value = figures[figures.length - 1];
          keep(inTable[0], row.marker === 'DR' ? -Math.abs(value) : value, i);
          continue;
        }
        // With an amount and a balance it is read as a transaction below.
        if (amountCount(rest) < 2) {
          if (summary.pairs.length || unreadFigure(rest)) {
            report(i, line, 'Summary line whose figures could not be assigned');
          }
          continue;
        }
      }
      open = { line: i + 1, raw: line, rest: '', date: parseDate(start[1]), description: [], amounts: [], marker: null };
      if (rest) feed(open, rest, i);
      continue;
    }

    if (/^(cr|dr)$/i.test(line) && last) {
      last.record.marker = line.toUpperCase();
      continue;
    }
    if (SUMMARY_LINE.test(key)) {
      const { text, amounts } = splitAmounts(line);
      const bare = BARE_TOTAL.test(collapse(text));
      // After a dated row, "TOTAL FUEL STATION 100.00 900.00" continues that row.
      if (open && !bare) {
        feed(open, line, i);
        continue;
      }
      abandon();
      stopDescription();
      if (count < 2 && (count === 1 || looseTokens(line).length || (/^(total|grandtotal|closing|opening)/.test(key) && endsInNumber(line, 3)))) {
        report(i, line, 'Summary line with a figure that could not be read');
      }
      if (count >= 2) {
        const figures = amounts.filter((a) => a !== '-').map(parseAmount);
        if (bare) totalsRows.push({ row: i + 1, raw: line, figures });
        else report(i, line, 'Line with amounts that could not be read as a transaction or a summary');
      }
      continue;
    }
    if (open) {
      feed(open, line, i);
      continue;
    }
    // Money outside any transaction could be a lost row: report it.
    const summaryWords = (key.match(ANY_LABEL) || []).length > 0;
    if (amountCount(line) >= 2 || looseTokens(line).length >= 2 ||
        (summaryWords && (count || looseTokens(line).length))) {
      stray.push({ row: i + 1, reason: 'Line with amounts that is not part of a dated transaction', raw: line });
      stopDescription();
      continue;
    }
    if (last && last.accepting) {
      if (BARE_AMOUNT.test(line) || last.taken >= MAX_TRAILING_DESCRIPTION_LINES) stopDescription();
      else {
        last.record.description.push(line);
        last.taken += 1;
        continue;
      }
    }
    // Nothing used this line. It is suspect if it looks like a damaged row (it
    // starts with a date, even an impossible one) or states a balance.
    if (!used.has(i) && !isDetachedFigure(line) && looseTokens(line).length) {
      if (RECORD_START.test(line)) report(i, line, 'Line with an amount that was not used');
      else if (/balance|\bbal\b/i.test(line) && !INFORMATIONAL.test(line)) unusedBalances.push({ index: i, line });
    }
  }
  abandon();
  // A stated balance is accepted if it is a balance the entries actually reach.
  const reached = new Set(records.flatMap((r) => [Math.abs(signedBalance(r))]));
  for (const { index, line } of unusedBalances) {
    const figures = moneyIn(line.replace(GLUED, '$1 ')).map((v) => Math.abs(parseAmount(v)));
    const closing = records.length ? [records[0], records[records.length - 1]].map((r) => Math.abs(signedBalance(r))) : [];
    const accepted = figures.length > 0 && figures.every((f) => closing.some((c) => Math.abs(c - f) <= 0.01) && reached.has(f));
    if (!accepted) report(index, line, 'Line with an amount that was not used');
  }
  return { records, stray, stated, totalsRows, printed };
}

// A bare totals row is understood only if it shows both entry totals (and
// possibly the last balance). Anything else is reported as unread.
function unexplainedTotals(totalsRows, transactions) {
  const total = (side) => round2(transactions.reduce((acc, t) => acc + t[side], 0));
  const expected = [total('debit'), total('credit'), transactions[transactions.length - 1]?.balance];
  return totalsRows.filter(({ figures }) => {
    if (figures.length !== 2 && figures.length !== 3) return true;
    const left = [...figures];
    return !expected.slice(0, figures.length).every((value) => {
      const at = left.findIndex((f) => Math.abs(f - value) <= 0.01);
      if (at >= 0) left.splice(at, 1);
      return at >= 0;
    });
  }).map(({ row, raw }) => ({ row, raw, reason: 'Summary line whose figures could not be assigned' }));
}

// How many printed totals disagree with these entries.
function summaryMisses(transactions, stated) {
  const total = (side) => round2(transactions.reduce((acc, t) => acc + t[side], 0));
  const calculated = { totalCredit: total('credit'), totalDebit: total('debit') };
  const near = (a, b) => Math.abs(a - b) <= 0.01;
  let misses = Object.keys(calculated).filter((k) => stated[k] !== undefined && !near(stated[k], calculated[k])).length;
  if (stated.detached) {
    const first = transactions[0];
    calculated.openingBalance = round2(first.balance - first.credit + first.debit);
    calculated.closingBalance = transactions[transactions.length - 1].balance;
    const left = [...stated.detached.values];
    for (const label of stated.detached.labels) {
      const at = left.findIndex((v) => near(v, calculated[label]));
      if (at >= 0) left.splice(at, 1);
      else misses += 1;
    }
  }
  return misses;
}

// With no opening balance the first direction is only a guess from the wording.
// Take the other direction when it agrees better with the printed totals. With
// no totals nothing depends on the guess, because the opening balance is derived.
function resolveFirstDirection(transactions, stated) {
  const [first, ...others] = transactions;
  const swapped = [{ ...first, debit: first.credit, credit: first.debit }, ...others];
  const misses = (list) => summaryMisses(normaliseColumnSigns(list), stated);
  return misses(swapped) < misses(transactions) ? swapped : transactions;
}

// For rows that print both columns, decide once which of the two is the debit.
// Returns 'debit-first', 'credit-first', or null if the statement does not show it.
function learnColumnOrder(records, openingBalance) {
  let debitFirst = 0;
  let creditFirst = 0;
  let previous = openingBalance;
  for (const record of records) {
    const values = record.amounts.slice(-3).map((v) => (v === '-' ? 0 : parseAmount(v)));
    const balance = signedBalance(record);
    if (values.length === 3 && previous !== null) {
      const [a, b] = values;
      if (a !== b && Math.abs(round2(previous - a + b - balance)) <= 0.01) debitFirst += 1;
      if (a !== b && Math.abs(round2(previous + a - b - balance)) <= 0.01) creditFirst += 1;
    }
    previous = balance;
  }
  const votes = debitFirst + creditFirst;
  if (votes < 3) return null;
  if (debitFirst / votes >= 0.8) return 'debit-first';
  if (creditFirst / votes >= 0.8) return 'credit-first';
  return null;
}

function signedBalance(record) {
  const value = parseAmount(record.amounts[record.amounts.length - 1]);
  return record.marker === 'DR' ? -Math.abs(value) : value;
}

const near = (a, b) => Math.abs(a - b) <= 0.01;
const conflict = ({ row, raw }) => ({ row, raw, reason: 'Conflicting copies of a printed summary figure' });

// Opening and closing balances printed more than once must chain: each copy is
// the balance reached where it is printed, or repeats the statement's own
// opening or final balance. Otherwise none of them can be trusted.
function settleBalances(printed, stated, records) {
  const unread = [];
  const final = records.length ? signedBalance(records[records.length - 1]) : null;
  for (const key of ['openingBalance', 'closingBalance']) {
    const copies = printed[key] || [];
    if (copies.every((c) => near(c.value, copies[0].value))) continue;
    const head = key === 'openingBalance' && copies[0].after === 0 ? copies[0] : null;
    const chains = (c) => (c.after > 0 && near(c.value, signedBalance(records[c.after - 1]))) ||
      (key === 'closingBalance' ? near(c.value, final) : Boolean(head) && near(c.value, head.value));
    const broken = copies.filter((c) => c !== head && !chains(c));
    delete stated[key];
    if (broken.length) unread.push(...copies.map(conflict));
    else if (head) stated[key] = head.value;
    else if (key === 'closingBalance') {
      const end = copies.filter((c) => c.after === records.length || near(c.value, final)).pop();
      if (end) stated[key] = end.value;
    }
  }
  return unread;
}

// Totals printed more than once may be per page, carried forward, or repeats of
// the statement total.
function settleTotals(printed, stated, transactions) {
  const unread = [];
  for (const [key, side] of [['totalCredit', 'credit'], ['totalDebit', 'debit']]) {
    const copies = printed[key] || [];
    if (copies.length < 2) continue;
    const total = (from, to) => round2(transactions
      .filter((t) => t.row > from && t.row < to).reduce((acc, t) => acc + t[side], 0));
    const grand = total(0, Infinity);
    const same = copies.every((c) => near(c.value, copies[0].value));
    if (same && near(copies[0].value, grand)) {
      stated[key] = copies[0].value;
      continue;
    }
    let from = 0;
    let covered = 0;
    let pages = true;
    for (const copy of copies) {
      if (near(copy.value, total(from, copy.row))) covered = round2(covered + copy.value);
      else if (near(copy.value, total(0, copy.row))) covered = copy.value;
      else {
        if (!near(copy.value, grand)) pages = false;
        continue;
      }
      from = copy.row;
    }
    if (pages && (near(covered, grand) || copies.some((c) => near(c.value, grand)))) stated[key] = grand;
    else if (same) stated[key] = copies[0].value; // one wrong total, repeated
    else {
      delete stated[key];
      unread.push(...copies.map(conflict));
    }
  }
  return unread;
}

// Newest-first statements are reversed. When all rows share one date, the
// printed amounts and opening and closing balances show which way they run.
function orderRecords(records, openingBalance, closingBalance) {
  if (records[0].date !== records[records.length - 1].date) return oldestFirst(records);
  const breaks = (list) => list.filter((record, i) => {
    const previous = i === 0 ? openingBalance : signedBalance(list[i - 1]);
    if (previous === null) return false;
    const moved = Math.abs(signedBalance(record) - previous);
    const values = record.amounts.slice(0, -1).map((v) => (v === '-' ? 0 : Math.abs(parseAmount(v))));
    if (values.length >= 2) values.push(Math.abs(values[values.length - 1] - values[values.length - 2]));
    return !values.some((v) => near(v, moved));
  }).length + (closingBalance !== null && !near(signedBalance(list[list.length - 1]), closingBalance) ? 1 : 0);
  const reversed = [...records].reverse();
  return breaks(reversed) < breaks(records) ? reversed : records;
}

const CREDIT_HINT = /\b(cr|credit|deposit|salary|received|inward|refund)\b/i;

function parsePdfText(text) {
  const { records, stray, stated, totalsRows, printed } =
    collectRecords(String(text || '').split(/\r?\n/).map(plainAmounts));
  if (records.length < 2) {
    throw new Error(
      'LAYOUT_NOT_SUPPORTED: fewer than 2 transactions were recognised. Supported rows start with a date ' +
        'and end with an amount and a balance.',
    );
  }

  const rejected = [...stray, ...settleBalances(printed, stated, records)];
  const openingBalance = stated.openingBalance ?? null;
  // Repeated totals are settled once the direction of every entry is known.
  for (const key of ['totalCredit', 'totalDebit']) {
    if ((printed[key] || []).length > 1) delete stated[key];
  }
  const transactions = [];
  let assumedFirstDirection = false;
  let guessedFirstRow = false;
  const ordered = orderRecords(records, openingBalance, stated.closingBalance ?? null);
  const columnOrder = learnColumnOrder(ordered, openingBalance);
  // In some single-amount layouts the minus sign itself means "debit". If any
  // unsigned amount lowers the balance, the sign does not carry that meaning.
  const unsignedDebits = ordered.some((record, i) => {
    const values = record.amounts.slice(-3);
    return i > 0 && values.length === 2 && values[0] !== '-' && parseAmount(values[0]) > 0 &&
      signedBalance(record) < signedBalance(ordered[i - 1]);
  });

  for (const record of ordered) {
    const values = record.amounts.slice(-3);
    const balance = signedBalance(record);
    const description = record.description.join(' ').slice(0, 300) || '(no description)';
    const previous = transactions.length ? transactions[transactions.length - 1].balance : openingBalance;
    // Printed columns keep their sign: a negative debit is a reversal.
    const columns = values.slice(0, -1).map((v) => (v === '-' ? 0 : parseAmount(v)));
    const moved = columns.filter((v) => v !== 0);

    let debit = 0;
    let credit = 0;
    if (columns.length === 2 && columnOrder) {
      [debit, credit] = columnOrder === 'debit-first' ? columns : [columns[1], columns[0]];
    } else if (moved.length === 2) {
      // Both columns filled: keep the order that explains the balance.
      const [a, b] = moved;
      const firstIsDebit = previous === null || Math.abs(previous - a + b - balance) <= 0.01;
      [debit, credit] = firstIsDebit ? [a, b] : [b, a];
    } else if (moved.length === 1 && moved[0] < 0 && previous !== null &&
        Math.abs(round2(previous - moved[0] - balance)) <= 0.01) {
      debit = moved[0]; // negative amount, balance rose: a reversed debit
    } else if (moved.length === 1 && moved[0] < 0 && unsignedDebits && previous !== null &&
        Math.abs(round2(previous + moved[0] - balance)) <= 0.01) {
      credit = moved[0]; // negative amount, balance fell: a reversed credit
    } else if (moved.length === 1) {
      const amount = Math.abs(moved[0]);
      let isCredit;
      if (previous === null) {
        isCredit = CREDIT_HINT.test(description);
        assumedFirstDirection = true;
        if (!transactions.length) guessedFirstRow = true;
      } else if (Math.abs(round2(previous + amount - balance)) <= 0.01) isCredit = true;
      else if (Math.abs(round2(previous - amount - balance)) <= 0.01) isCredit = false;
      // Neither fits: take the direction of travel; the balance check reports it.
      else isCredit = balance >= previous;
      if (isCredit) credit = amount;
      else debit = amount;
    }
    if (debit === 0 && credit === 0) {
      rejected.push({ row: record.line, reason: 'No transaction amount', raw: record.raw });
      continue;
    }
    transactions.push({ row: record.line, date: record.date, description, debit, credit, balance, reference: '' });
  }

  const resolved = normaliseColumnSigns(
    guessedFirstRow ? resolveFirstDirection(transactions, stated) : transactions,
  );
  rejected.push(...settleTotals(printed, stated, resolved));
  if (resolved.length) rejected.push(...unexplainedTotals(totalsRows, resolved));
  rejected.sort((a, b) => a.row - b.row);

  return {
    transactions: resolved,
    rejected, openingBalance, stated, assumedFirstDirection, columnOrder,
  };
}

// --- exports ---
module.exports = { parsePdfText };
