/**
 * File      : scripts/generate-samples.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Creates the fictitious sample statements, including the deliberate faults.
 * n8n node  : None. Developer tool: npm run samples
 * Flow      : generator -> sample-data/ -> POST /webhook/verify-statement
 */
// Creates the synthetic sample statements in sample-data/. All names, accounts
// and transactions are invented. The output is the same on every run.
//   node scripts/generate-samples.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'sample-data');

const cents = (n) => Math.round(n * 100) / 100;
const money = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

// Six months of a small trading business, May to October 2026.
function businessStatement({ seed = 7, opening = 250000 } = {}) {
  const random = seeded(seed);
  const between = (low, high) => cents(low + random() * (high - low));
  const entries = [];
  const add = (date, description, debit, credit) => entries.push({ date, description, debit, credit });

  for (let day = Date.UTC(2026, 4, 1); day <= Date.UTC(2026, 9, 31); day += 86400000) {
    const date = new Date(day).toISOString().slice(0, 10);
    const dom = Number(date.slice(8));
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 5 && (weekday % 2 === 0 || dom % 7 === 0)) add(date, 'POS SALES SETTLEMENT', 0, between(24000, 34000));
    if (weekday === 1) add(date, 'SUPPLIER PAYMENT - MEGHNA WHOLESALE', between(48000, 62000), 0);
    if (dom === 3) add(date, 'SHOP RENT', 28000, 0);
    if (dom === 5) add(date, 'STAFF SALARY', 36000, 0);
    if (dom === 10) add(date, 'ELECTRICITY BILL DESCO', between(4200, 5600), 0);
    if (dom === 12) add(date, 'LOAN EMI AUTO DEBIT', 12500, 0);
    if (dom === 18) add(date, 'ATM CASH WITHDRAWAL', 10000, 0);
    if (dom === 28) add(date, 'SERVICE CHARGE WITH VAT', 575, 0);
    if (date === '2026-07-21') {
      add(date, 'SMS CHARGE', 230, 0);
      add(date, 'REVERSAL OF SMS CHARGE', -230, 0);
    }
  }
  return withBalances(entries, opening);
}

function withBalances(entries, opening) {
  let balance = opening;
  const rows = entries.map((e, i) => {
    balance = cents(balance + e.credit - e.debit);
    return { ...e, reference: `TX${String(100001 + i)}`, balance };
  });
  return { opening, rows };
}

function printedFigures({ opening, rows }) {
  return {
    opening,
    totalDebit: cents(rows.reduce((t, r) => t + r.debit, 0)),
    totalCredit: cents(rows.reduce((t, r) => t + r.credit, 0)),
    closing: rows[rows.length - 1].balance,
  };
}

// --- Fault injection. Each returns a new statement; printed figures stay as the
// bank originally printed them unless the fault is in those figures. ---
const clone = (s) => ({ ...s, rows: s.rows.map((r) => ({ ...r })) });
const indexOfNth = (rows, test, n) => rows.map((r, i) => [r, i]).filter(([r]) => test(r))[n][1];

const FAULTS = {
  alteredAmount(s) {
    const copy = clone(s);
    const i = indexOfNth(copy.rows, (r) => r.credit > 0, 30);
    copy.rows[i].credit = cents(copy.rows[i].credit + 50000);
    return { copy, row: i, size: 50000 };
  },
  alteredBalance(s) {
    const copy = clone(s);
    const i = 45;
    copy.rows[i].balance = cents(copy.rows[i].balance + 100000);
    return { copy, row: i, size: 100000 };
  },
  missingEntry(s) {
    const copy = clone(s);
    const i = indexOfNth(copy.rows, (r) => r.description.startsWith('SUPPLIER'), 10);
    const [removed] = copy.rows.splice(i, 1);
    return { copy, row: i, size: removed.debit };
  },
  swappedColumns(s) {
    const copy = clone(s);
    const i = indexOfNth(copy.rows, (r) => r.description === 'SHOP RENT', 2);
    [copy.rows[i].debit, copy.rows[i].credit] = [copy.rows[i].credit, copy.rows[i].debit];
    return { copy, row: i, size: 2 * 28000 };
  },
  duplicatedLine(s) {
    const copy = clone(s);
    const i = 60;
    copy.rows.splice(i + 1, 0, { ...copy.rows[i] });
    return { copy, row: i + 1 };
  },
};

