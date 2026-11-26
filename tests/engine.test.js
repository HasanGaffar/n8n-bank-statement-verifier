/**
 * File      : tests/engine.test.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Automated tests for parsing, arithmetic checks, routing and request validation.
 * n8n node  : None. Run with: npm test
 * Flow      : sample-data/ -> src/ -> assertions
 */
// Automated tests. All fixtures are fictitious. Run with: node --test
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseAmount, parseDate, mapHeaders, parseRows } = require('../src/parse');
const { parsePdfText } = require('../src/parse-pdf');
const { analyze } = require('../src/engine');
const { MODELS, chooseRoute, readReply, mergeAiReview } = require('../src/ai');
const { checkRequest, MAX_FILE_BYTES } = require('../src/request');

const SAMPLES = path.join(__dirname, '..', 'sample-data');
const lines = (...items) => items.join('\n');
const sides = (transactions) => transactions.map((t) => [t.debit, t.credit, t.balance]);

describe('source language', () => {
  test('Bengali column titles are still recognised', () => {
    const titles = {
      date: '\u09A4\u09BE\u09B0\u09BF\u0996',
      description: '\u09AC\u09BF\u09AC\u09B0\u09A3',
      debit: '\u0996\u09B0\u099A',
      credit: '\u099C\u09AE\u09BE',
      balance: '\u09AC\u09CD\u09AF\u09BE\u09B2\u09C7\u09A8\u09CD\u09B8',
    };
    assert.deepEqual(mapHeaders(Object.values(titles)), titles);
  });

  test('no project file contains Bengali script', () => {
    const root = path.join(__dirname, '..');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
    const files = ['src', 'scripts', 'tests', 'docs', 'workflows', 'postman', 'sample-data']
      .flatMap((dir) => walk(path.join(root, dir)))
      .concat(['README.md', 'package.json', '.gitignore'].map((name) => path.join(root, name)))
      .filter((file) => !file.endsWith('.png'));
    const withBengali = files.filter((file) => /[\u0980-\u09FF]/.test(fs.readFileSync(file, 'utf8')));
    assert.deepEqual(withBengali, []);
  });
});

