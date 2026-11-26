/**
 * File      : tests/parse-pdf-regression.test.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Regression tests for PDF lines that were once skipped or misread.
 * n8n node  : None. Run with: npm test
 * Flow      : inline PDF text -> src/engine.js -> assertions
 */
// All fixtures are fictitious.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { analyze } = require('../src/engine');

const run = (...items) =>
  analyze({ pdfText: items.join('\n'), intake: { asOfDate: '2026-11-26', accountHolder: 'X' } });

// A line must never vanish: it is either a fault or listed as unread.
function assertNotAccepted(result) {
  assert.notEqual(result.result.verdict, 'VERIFIED');
  assert.notEqual(result.result.accountsCorrect, true);
}

function assertVerified(result) {
  assert.equal(result.result.verdict, 'VERIFIED');
  assert.equal(result.result.accountsCorrect, true);
  assert.deepEqual(result.unreadLines, []);
}

const BASE = [
  'Statement period 01-01-2026 to 31-03-2026',
  'Opening Balance 10,000.00',
  '05-01-2026 GROCERY SHOP 500.00 9,500.00',
  '10-02-2026 SALARY 2,000.00 11,500.00',
  '12-03-2026 UTILITY BILL 300.00 11,200.00',
];

describe('parse-pdf.js regressions', () => {
  test('1: a dated row that mentions a period is still a transaction', () => {
    for (const text of ['INTEREST FOR PERIOD 01-01-2026 to 31-03-2026', 'TRANSFER FROM SAVINGS 01-03-2026 - 31-03-2026']) {
      const bad = run(...BASE, `31-03-2026 ${text} 100.00 99,999.00`);
      assert.deepEqual([bad.statement.transactionCount, bad.faultCount], [4, 1]);
      assertNotAccepted(bad);
      assertVerified(run(...BASE, `31-03-2026 ${text} 100.00 11,300.00`));
      assertVerified(run(...BASE, `31-03-2026 ${text}`, '100.00 11,300.00'));
    }
  });

  test('2: rows and wrapped lines that start with a summary word are not dropped', () => {
    const endings = [
      (b) => [`20-03-2026 Total Deposit 100.00 ${b}`],
      (b) => ['20-03-2026 CARD PURCHASE', `TOTAL FUEL STATION 100.00 ${b}`],
      (b) => ['20-03-2026 CARD PURCHASE', `Total Deposit 100.00 ${b}`],
    ];
    for (const ending of endings) {
      const bad = run(...BASE, ...ending('99,999.00'));
      assert.deepEqual([bad.statement.transactionCount, bad.faultCount], [4, 1]);
      assertNotAccepted(bad);
      assertVerified(run(...BASE, ...ending('11,100.00')));
    }
    for (const line of ['TOTAL FUEL STATION 100.00 99,999.00', 'Total Deposit 100.00 99,999.00', 'Total 100.00 99,999.00']) {
      const result = run(...BASE, line);
      assert.equal(result.unreadLines.length, 1, line);
      assertNotAccepted(result);
    }
    // A real totals row, debits then credits, is understood.
    assertVerified(run(...BASE, 'Total 800.00 2,000.00'));
  });

  const OVERDRAWN = [
    'Opening Balance 1,000.00',
    '05-01-2026 RENT 1,500.00 500.00 DR',
    '10-01-2026 SHOP 100.00 600.00 DR',
    '12-01-2026 SHOP 100.00 700.00 DR',
  ];

  test('3: a spaced DR on a printed balance makes it negative', () => {
    assertVerified(run(...OVERDRAWN, 'Closing Balance 700.00 DR'));
    assertVerified(run(...OVERDRAWN, 'Closing Balance', '700.00 DR'));
    assertVerified(run(...OVERDRAWN, '31-01-2026 Closing Balance 700.00 DR'));
    assertVerified(run(
      'Opening Balance 200.00 Dr',
      '05-01-2026 SHOP 100.00 300.00 DR',
      '10-01-2026 SHOP 100.00 400.00 DR',
    ));
    assertNotAccepted(run(...OVERDRAWN, 'Closing Balance 700.00 CR'));
  });

  const NO_OPENING = [
    '05-01-2026 TRANSFER FROM JOHN 500.00 1,500.00',
    '10-01-2026 SHOP 100.00 1,400.00',
    '12-01-2026 SHOP 100.00 1,300.00',
  ];

  test('4: printed totals decide the direction of the first row', () => {
    assertVerified(run(...NO_OPENING, 'Total Credits 500.00', 'Total Debits 200.00'));
    assertVerified(run(...NO_OPENING, 'Total Credits 500.00'));
    assertVerified(run(...NO_OPENING, 'Total Debits 200.00'));
    assertVerified(run(...NO_OPENING));
    assertNotAccepted(run(...NO_OPENING, 'Total Credits 900.00', 'Total Debits 200.00'));
  });

  const TWO_ROWS = ['05-01-2026 SHOP 100.00 900.00', '10-01-2026 SHOP 100.00 800.00'];

  test('6: two labelled figures on one line are both checked', () => {
    const bad = run(...TWO_ROWS, 'Opening Balance 1,000.00 Closing Balance 5,000.00');
    assert.equal(bad.reconciliation.printedClosingBalance, 5000);
    assertNotAccepted(bad);
    assertVerified(run(...TWO_ROWS, 'Opening Balance 1,000.00 Closing Balance 800.00'));
    assertVerified(run(...TWO_ROWS, 'Total Debits 200.00 Total Credits 0.00'));
  });

  test('6: figures that cannot be assigned are reported', () => {
    for (const line of ['Opening Balance Closing Balance 5,000.00', 'Closing Balance 800.00 5,000.00']) {
      const result = run(...TWO_ROWS, line);
      assert.equal(result.unreadLines.length, 1, line);
      assertNotAccepted(result);
    }
  });

  test('A: a damaged last or middle row is listed as unread', () => {
    const endings = [
      '100 99999', '100.00 99,999.00 *', '100.00 99,999.00 Dr.', '100.00 99,999.00-', '100.00 99,999.00 BDT',
      '100.00 99,999.00 REF123', '100.00 99,999.00 (Cr)', '100.00 BDT99,999.00', '100.00 BDT 99,999.00 x',
      '100.00 BDT99,999.00', '100.0 99,999.0', '100.00 99.999,00',
    ];
    for (const ending of endings) {
      assertNotAccepted(run(...BASE, `20-03-2026 SHOP ${ending}`));
      assertNotAccepted(run(...BASE, '20-03-2026 SHOP', ending));
    }
    const middle = run(...BASE.slice(0, 4), '11-02-2026 SHOP 100.00 11,400.00 *', '12-03-2026 UTILITY BILL 300.00 11,100.00');
    assert.equal(middle.unreadLines.length, 1);
    assertNotAccepted(middle);
    assert.notEqual(middle.result.verdict, 'FAULTS_FOUND');
  });

  test('B: a dated row that mentions a page number is not page furniture', () => {
    assertNotAccepted(run(...BASE, '20-03-2026 FEE see page 1 of 2', '100.00', '99,999.00'));
    assertVerified(run(...BASE, '20-03-2026 FEE see page 1 of 2', '100.00', '11,100.00'));
    assertVerified(run(...BASE, '26-11-2026 Page 1 of 2', 'Phone 01700-000000 Account 1234567890123'));
  });

  test('D and D2: repeated summary figures must chain', () => {
    const conflicting = run(...BASE, 'Closing Balance 11,200.00', 'Closing Balance 99,999.00');
    assert.equal(conflicting.unreadLines.length, 2);
    assertNotAccepted(conflicting);
    const first = ['Opening Balance 10,000.00', '05-01-2026 GROCERY SHOP 500.00 9,500.00'];
    const second = '10-02-2026 SALARY 2,000.00 11,500.00';
    assertVerified(run(...first, 'Closing Balance 9,500.00', 'Opening Balance 9,500.00', second, 'Closing Balance 11,500.00'));
    assertVerified(run(...first, 'Total Debits 500.00', second, 'Total Debits 0.00', 'Total Credits 2,000.00'));
    const broken = run(...first, 'Total Debits 500.00', second, 'Total Debits 2,000.00');
    assertNotAccepted(broken);
    assert.notEqual(broken.result.verdict, 'FAULTS_FOUND');
  });

  test('E: a printed figure in an unreadable format is listed', () => {
    for (const lines of [
      ['Closing Balance 99,999'], ['Closing Balance 99999'], ['Closing Balance BDT99,999.00'],
      ['Closing Balance', '99,999'], ['Closing Bal 99,999.00'], ['Your closing balance is 99,999.00'], ['Grand Total 99999'],
    ]) {
      assertNotAccepted(run(...BASE, ...lines));
    }
  });

  test('F: a wrapped row with the balance on its own line is kept', () => {
    assertVerified(run(...BASE, '20-03-2026 CARD PURCHASE', 'Total Deposit 100.00', '11,100.00'));
  });

  test('G: same-day newest-first rows are reversed', () => {
    assertVerified(run(
      'Opening Balance 1,000.00',
      '05-01-2026 C 100.00 700.00', '05-01-2026 B 100.00 800.00', '05-01-2026 A 100.00 900.00',
    ));
  });
});