// Arithmetic is correct here; only the behaviour is unusual.
function suspiciousStatement() {
  const base = businessStatement({ seed: 23, opening: 180000 });
  const entries = base.rows.map(({ date, description, debit, credit }) => ({ date, description, debit, credit }));
  const insert = (entry) => {
    const at = entries.findIndex((e) => e.date > entry.date);
    entries.splice(at < 0 ? entries.length : at, 0, entry);
  };
  insert({ date: '2026-08-11', description: 'FUND TRANSFER FROM R. ENTERPRISE', debit: 0, credit: 300000 });
  insert({ date: '2026-08-13', description: 'FUND TRANSFER TO R. ENTERPRISE', debit: 300000, credit: 0 });
  insert({ date: '2026-10-27', description: 'CASH DEPOSIT BRANCH', debit: 0, credit: 900000 });
  return withBalances(entries, base.opening);
}

// --- Writers ---
const HEADER = ['Date', 'Description', 'Reference', 'Debit', 'Credit', 'Balance'];

const dmy = (iso) => iso.split('-').reverse().join('/');

function tableRows(statement, figures) {
  return [
    HEADER,
    ['', 'Opening Balance', '', '', '', figures.opening.toFixed(2)],
    ...statement.rows.map((r) => [
      dmy(r.date), r.description, r.reference,
      r.debit ? r.debit.toFixed(2) : '', r.credit ? r.credit.toFixed(2) : '', r.balance.toFixed(2),
    ]),
    ['', 'Total', '', figures.totalDebit.toFixed(2), figures.totalCredit.toFixed(2), ''],
    ['', 'Closing Balance', '', '', '', figures.closing.toFixed(2)],
  ];
}

const toCsv = (rows) =>
  rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n';

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text);
    const nameBytes = Buffer.from(name);
    const common = Buffer.alloc(26);
    common.writeUInt16LE(20, 0);
    common.writeUInt16LE(0x21, 8); // fixed date 1980-01-01 keeps output stable
    common.writeUInt32LE(zlib.crc32(data), 10);
    common.writeUInt32LE(data.length, 14);
    common.writeUInt32LE(data.length, 18);
    common.writeUInt16LE(nameBytes.length, 22);
    const local = Buffer.concat([Buffer.from('504b0304', 'hex'), common, nameBytes, data]);
    const entry = Buffer.alloc(14);
    entry.writeUInt32LE(offset, 10);
    central.push(Buffer.concat([Buffer.from('504b01021400', 'hex'), common, entry, nameBytes]));
    locals.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// Dates are written as real Excel date cells and amounts as numbers.
function toXlsx(rows) {
  const xmlText = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cell = (value, column, row) => {
    const ref = `${'ABCDEF'[column]}${row}`;
    if (value === '') return '';
    const date = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (date) {
      const serial = (Date.UTC(+date[3], +date[2] - 1, +date[1]) - Date.UTC(1899, 11, 30)) / 86400000;
      return `<c r="${ref}" s="1"><v>${serial}</v></c>`;
    }
    if (row > 1 && column >= 3) return `<c r="${ref}"><v>${Number(value)}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t>${xmlText(value)}</t></is></c>`;
  };
  const sheet = rows
    .map((r, i) => `<row r="${i + 1}">${r.map((v, c) => cell(v, c, i + 1)).join('')}</row>`)
    .join('');
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const pkg = 'http://schemas.openxmlformats.org/package/2006';
  const kind = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  return zip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${pkg}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${kind}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${kind}.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="${kind}.styles+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${pkg}/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${pkg}/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${main}"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${main}"><sheetData>${sheet}</sheetData></worksheet>`],
  ]);
}