describe('parse.js', () => {
  test('amounts: lakh commas, Bengali digits, currency marks', () => {
    assert.equal(parseAmount('1,25,000.50'), 125000.5);
    assert.equal(parseAmount('\u09E7,\u09E8\u09EB,\u09E6\u09E6\u09E6.\u09EB\u09E6'), 125000.5);
    assert.equal(parseAmount('\u09F3 1,000.00'), 1000);
    assert.equal(parseAmount('BDT 2,500'), 2500);
    assert.equal(parseAmount(''), 0);
    assert.equal(parseAmount('-'), 0);
    assert.ok(Number.isNaN(parseAmount('twelve')));
    assert.ok(Number.isNaN(parseAmount('12.3.4')));
  });

  test('amounts: DR/CR suffix, parentheses, minus sign', () => {
    assert.equal(parseAmount('500.00 DR'), -500);
    assert.equal(parseAmount('500.00Cr'), 500);
    assert.equal(parseAmount('(1,200.00)'), -1200);
    assert.equal(parseAmount('-230.00'), -230);
  });

  test('dates are read day-first', () => {
    assert.equal(parseDate('03/04/2026'), '2026-04-03');
    assert.equal(parseDate('3-4-26'), '2026-04-03');
    assert.equal(parseDate('03 Apr 2026'), '2026-04-03');
    assert.equal(parseDate('2026-04-03'), '2026-04-03');
    assert.equal(parseDate('\u09E6\u09E9/\u09E6\u09EA/\u09E8\u09E6\u09E8\u09EC'), '2026-04-03');
  });

  test('invalid dates give null', () => {
    for (const bad of ['31/02/2026', '29/02/2026', '04/13/2026', '2026-13-01', '03 Xyz 2026', 'yesterday', '']) {
      assert.equal(parseDate(bad), null, bad);
    }
    assert.equal(parseDate('29/02/2028'), '2028-02-29');
  });

  test('Excel serial dates, with out-of-range numbers rejected', () => {
    assert.equal(parseDate(46023), '2026-01-01');
    assert.equal(parseDate(46023.75), '2026-01-01');
    assert.equal(parseDate(5), null);
    assert.equal(parseDate(900000), null);
  });

  test('headers: aliases, case, BOM, units in parentheses', () => {
    const columns = mapHeaders(['﻿Txn Date', 'PARTICULARS', 'Withdrawal (BDT)', 'Deposit (BDT)', 'Running_Balance']);
    assert.deepEqual(columns, {
      date: '﻿Txn Date', description: 'PARTICULARS', debit: 'Withdrawal (BDT)',
      credit: 'Deposit (BDT)', balance: 'Running_Balance',
    });
    assert.throws(() => mapHeaders(['Date', 'Description', 'Amount']), /Missing column\(s\): Balance, Debit \+ Credit/);
  });

  const row = (Date, Description, Debit, Credit, Balance) => ({ Date, Description, Debit, Credit, Balance });

  test('opening, total and closing rows are summary lines, not transactions', () => {
    const parsed = parseRows([
      row('', 'Opening Balance', '', '', '1,000.00'),
      row('01/05/2026', 'SAMPLE SALE', '', '500.00', '1,500.00'),
      row('02/05/2026', 'SAMPLE RENT', '200.00', '', '1,300.00'),
      row('', 'Total', '200.00', '500.00', ''),
      row('', 'Closing Balance', '', '', '1,300.00'),
    ]);
    assert.equal(parsed.openingBalance, 1000);
    assert.deepEqual(parsed.stated, { totalDebit: 200, totalCredit: 500, closingBalance: 1300 });
    assert.deepEqual(parsed.transactions.map((t) => t.row), [3, 4]);
    assert.deepEqual(parsed.rejected, []);
  });

  test('"Total gas bill" with a valid date stays a transaction', () => {
    const parsed = parseRows([row('01/05/2026', 'Total gas bill', '100.00', '', '900.00')]);
    assert.equal(parsed.transactions.length, 1);
    assert.equal(parsed.transactions[0].description, 'Total gas bill');
    assert.equal(parsed.transactions[0].debit, 100);
    assert.deepEqual(parsed.stated, {});
  });

  test('unreadable rows are reported in rejected', () => {
    const parsed = parseRows([row('31/02/2026', 'BAD DATE', '1.00', '', '9.00')]);
    assert.deepEqual(parsed.rejected.map((r) => [r.row, r.reason]), [[2, 'Unreadable date']]);
  });

  test('a negative debit among positive debits is kept as a reversal', () => {
    const parsed = parseRows([
      row('01/05/2026', 'SMS CHARGE', '230.00', '', '770.00'),
      row('02/05/2026', 'REVERSAL OF SMS CHARGE', '-230.00', '', '1000.00'),
    ]);
    assert.deepEqual(parsed.transactions.map((t) => t.debit), [230, -230]);
  });

  test('an all-negative debit column is flipped to positive', () => {
    const parsed = parseRows([
      row('01/05/2026', 'RENT', '-100.00', '', '900.00'),
      row('02/05/2026', 'BILL', '-50.00', '', '850.00'),
      row('03/05/2026', 'SALE', '', '25.00', '875.00'),
    ]);
    assert.deepEqual(parsed.transactions.map((t) => [t.debit, t.credit]), [[100, 0], [50, 0], [0, 25]]);
  });
});

