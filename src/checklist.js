/**
 * File      : src/checklist.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : The statement checker rules. Each check ends as OK, DISCREPANCY or NA.
 * n8n node  : Run Checklist
 * Flow      : Find Earlier Submissions -> [Run Checklist] -> AI Review Requested?
 */
// The verification checklist, examined section by section. Each item ends as
// OK, DISCREPANCY or NA, and states the rule it was checked against.
// Severity of a discrepancy: HIGH = fault, MEDIUM = review, LOW = information.
// --- imports ---
const { round2, sum, toDay, formatMoney } = require('./util');
const { TOLERANCE } = require('./validate');
// --- end imports ---

const MAX_GAP_DAYS = 31;

const ok = (remarks) => ({ status: 'OK', remarks });
const na = (remarks) => ({ status: 'NA', remarks });
const bad = (remarks, rows = [], severity) => ({ status: 'DISCREPANCY', remarks, rows, severity });

// Compares a figure printed on the statement with the figure we calculated.
function matchFigure(label, printed, calculated, calculatedLabel) {
  if (printed === null) return na(`The statement prints no ${label}.`);
  const difference = round2(printed - calculated);
  return Math.abs(difference) <= TOLERANCE
    ? ok(`Printed ${label} ${formatMoney(printed)} matches ${calculatedLabel}.`)
    : bad(
      `Printed ${label} is ${formatMoney(printed)} but ${calculatedLabel} is ${formatMoney(calculated)} ` +
        `(difference ${formatMoney(difference)}).`,
    );
}

