/**
 * File      : src/categorize.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Rule-based transaction categories.
 * n8n node  : Categorize Transactions
 * Flow      : Check Arithmetic -> [Categorize Transactions] -> Detect Patterns
 */
// Rule-based categories. The first matching rule wins, so order matters.
// To support a new bank's wording, add a keyword to the right rule.

const CREDIT_RULES = [
  ['REVERSAL', /\b(reversal|reversed|refund|returned)\b/i],
  ['LOAN_DISBURSEMENT', /\bloan\b.*\b(disb\w*|credit|proceeds)\b|\bdisbursement\b/i],
  ['SALARY', /\b(salary|payroll)\b/i],
  ['SALES', /\b(sales?|pos|merchant|customer payment|payment received|qr)\b/i],
  ['CASH_DEPOSIT', /\b(cash dep\w*|cash in|cdm)\b/i],
  ['REMITTANCE', /\b(remittance|western union|moneygram)\b/i],
  ['INTEREST', /\b(interest|profit credit)\b/i],
  ['TRANSFER_IN', /\b(transfer|trf|beftn|npsb|rtgs|eft|received money|add money)\b/i],
];

const DEBIT_RULES = [
  ['BOUNCE_CHARGE', /\b(bounced?|insufficient|dishonou?r\w*|(cheque|chq|emi) return\w*|return charge)\b/i],
  ['BANK_CHARGE', /\b(service charge|maintenance|sms (charge|fee)|vat|excise|account fee|annual fee)\b/i],
  ['LOAN_REPAYMENT', /\b(emi|loan|installment|instalment)\b/i],
  ['SUPPLIER', /\b(supplier|wholesale|purchase|stock|distributor)\b/i],
  ['RENT', /\brent\b/i],
  ['PAYROLL', /\b(salary|wages?|payroll)\b/i],
  ['UTILITIES', /\b(electric\w*|desco|dpdc|wasa|gas|titas|internet|utility|bill)\b/i],
  ['MOBILE', /\b(recharge|top ?up)\b/i],
  ['CASH_WITHDRAWAL', /\b(atm|withdraw\w*|cash wd|cash out)\b/i],
  ['BANK_CHARGE', /\b(charge|fee)\b/i],
  ['TRANSFER_OUT', /\b(transfer|trf|beftn|npsb|rtgs|eft|send money)\b/i],
];

function categorize(transaction) {
  if (transaction.debit < 0 || transaction.credit < 0) return 'REVERSAL';
  const isCredit = transaction.credit > 0;
  const rules = isCredit ? CREDIT_RULES : DEBIT_RULES;
  const rule = rules.find(([, pattern]) => pattern.test(transaction.description));
  if (rule) return rule[0];
  return isCredit ? 'OTHER_INCOME' : 'OTHER_EXPENSE';
}

const categorizeAll = (transactions) => transactions.map((t) => ({ ...t, category: categorize(t) }));

// Money that arrives but is not earned by the applicant.
const NON_OPERATING_CREDITS = ['LOAN_DISBURSEMENT', 'REVERSAL'];

// --- exports ---
module.exports = { categorize, categorizeAll, NON_OPERATING_CREDITS };