describe('parse-pdf.js', () => {
  test('layout (a): date line, description lines, then "amount balance"', () => {
    const parsed = parsePdfText(lines(
      'Fictitious Sample Bank',
      'Opening Balance 1,000.00',
      '01-03-2026 SALARY CREDIT',
      'EXAMPLE WIDGETS LTD',
      '500.00 1,500.00',
      '02-03-2026 CARD PURCHASE',
      'SAMPLE MART',
      '200.00 1,300.00',
    ));
    assert.equal(parsed.openingBalance, 1000);
    assert.deepEqual(parsed.transactions.map((t) => [t.date, t.description]), [
      ['2026-03-01', 'SALARY CREDIT EXAMPLE WIDGETS LTD'],
      ['2026-03-02', 'CARD PURCHASE SAMPLE MART'],
    ]);
    assert.deepEqual(sides(parsed.transactions), [[0, 500, 1500], [200, 0, 1300]]);
    assert.deepEqual(parsed.rejected, []);
  });

  const amountsFirst = lines(
    'Date Narration Debit Credit Balance',
    '19/07/2026',
    '0.00 500.00 1,500.00',
    'SAMPLE DEPOSIT',
    '20/07/2026',
    '100.00 0.00 1,400.00',
    'SAMPLE RENT',
    '21/07/2026',
    '230.00 0.00 1,170.00',
    'SMS CHARGE',
    'TrxId DEMO3',
    '21-07-26 10:15:22',
    '21/07/2026',
    '-230.00 0.00 1,400.00',
    'REVERSAL OF SMS CHARGE',
    'Page 1 of 2',
    // Closing summary: figures first, in an order that differs from the labels.
    '1,000.00',
    '1,400.00',
    '100.00',
    '500.00',
    'Opening Balance:',
    'Total Debit:',
    'Total Credit:',
    'Closing Balance:',
  );

  test('layout (b): amounts first, then narration including a timestamp line', () => {
    const parsed = parsePdfText(amountsFirst);
    assert.equal(parsed.transactions.length, 4);
    assert.equal(parsed.columnOrder, 'debit-first');
    assert.equal(parsed.transactions[2].description, 'SMS CHARGE TrxId DEMO3 21-07-26 10:15:22');
    assert.equal(parsed.transactions[3].description, 'REVERSAL OF SMS CHARGE');
    assert.deepEqual(parsed.rejected, []);
  });

  test('layout (b): negative debit is kept as a reversal', () => {
    const parsed = parsePdfText(amountsFirst);
    assert.deepEqual(sides(parsed.transactions), [
      [0, 500, 1500], [100, 0, 1400], [230, 0, 1170], [-230, 0, 1400],
    ]);
  });

  test('layout (b): detached closing summary is matched to the right labels', () => {
    const result = analyze({ pdfText: amountsFirst, intake: { asOfDate: '2026-11-26', accountHolder: 'X' } });
    const r = result.reconciliation;
    assert.deepEqual(
      [r.openingBalance, r.openingBalanceSource, r.printedTotalDebit, r.printedTotalCredit, r.printedClosingBalance],
      [1000, 'stated', 100, 500, 1400],
    );
    assert.equal(result.faultCount, 0);
    assert.equal(result.result.accountsCorrect, true);
  });

  test('(c) amounts outside any record are reported in rejected', () => {
    const parsed = parsePdfText(lines(
      'Opening Balance 1,000.00',
      '01-03-2026 SAMPLE SALE',
      '500.00 1,500.00',
      '750.00 2,250.00',
      '02-03-2026 SAMPLE RENT',
      '200.00 1,300.00',
    ));
    assert.equal(parsed.transactions.length, 2);
    assert.equal(parsed.rejected.length, 1);
    assert.equal(parsed.rejected[0].row, 4);
    assert.equal(parsed.rejected[0].raw, '750.00 2,250.00');
    assert.match(parsed.rejected[0].reason, /not part of a dated transaction/);
  });

  test('(d) too few records throws LAYOUT_NOT_SUPPORTED', () => {
    assert.throws(() => parsePdfText('01-03-2026 ONLY ONE\n500.00 1,500.00'), /LAYOUT_NOT_SUPPORTED/);
    assert.throws(() => parsePdfText(''), /LAYOUT_NOT_SUPPORTED/);
  });
});

// Minimal CSV reader: quoted fields, doubled quotes, CRLF.
function readCsv(file) {
  const text = fs.readFileSync(path.join(SAMPLES, file), 'utf8').replace(/^﻿/, '');
  const table = [[]];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { table.at(-1).push(cell); cell = ''; }
    else if (c === '\n') { table.at(-1).push(cell); cell = ''; table.push([]); }
    else if (c !== '\r') cell += c;
  }
  if (cell || table.at(-1).length) table.at(-1).push(cell);
  const [header, ...body] = table.filter((r) => r.length);
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