const SECTIONS = [
  {
    key: 'A',
    name: 'Reading completeness',
    items: [
      {
        sn: 'A001', parameter: 'Every transaction line was read', severity: 'MEDIUM',
        // Failing to read a line is our limitation, not proof of a fault in the statement.
        rule: 'A line that cannot be read means the statement is not fully verified. Above 20% the result is INCONCLUSIVE.',
        check: ({ validation: v }) => {
          if (!v.rejectedRows) return ok(`${v.parsedRows} of ${v.totalRows} lines read.`);
          return bad(`${v.rejectedRows} of ${v.totalRows} lines could not be read. See unreadLines.`);
        },
      },
      {
        sn: 'A002', parameter: 'Each entry is either a debit or a credit', severity: 'MEDIUM',
        rule: 'One line must not carry both a debit and a credit.',
        check: ({ transactions }) => {
          const both = transactions.filter((t) => t.debit !== 0 && t.credit !== 0);
          return both.length
            ? bad(`${both.length} line(s) carry both a debit and a credit.`, both.map((t) => t.row))
            : ok('No line carries both.');
        },
      },
      {
        sn: 'A003', parameter: 'An opening balance is printed', severity: 'LOW',
        rule: 'Without an opening balance the first transaction cannot be checked.',
        check: ({ validation: v }) =>
          v.stated.openingBalance === null
            ? na('No opening balance found; it was derived from the first row, which is therefore unchecked.')
            : ok(`Opening balance ${formatMoney(v.stated.openingBalance)}.`),
      },
    ],
  },
  {
    key: 'B',
    name: 'Arithmetic accuracy',
    items: [
      {
        sn: 'B001', parameter: 'Every running balance is correct', severity: 'HIGH',
        rule: 'Previous balance + credit - debit must equal the new balance, within 0.01.',
        check: ({ validation: v }) => {
          if (!v.balanceChecks) return na('There is no pair of balances to compare.');
          if (!v.mismatches.length) return ok(`All ${v.balanceChecks} balance calculations are correct.`);
          const x = v.mismatches[0];
          return bad(
            `${v.mismatches.length} fault(s) in ${v.balanceChecks} calculations. First: row ${x.row} (${x.date}), ` +
              `expected ${formatMoney(x.expectedBalance)}, shown ${formatMoney(x.shownBalance)}. See faults.`,
            v.mismatches.map((y) => y.row),
          );
        },
      },
      {
        sn: 'B002', parameter: 'Opening + credits - debits gives the closing balance', severity: 'HIGH',
        rule: 'The sum of all entries must lead from the opening balance to the closing balance.',
        check: ({ validation: v }) => {
          const t = v.totals;
          const printed = v.stated.closingBalance;
          const target = printed === null ? t.lastRowBalance : printed;
          const difference = round2(target - t.calculatedClosingBalance);
          const sum1 = `${formatMoney(t.openingBalance)} + ${formatMoney(t.totalCredit)} - ${formatMoney(t.totalDebit)} = ` +
            formatMoney(t.calculatedClosingBalance);
          return Math.abs(difference) <= TOLERANCE
            ? ok(`${sum1}.`)
            : bad(`${sum1}, but the statement closes at ${formatMoney(target)} (difference ${formatMoney(difference)}).`);
        },
      },
      {
        sn: 'B003', parameter: 'Printed closing balance matches the last row', severity: 'HIGH',
        rule: 'The closing balance in the summary must equal the balance after the last transaction.',
        check: ({ validation: v }) =>
          matchFigure('closing balance', v.stated.closingBalance, v.totals.lastRowBalance, 'the last row balance'),
      },
      {
        sn: 'B004', parameter: 'Printed total credits matches the entries', severity: 'HIGH',
        rule: 'The printed credit total must equal the sum of all credit entries.',
        check: ({ validation: v }) =>
          matchFigure('total credit', v.stated.totalCredit, v.totals.totalCredit, 'the sum of credit entries'),
      },
      {
        sn: 'B005', parameter: 'Printed total debits matches the entries', severity: 'HIGH',
        rule: 'The printed debit total must equal the sum of all debit entries.',
        check: ({ validation: v }) =>
          matchFigure('total debit', v.stated.totalDebit, v.totals.totalDebit, 'the sum of debit entries'),
      },
      {
        sn: 'B006', parameter: 'No printed summary figure is left unexplained', severity: 'HIGH',
        rule: 'Every figure in the printed summary block must be explained by the transactions.',
        check: ({ validation: v }) => {
          const x = v.unmatchedSummary;
          if (!x) return ok('No unexplained summary figure.');
          return bad(
            `${x.figures.map((f) => `${f.label} should be ${formatMoney(f.calculated)}`).join('; ')}. ` +
              `Unexplained printed figures: ${x.printed.map(formatMoney).join(', ')}.`,
          );
        },
      },
    ],
  },
  {
    key: 'C',
    name: 'Dates and sequence',
    items: [
      {
        sn: 'C001', parameter: 'Transactions are in date order', severity: 'MEDIUM',
        rule: 'Dates must not go backwards within the statement.',
        check: ({ validation: v }) =>
          v.outOfOrder ? bad(`${v.outOfOrder} date(s) go backwards.`, v.outOfOrderRows) : ok('Dates are in order.'),
      },
      {
        sn: 'C002', parameter: 'All dates fall inside the printed period', severity: 'MEDIUM',
        rule: 'Every transaction must belong to the statement period.',
        check: ({ validation: v, transactions }) => {
          const { periodStart: from, periodEnd: to } = v.stated;
          if (!from) return na('The statement prints no period.');
          const outside = transactions.filter((t) => t.date < from || t.date > to);
          return outside.length
            ? bad(`${outside.length} entry(ies) outside ${from} to ${to}.`, outside.map((t) => t.row))
            : ok(`All entries are within ${from} to ${to}.`);
        },
      },
      {
        sn: 'C003', parameter: 'No transaction is dated in the future', severity: 'HIGH',
        rule: 'No transaction may be dated after the verification date.',
        check: ({ transactions, asOfDate }) => {
          const future = transactions.filter((t) => t.date > asOfDate);
          return future.length
            ? bad(`${future.length} entry(ies) dated after ${asOfDate}.`, future.map((t) => t.row))
            : ok(`No entry after ${asOfDate}.`);
        },
      },
      {
        sn: 'C004', parameter: 'No long silent period', severity: 'LOW',
        rule: `A gap of more than ${MAX_GAP_DAYS} days can mean missing pages.`,
        check: ({ validation: v, transactions }) => {
          const after = transactions.filter(
            (t, i) => i > 0 && toDay(t.date) - toDay(transactions[i - 1].date) > MAX_GAP_DAYS,
          );
          return after.length
            ? bad(`Longest gap is ${v.longestGapDays} days.`, after.map((t) => t.row))
            : ok(`Longest gap is ${v.longestGapDays} day(s).`);
        },
      },
    ],
  },
  {
    key: 'D',
    name: 'Duplicates and unusual entries',
    items: [
      {
        sn: 'D001', parameter: 'No transaction reference is reused', severity: 'MEDIUM',
        rule: 'One reference must not appear twice with the same amount.',
        check: ({ transactions, detections: d }) => {
          if (!transactions.some((t) => t.reference)) return na('The statement has no reference column.');
          return d.duplicateReferences.length
            ? bad(`Reused: ${d.duplicateReferences.map((r) => r.reference).slice(0, 5).join(', ')}.`,
              d.duplicateReferences.flatMap((r) => r.rows))
            : ok('No reference is reused.');
        },
      },
      {
        sn: 'D002', parameter: 'No identical same-day entries', severity: 'LOW',
        rule: 'Entries without a reference that match on date, text and amount need a look.',
        check: ({ detections: d }) =>
          d.repeatedEntryRows.length
            ? bad(`${d.repeatedEntryRows.length} entries look identical. These can be genuine.`, d.repeatedEntryRows)
            : ok('No identical entries.'),
      },
      {
        sn: 'D003', parameter: 'No amount far outside the usual range', severity: 'LOW',
        rule: 'An amount over 10 times the typical credit or debit is pointed out.',
        check: ({ detections: d }) => {
          if (d.outlierRows === null) return na('Too few entries to know what is usual.');
          return d.outlierRows.length
            ? bad(`${d.outlierRows.length} unusually large entry(ies).`, d.outlierRows)
            : ok('No unusual amount.');
        },
      },
      {
        sn: 'D004', parameter: 'Account is not overdrawn', severity: 'LOW',
        rule: 'The balance should not fall below zero.',
        check: ({ transactions }) => {
          const negative = transactions.filter((t) => t.balance < 0);
          return negative.length
            ? bad(`Balance is below zero on ${negative.length} row(s).`, negative.map((t) => t.row))
            : ok('The balance never goes below zero.');
        },
      },
      {
        sn: 'D005', parameter: 'No bounced or returned payments', severity: 'MEDIUM',
        rule: 'One returned payment is information; two or more need review.',
        check: ({ detections: d }) => {
          const count = d.bounceRows.length;
          return count
            ? bad(`${count} bounce-related entry(ies).`, d.bounceRows, count > 1 ? 'MEDIUM' : 'LOW')
            : ok('No returned payment.');
        },
      },
      {
        sn: 'D006', parameter: 'Reversal entries are accounted for', severity: 'LOW',
        rule: 'A negative amount in a debit or credit column is a reversal. It keeps its sign in every calculation.',
        check: ({ transactions }) => {
          const reversals = transactions.filter((t) => t.debit < 0 || t.credit < 0);
          return {
            ...ok(reversals.length
              ? `${reversals.length} reversal entry(ies) with negative amounts, included with their sign.`
              : 'No negative amounts.'),
            rows: reversals.map((t) => t.row),
          };
        },
      },
    ],
  },
  {
    key: 'E',
    name: 'Suspicious patterns',
    items: [
      {
        sn: 'E001', parameter: 'No unusual large deposit just before the end', severity: 'MEDIUM',
        rule: 'A deposit in the last 14 days that is at least half of monthly inflow and 4 times the typical credit must be explained.',
        check: ({ detections: d }) => {
          if (d.lateDeposits === null) return na('Not enough earlier history to compare with.');
          return d.lateDeposits.length
            ? bad(`${d.lateDeposits.length} deposit(s) totalling ${formatMoney(round2(sum(d.lateDeposits.map((x) => x.amount))))}. Verify the source.`,
              d.lateDeposits.map((x) => x.row))
            : ok('No unusual late deposit.');
        },
      },
      {
        sn: 'E002', parameter: 'No money moved in and straight out', severity: 'MEDIUM',
        rule: 'A large credit that leaves within 3 days at nearly the same amount must be explained.',
        check: ({ detections: d }) =>
          d.roundTrips.length
            ? bad(`${d.roundTrips.length} round trip(s) found.`, d.roundTrips.flatMap((p) => [p.creditRow, p.debitRow]))
            : ok('No round trip found.'),
      },
      {
        sn: 'E003', parameter: 'File was not submitted for another account holder', severity: 'HIGH',
        rule: 'The same statement file must not belong to two different people.',
        check: ({ accountHolder, duplicateOf }) => {
          if (!accountHolder) return na('No account_holder was sent, so submissions cannot be compared.');
          return duplicateOf
            // The other submission's reference belongs to another caller, so it is not shown.
            ? bad('This exact file was submitted earlier for a different account holder. ' +
              'Operators can find that submission in the audit log by the file hash.')
            : ok('No earlier submission for a different account holder is on record.');
        },
      },
    ],
  },
];

function runChecklist(context) {
  return SECTIONS.map((section) => ({
    key: section.key,
    name: section.name,
    items: section.items.map((item) => {
      const outcome = item.check(context);
      return {
        sn: item.sn,
        parameter: item.parameter,
        rule: item.rule,
        status: outcome.status,
        severity: outcome.status === 'DISCREPANCY' ? outcome.severity || item.severity : null,
        remarks: outcome.remarks,
        rows: (outcome.rows || []).slice(0, 25),
      };
    }),
  }));
}

function summarizeChecklist(sections) {
  const items = sections.flatMap((s) => s.items.map((i) => ({ section: s.key, ...i })));
  const count = (status) => items.filter((i) => i.status === status).length;
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return {
    summary: {
      totalChecks: items.length,
      ok: count('OK'),
      discrepancy: count('DISCREPANCY'),
      notApplicable: count('NA'),
    },
    discrepancies: items
      .filter((i) => i.status === 'DISCREPANCY')
      .sort((a, b) => rank[a.severity] - rank[b.severity])
      .map(({ sn, section, parameter, severity, remarks, rows }) => ({ sn, section, parameter, severity, remarks, rows })),
  };
}

// --- exports ---
module.exports = { runChecklist, summarizeChecklist, SECTIONS };
