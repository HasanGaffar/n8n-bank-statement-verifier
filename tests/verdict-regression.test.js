/**
 * File      : tests/verdict-regression.test.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Regression tests for verdicts: unread lines, same-day order and the E003 remark.
 * n8n node  : None. Run with: node --test
 * Flow      : fictitious rows -> src/ -> assertions
 */
// All fixtures are fictitious. Run with: node --test
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../src/engine');

const intake = {
  reference: 'REF-TEST', accountHolder: 'Test Person', fileName: 'x.csv', fileType: 'csv',
  sha256: '0'.repeat(64), asOfDate: '2026-06-30',
};
const row = (day, balance, type = 'DR') => ({
  Date: `2026-01-${String(day).padStart(2, '0')}`, Description: `ITEM ${day}`, Amount: '100', Type: type,
  Balance: String(balance),
});
const summary = (label, balance) => ({ Date: '', Description: label, Amount: '', Type: '', Balance: String(balance) });
// Six correct debits of 100, from 1000 down to 400.
const statement = () => [
  summary('Opening Balance', 1000),
  ...[900, 800, 700, 600, 500, 400].map((balance, i) => row(i + 2, balance)),
];
const run = (rows, extra = {}) => analyze({ rows, intake, ...extra });

function assertUnread({ result }) {
  assert.equal(result.verdict, 'REVIEW_REQUIRED');
  assert.equal(result.accountsCorrect, null);
  assert.match(result.headline, /could not be read/);
}
function assertFault({ result }) {
  assert.equal(result.verdict, 'FAULTS_FOUND');
  assert.notEqual(result.accountsCorrect, true);
}
const withUnreadRow = () => {
  const rows = statement();
  rows[2] = row(3, 800, 'Transfer');
  return rows;
};

describe('gaps next to unread lines', () => {
  test('a gap at an unread line is not reported as a fault', () => {
    assertUnread(run(withUnreadRow()));
  });

  test('the same holds for a newest-first file', () => {
    assertUnread(run(withUnreadRow().slice(1).reverse()));
  });

  test('an unread last line explains a different printed closing balance', () => {
    const rows = statement();
    rows[6] = row(7, 400, 'Transfer');
    assertUnread(run([...rows, summary('Closing Balance', 400)]));
  });

  test('a fault away from the unread line is still a fault', () => {
    const rows = withUnreadRow();
    rows[5] = row(6, 555);
    assertFault(run(rows));
  });

  test('an unread line with no gap around it does not excuse a gap elsewhere', () => {
    const rows = [...statement(), row(8, 999)];
    rows.splice(2, 0, row(2, 900, 'Transfer'));
    assertFault(run(rows));
  });

  test('a wrong printed closing balance with no unread line at the end is a fault', () => {
    assertFault(run([...withUnreadRow(), summary('Closing Balance', 5000)]));
  });

  test('a printed total below the entries is a fault', () => {
    const total = { Date: '', Description: 'Total Debits', Debit: '', Credit: '', Balance: '' };
    const rows = [900, 800, 700, 600, 500, 400].map((balance, i) => ({
      Date: `2026-01-0${i + 2}`, Description: `ITEM ${i}`, Debit: '100', Credit: '', Balance: String(balance),
    }));
    rows[1].Balance = 'unclear';
    assertFault(run([...rows, { ...total, Debit: '50' }]));
    assertUnread(run([...rows, { ...total, Debit: '600' }]));
  });

  test('a future-dated entry is still a fault beside an unread gap', () => {
    const response = run(withUnreadRow(), { intake: { ...intake, asOfDate: '2026-01-06' } });
    assertFault(response);
    assert.equal(response.result.accountsCorrect, null);
  });
});

describe('rows that all share one date', () => {
  const sameDay = (...balances) => balances.map((balance) => row(2, balance));

  test('a newest-first export is reversed', () => {
    assert.equal(run(sameDay(700, 800, 900)).result.accountsCorrect, true);
  });

  test('an oldest-first export keeps its order', () => {
    assert.equal(run(sameDay(900, 800, 700)).result.accountsCorrect, true);
  });

  test('a real fault is still found', () => {
    assertFault(run(sameDay(700, 850, 900)));
  });
});