describe('engine.js on sample-data CSV files', () => {
  const VERDICTS = {
    '01-correct.csv': 'VERIFIED',
    '02-altered-amount.csv': 'FAULTS_FOUND',
    '03-altered-balance.csv': 'FAULTS_FOUND',
    '04-missing-entry.csv': 'FAULTS_FOUND',
    '05-swapped-debit-credit.csv': 'FAULTS_FOUND',
    '06-duplicated-line.csv': 'FAULTS_FOUND',
    '07-wrong-printed-totals.csv': 'FAULTS_FOUND',
    '08-suspicious-pattern.csv': 'REVIEW_REQUIRED',
    '12-wallet-correct.csv': 'VERIFIED',
    '17-multiple-faults.csv': 'FAULTS_FOUND',
  };
  const run = (file) => analyze({ rows: readCsv(file), intake: { asOfDate: '2026-11-26', accountHolder: 'X' } });

  test('every sample CSV has an expectation', () => {
    const found = fs.readdirSync(SAMPLES).filter((f) => f.endsWith('.csv')).sort();
    assert.deepEqual(found, [...Object.keys(VERDICTS), '13-missing-columns.csv'].sort());
  });

  for (const [file, verdict] of Object.entries(VERDICTS)) {
    test(`${file} gives ${verdict}`, () => {
      const result = run(file);
      assert.equal(result.result.verdict, verdict);
      assert.deepEqual(result.unreadLines, []);
      if (verdict === 'VERIFIED') {
        assert.equal(result.faultCount, 0);
        assert.equal(result.result.accountsCorrect, true);
      }
    });
  }

  const expected = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'expected-fault-rows.json'), 'utf8'));
  test('expected-fault-rows.json covers files 02-06', () => {
    assert.deepEqual(Object.keys(expected).map((f) => f.slice(0, 2)).sort(), ['02', '03', '04', '05', '06']);
  });
  for (const [file, { row, size }] of Object.entries(expected)) {
    test(`${file} reports exactly row ${row}`, () => {
      const result = run(file);
      assert.deepEqual(result.faults.map((f) => f.row), [row]);
      if (size !== null) assert.ok(Math.abs(Math.abs(result.faults[0].difference) - size) <= 0.01);
      assert.equal(result.result.accountsCorrect, false);
    });
  }

  test('07 has wrong printed totals but no running-balance fault', () => {
    const result = run('07-wrong-printed-totals.csv');
    assert.equal(result.faultCount, 0);
    assert.equal(result.result.accountsCorrect, false);
  });

  test('08 needs review while the accounts are correct', () => {
    assert.equal(run('08-suspicious-pattern.csv').result.accountsCorrect, true);
  });

  test('17 has 3 balance faults', () => {
    const result = run('17-multiple-faults.csv');
    assert.equal(result.faultCount, 3);
    assert.equal(result.faults.length, 3);
  });

  test('13 throws about missing columns', () => {
    assert.throws(() => run('13-missing-columns.csv'), /Missing column\(s\)/);
  });
});

