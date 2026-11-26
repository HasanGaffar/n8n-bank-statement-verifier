/**
 * File      : tests/unused-lines.test.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : A PDF line that shows money must be read or reported, never silently dropped.
 * n8n node  : None. Run with: npm test
 * Flow      : fictitious PDF text -> src/engine.js -> assertions
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../src/engine');
const { readReply } = require('../src/ai');
const { parseAmount } = require('../src/parse');

const BASE = [
  'Opening Balance 10,000.00',
  '05-01-2026 GROCERY SHOP 500.00 9,500.00',
  '10-02-2026 SALARY 2,000.00 11,500.00',
];
const run = (...extra) => analyze({
  pdfText: [...BASE, ...extra].join('\n'), intake: { asOfDate: '2026-11-26', accountHolder: '' },
});
const notVerified = (result) => {
  assert.notEqual(result.result.verdict, 'VERIFIED');
  assert.notEqual(result.result.accountsCorrect, true);
};

test('the base statement is verified', () => {
  assert.equal(run().result.verdict, 'VERIFIED');
});

test('amounts written as 100/- are read, so a wrong balance is a fault', () => {
  assert.equal(run('20-03-2026 SHOP 100/- 99999/-').result.verdict, 'FAULTS_FOUND');
  assert.equal(run('20-03-2026 SHOP 100/- 11400/-').result.verdict, 'VERIFIED');
  assert.equal(parseAmount('1,250/-'), 1250);
});

test('a wrong figure after another balance label is never ignored', () => {
  for (const line of ['Ending Balance 99,999.00', 'Ending Balance 99999', 'Final Balance 99,999.00',
    'Balance as on date: 99,999.00', 'Ending Balance: BDT 99,999.00']) {
    notVerified(run(line));
  }
  assert.equal(run('Ending Balance 11,500.00').result.verdict, 'VERIFIED');
});

test('damaged or partial lines with money are reported', () => {
  for (const line of ['31-02-2026 SHOP 99,999.00 *', '20-03-2026 SHOP 99999', '20-03-2026 SHOP 100']) {
    const result = run(line);
    notVerified(result);
    assert.ok(result.unreadLines.length, line);
    assert.notEqual(result.result.verdict, 'FAULTS_FOUND', line);
  }
});

test('a figure printed on the line after its label counts as used', () => {
  assert.equal(run('Closing Balance', 'BDT 11,500.00').result.verdict, 'VERIFIED');
});

test('an empty content block does not crash the AI reply reader', () => {
  assert.equal(readReply({ content: [null], stop_reason: 'end_turn' }).ok, false);
});

test('ordinary header and footer lines do not block verification', () => {
  for (const line of ['Available Balance 11,500.00', 'Available Balance: BDT 12,000.00', 'Average Balance 10,250.00',
    'Overdraft Limit: 0.00', 'Hold Amount : 0.00', 'Interest Rate: 4.50 % p.a.', 'Exchange Rate: 1 USD = 117.50 BDT',
    'Deposits are insured up to BDT 200,000', 'Minimum balance requirement is Tk 5,000', 'Report Version: 3.0.1',
    'Hotline: 16,247', 'Ref No: 1,234', 'Balance as on 31-03-2026 BDT 11,500.00', 'Charge Tk 15.00']) {
    assert.equal(run(line).result.verdict, 'VERIFIED', line);
  }
});

test('PDF text with Bengali digits is read and checked', () => {
  assert.equal(run('\u09E8\u09E6-\u09E6\u09E9-\u09E8\u09E6\u09E8\u09EC SHOP \u09EB\u09E6\u09E6.\u09E6\u09E6 \u09E7\u09E7,\u09E6\u09E6\u09E6.\u09E6\u09E6').result.verdict, 'VERIFIED');
  assert.equal(run('\u09E8\u09E6-\u09E6\u09E9-\u09E8\u09E6\u09E8\u09EC SHOP \u09EB\u09E6\u09E6.\u09E6\u09E6 \u09EF\u09EF,\u09EF\u09EF\u09EF.\u09E6\u09E6').result.verdict, 'FAULTS_FOUND');
});