describe('E003', () => {
  test('the reference of the other submission is not revealed', () => {
    const response = run(statement(), { duplicateOf: 'OTHER-CASE-42' });
    assert.equal(response.result.verdict, 'FAULTS_FOUND');
    assert.doesNotMatch(JSON.stringify(response), /OTHER-CASE-42/);
    const found = response.verification.discrepancies.find((d) => d.sn === 'E003');
    assert.match(found.remarks, /audit log by the file hash/);
  });
});

describe('summary rows that cannot be used', () => {
  const full = () => statement();
  const notVerified = ({ result, unreadLines }) => {
    assert.equal(result.verdict, 'REVIEW_REQUIRED');
    assert.equal(result.accountsCorrect, null);
    assert.ok(unreadLines.length > 0);
  };

  test('an unreadable dated Total row is listed', () => {
    notVerified(run([...full(), { Date: '2026-01-08', Description: 'Total', Amount: 'abc', Type: '', Balance: '' }]));
  });

  test('an unreadable closing balance is listed', () => {
    notVerified(run([...full(), summary('Closing Balance', '4x0')]));
  });

  test('an unreadable opening balance is listed', () => {
    notVerified(run([summary('Opening Balance', '1O00'), ...full().slice(1)]));
  });

  test('a dated summary row without figures is listed', () => {
    notVerified(run([...full(), { ...summary('Closing Balance', ''), Date: '2026-01-08' }]));
  });

  test('conflicting closing balances are listed in either order', () => {
    for (const pair of [[400, 99999], [99999, 400]]) {
      notVerified(run([...full(), ...pair.map((b) => summary('Closing Balance', b))]));
    }
  });

  test('a repeated identical closing balance is accepted', () => {
    const rows = [...full(), summary('Closing Balance', 400), summary('Closing Balance', 400)];
    assert.equal(run(rows).result.accountsCorrect, true);
  });

  test('an unread summary row does not excuse a wrong printed total', () => {
    const total = { ...summary('Total Debits', ''), Amount: '50' };
    assertFault(run([...full(), total, summary('Closing Balance', 'unclear')]));
  });
});

describe('minus signs in the Amount + Type layout', () => {
  const entry = (day, amount, type, balance) => ({ ...row(day, balance, type), Amount: String(amount) });
  const check = (...rows) => run([summary('Opening Balance', 1000), ...rows]);
  const correct = (...rows) => assert.equal(check(...rows).result.accountsCorrect, true);

  test('a reversed debit keeps its sign', () => {
    correct(entry(2, 100, 'DR', 900), entry(3, -100, 'DR', 1000));
  });

  test('a reversed credit keeps its sign among unsigned debits', () => {
    correct(entry(2, 100, 'DR', 900), entry(3, -50, 'CR', 850));
  });

  test('unsigned amounts are read by type', () => {
    correct(entry(2, 100, 'DR', 900), entry(3, 50, 'CR', 950));
  });

  test('amounts signed by direction are accepted', () => {
    correct(entry(2, -100, 'DR', 900), entry(3, 50, 'CR', 950), entry(4, -100, 'DR', 850));
  });

  test('mixed signs without any reversal are accepted', () => {
    correct(entry(2, -100, 'DR', 900), entry(3, 100, 'DR', 800));
  });

  test('a wrong balance beside a reversal is still a fault', () => {
    assertFault(check(entry(2, 100, 'DR', 900), entry(3, -100, 'DR', 1000), entry(4, 100, 'DR', 950)));
  });
});

describe('very large statements', () => {
  test('150,000 entries do not overflow the stack', () => {
    const { detectRisks } = require('../src/fraud');
    const { analyseAccount } = require('../src/analysis');
    const many = Array.from({ length: 150000 }, (_, i) => ({
      row: i + 2, date: '2026-01-02', description: `ITEM ${i}`, debit: 0, credit: 0, balance: i,
      reference: `R${i}`, category: 'OTHER',
    }));
    assert.doesNotThrow(() => detectRisks(many));
    assert.equal(analyseAccount(many).highestBalance, 149999);
  });
});