describe('ai.js', () => {
  const item = (sn, severity, status = severity ? 'DISCREPANCY' : 'OK') =>
    ({ sn, parameter: 'p', rule: 'r', status, severity, remarks: '', rows: [] });
  const sections = (severity = null) => [
    { key: 'A', name: 'Alpha', items: [item('A1', null)] },
    { key: 'B', name: 'Beta', items: [item('B1', severity)] },
  ];
  const answered = (key, concerns = []) => ({ key, ok: true, notes: [], concerns });
  const route = (extra = {}) => chooseRoute({
    sections: sections(), verdict: 'VERIFIED', faultCount: 0, unmatchedSummary: null,
    triage: { results: [answered('A'), answered('B')] }, ...extra,
  });

  test('chooseRoute: HAIKU_ONLY when nothing is serious or doubted', () => {
    for (const extra of [{}, { sections: sections('LOW') }]) {
      const r = route(extra);
      assert.deepEqual([r.tier, r.model, r.sections], ['HAIKU_ONLY', null, []]);
    }
  });

  test('chooseRoute: ESCALATED_SONNET for serious, doubted or failed sections', () => {
    const cases = [
      { sections: sections('HIGH'), faultCount: 2 },
      { sections: sections('MEDIUM') },
      { triage: { results: [answered('A'), answered('B', [{ description: 'check', rows: [] }])] } },
      { triage: { results: [answered('A'), { key: 'B', ok: false, why: 'No reply' }] } },
    ];
    for (const extra of cases) {
      const r = route(extra);
      assert.deepEqual([r.tier, r.model, r.sections], ['ESCALATED_SONNET', MODELS.standard, ['B']]);
    }
  });

  test('chooseRoute: ESCALATED_OPUS for complex cases', () => {
    for (const extra of [{ faultCount: 3 }, { unmatchedSummary: {} }, { verdict: 'INCONCLUSIVE' }]) {
      const r = route(extra);
      assert.deepEqual([r.tier, r.model, r.sections], ['ESCALATED_OPUS', MODELS.complex, ['A', 'B']]);
    }
    assert.deepEqual(route({ faultCount: 3, sections: sections('HIGH') }).sections, ['B']);
  });

  const reply = (text, extra = {}) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', ...extra });
  const good = JSON.stringify({ notes: [], concerns: [] });

  test('readReply: success joins text blocks and ignores other block types', () => {
    const r = readReply({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'ignored' },
        { type: 'text', text: good.slice(0, 5) },
        { type: 'text', text: good.slice(5) },
      ],
    });
    assert.deepEqual(r, { ok: true, notes: [], concerns: [] });
  });

  test('readReply: failure cases', () => {
    const cases = [
      [undefined, /No reply/],
      [{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, /Overloaded/],
      [{ error: 'timeout' }, /timeout/],
      [reply(good, { stop_reason: 'max_tokens' }), /Stopped early: max_tokens/],
      [reply(good, { stop_reason: 'refusal' }), /Stopped early: refusal/],
      [reply('{"notes": ['), /not valid JSON/],
      [reply('{"notes": []}'), /Unexpected reply shape/],
    ];
    for (const [input, why] of cases) {
      const r = readReply(input);
      assert.equal(r.ok, false);
      assert.match(r.why, why);
    }
  });

  test('mergeAiReview never changes check status or severity', () => {
    const input = sections('HIGH');
    const before = structuredClone(input);
    const hostile = {
      notes: [
        { sn: 'B1', note: 'looks fine', status: 'OK', severity: 'LOW' },
        { sn: 'Z9', note: 'unknown item' },
      ],
      concerns: [{ description: 'verify', rows: [3, 'x'], severity: 'LOW' }],
    };
    const merged = mergeAiReview({
      sections: input,
      route: { tier: 'ESCALATED_SONNET', model: MODELS.standard, sections: ['B'], reasons: [] },
      triage: {
        results: [answered('A'), answered('B')],
        log: { stage: 1, sections: ['A', 'B'], failed: [], inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      },
      escalationReplies: [reply(JSON.stringify(hostile))],
    });
    const checks = (list) => list.flatMap((s) => s.items.map((i) => [i.sn, i.status, i.severity]));
    assert.deepEqual(checks(merged.sections), checks(before));
    assert.deepEqual(input, before, 'input was mutated');
    assert.equal(merged.sections[1].items[0].aiNote.text, 'looks fine');
    assert.equal(merged.sections.flatMap((s) => s.items).length, 2);
    assert.deepEqual(merged.aiReview.concerns, [
      { section: 'B', model: MODELS.standard, description: 'verify', rows: [3] },
    ]);
    assert.equal(merged.aiReview.status, 'COMPLETED');
  });
});

describe('request.js checkRequest', () => {
  const check = ({ body = {}, file = { fileName: 'demo.csv', sizeBytes: 10 } } = {}) =>
    checkRequest({ body, file, today: '2026-11-26' });
  const failure = (r) => [r.valid, r.httpStatus, r.error?.code];

  test('MISSING_FILE', () => {
    assert.deepEqual(failure(check({ file: null })), [false, 400, 'MISSING_FILE']);
  });
  test('INVALID_FIELD for a bad as_of_date', () => {
    assert.deepEqual(failure(check({ body: { as_of_date: '31/02/2026' } })), [false, 400, 'INVALID_FIELD']);
  });
  test('UNSUPPORTED_FILE_TYPE', () => {
    const r = check({ file: { fileName: 'demo.txt', sizeBytes: 10 } });
    assert.deepEqual(failure(r), [false, 415, 'UNSUPPORTED_FILE_TYPE']);
  });
  test('FILE_TOO_LARGE only above the limit', () => {
    const at = (sizeBytes) => check({ file: { fileName: 'demo.pdf', sizeBytes } });
    assert.deepEqual(failure(at(MAX_FILE_BYTES + 1)), [false, 413, 'FILE_TOO_LARGE']);
    assert.equal(at(MAX_FILE_BYTES).valid, true);
  });
  test('a valid request is accepted and the reference is kept on failures', () => {
    const ok = check({ body: { account_holder: ' Demo ', ai_review: 'TRUE', reference: 'R-1' } });
    assert.deepEqual(
      [ok.valid, ok.accountHolder, ok.asOfDate, ok.aiReview, ok.fileType, ok.reference],
      [true, 'Demo', '2026-11-26', true, 'csv', 'R-1'],
    );
    assert.equal(check({ body: { reference: 'R-2' }, file: null }).reference, 'R-2');
  });
});