// A tiny PDF writer: each page is a list of [x, y, text].
function toPdf(pages, { drawing = '' } = {}) {
  const objects = [];
  const reserve = () => objects.push('') - 1 + 1;
  const catalog = reserve();
  const tree = reserve();
  const font = reserve();
  objects[font - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const kids = pages.map((cells) => {
    const page = reserve();
    const content = reserve();
    const body = drawing + cells
      .map(([x, y, text]) => `BT /F1 8 Tf 1 0 0 1 ${x} ${y} Tm (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`)
      .join('\n');
    objects[content - 1] = `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`;
    objects[page - 1] = `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`;
    return `${page} 0 R`;
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const at = Buffer.byteLength(pdf);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

// Mimics a common bank layout: the description wraps onto a second line and the
// empty debit or credit column prints nothing.
function statementPdf(statement, figures) {
  const PER_PAGE = 26;
  const pages = [];
  for (let start = 0; start < statement.rows.length; start += PER_PAGE) {
    const cells = [];
    let y = 800;
    const line = (items) => {
      for (const [x, text] of items) cells.push([x, y, text]);
      y -= 12;
    };
    line([[40, 'Shapla Commercial Bank (fictitious) - SYNTHETIC STATEMENT']]);
    if (start === 0) {
      line([[40, 'Account holder: Padma Traders']]);
      line([[40, 'Account number: XXXXXX4821']]);
      line([[40, 'Statement period: 01/05/2026 to 31/10/2026']]);
      line([[40, 'Opening Balance'], [300, money(figures.opening)]]);
      line([[40, 'Closing Balance'], [300, money(figures.closing)]]);
      line([[40, 'Total Debit'], [300, money(figures.totalDebit)]]);
      line([[40, 'Total Credit'], [300, money(figures.totalCredit)]]);
    }
    y -= 6;
    line([[40, 'Date'], [105, 'Description'], [330, 'Debit'], [410, 'Credit'], [490, 'Balance']]);
    for (const r of statement.rows.slice(start, start + PER_PAGE)) {
      line([
        [40, dmy(r.date)], [105, r.description],
        [r.debit ? 330 : 410, money(r.debit || r.credit)], [490, money(r.balance)],
      ]);
      line([[105, `Ref ${r.reference}`]]);
    }
    cells.push([40, 30, `Page ${pages.length + 1}`]);
    pages.push(cells);
  }
  return toPdf(pages);
}

// Mimics a second common layout with fictitious data: the text stream gives the
// date, then all three amounts (empty side printed as 0.00), then narration
// lines (one is a timestamp), and a closing summary whose figures come before
// their labels, in a different order.
function amountsFirstPdf(statement, figures) {
  const PER_PAGE = 20;
  const pages = [];
  for (let start = 0; start < statement.rows.length; start += PER_PAGE) {
    const cells = [
      [40, 815, 'Karnaphuli Sample Bank (fictitious) - SYNTHETIC STATEMENT'],
      [40, 790, 'Date'], [110, 790, 'Narration'], [300, 790, 'Type'], [370, 790, 'Debit'], [440, 790, 'Credit'], [510, 790, 'Balance'],
    ];
    if (start === 0) cells.push([40, 803, 'Period 01/05/2026 to 31/10/2026']);
    let y = 772;
    for (const r of statement.rows.slice(start, start + PER_PAGE)) {
      const stamp = `${dmy(r.date).slice(0, 6).replace(/\//g, '-')}26 10:15:22`;
      cells.push(
        [40, y, dmy(r.date)],
        [370, y - 1, money(r.debit)], [440, y - 1, money(r.credit)], [510, y - 1, money(r.balance)],
        [110, y, r.description], [110, y - 11, `TrxId ${r.reference}`], [110, y - 22, stamp],
        [300, y, 'Transfer'],
      );
      y -= 36;
    }
    cells.push([500, 25, `Page ${pages.length + 1} of ${Math.ceil(statement.rows.length / PER_PAGE)}`]);
    pages.push(cells);
  }
  pages.push([
    [450, 700, money(figures.opening)], [450, 640, money(figures.closing)],
    [450, 680, money(figures.totalDebit)], [450, 660, money(figures.totalCredit)],
    [330, 700.5, 'Opening Balance:'], [330, 680.5, 'Total Debit:'],
    [330, 660.5, 'Total Credit:'], [330, 640.5, 'Closing Balance:'],
  ]);
  return toPdf(pages);
}

function walletCsv() {
  const { rows } = businessStatement({ seed: 11, opening: 90000 });
  let balance = 90000;
  const out = [['Date Time', 'Type', 'Details', 'TrxID', 'Amount', 'Fee', 'Balance']];
  rows.forEach((r, i) => {
    // Wallet exports use unsigned amounts, so a reversal is money received.
    const net = r.credit - r.debit;
    const type = net > 0 ? 'Received Money' : 'Send Money';
    const amount = Math.abs(net);
    const fee = net < 0 && i % 3 === 0 ? 5 : 0;
    balance = cents(balance + r.credit - r.debit - fee);
    out.push([`${dmy(r.date)} 10:15`, type, r.description, `W${700000 + i}`, amount.toFixed(2), fee.toFixed(2), balance.toFixed(2)]);
  });
  return toCsv(out);
}

function generate() {
  fs.mkdirSync(OUT, { recursive: true });
  const write = (name, content) => fs.writeFileSync(path.join(OUT, name), content);
  const good = businessStatement();
  const figures = printedFigures(good);

  write('01-correct.csv', toCsv(tableRows(good, figures)));
  const faultFiles = {
    '02-altered-amount.csv': 'alteredAmount',
    '03-altered-balance.csv': 'alteredBalance',
    '04-missing-entry.csv': 'missingEntry',
    '05-swapped-debit-credit.csv': 'swappedColumns',
    '06-duplicated-line.csv': 'duplicatedLine',
  };
  const expected = {};
  for (const [file, fault] of Object.entries(faultFiles)) {
    const { copy, row, size } = FAULTS[fault](good);
    write(file, toCsv(tableRows(copy, figures)));
    // File row: header + opening-balance row come first.
    expected[file] = { row: row + 3, size: size ?? null };
  }
  write('07-wrong-printed-totals.csv', toCsv(tableRows(good, {
    ...figures, totalCredit: cents(figures.totalCredit + 200000), closing: cents(figures.closing + 200000),
  })));
  const suspicious = suspiciousStatement();
  write('08-suspicious-pattern.csv', toCsv(tableRows(suspicious, printedFigures(suspicious))));
  write('09-correct.xlsx', toXlsx(tableRows(good, figures)));
  write('10-correct.pdf', statementPdf(good, figures));
  write('11-altered-amount.pdf', statementPdf(FAULTS.alteredAmount(good).copy, figures));
  write('12-wallet-correct.csv', walletCsv());
  write('13-missing-columns.csv', 'Date,Description,Amount\n01/05/2026,POS SALES,1000.00\n');
  write('14-scanned-image.pdf', toPdf([[]], { drawing: '0.8 g 60 200 470 560 re f\n' }));
  write('15-unsupported.txt', 'This is not a bank statement.\n');
  write('16-amounts-first-layout.pdf', amountsFirstPdf(good, figures));
  const several = ['alteredAmount', 'alteredBalance', 'swappedColumns']
    .reduce((statement, fault) => FAULTS[fault](statement).copy, good);
  write('17-multiple-faults.csv', toCsv(tableRows(several, figures)));
  write('expected-fault-rows.json', `${JSON.stringify(expected, null, 2)}\n`);
}

if (require.main === module) {
  generate();
  console.log(`Sample statements written to ${path.relative(process.cwd(), OUT)}/`);
}

module.exports = { generate, businessStatement };
