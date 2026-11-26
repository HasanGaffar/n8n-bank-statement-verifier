# Statement checker rules

**Author:** Hasan Gaffar

Generated from `src/checklist.js` by `npm run build`. These rules are an illustrative verification policy, not a regulatory standard.

Each check ends as **OK**, **DISCREPANCY** or **NA** (not applicable). Severity of a discrepancy: **HIGH** = fault, **MEDIUM** = needs review, **LOW** = information. A few checks raise or lower their severity depending on the count.

## A. Reading completeness

| ID | Check | Severity | Rule |
|---|---|---|---|
| A001 | Every transaction line was read | MEDIUM | A line that cannot be read means the statement is not fully verified. Above 20% the result is INCONCLUSIVE. |
| A002 | Each entry is either a debit or a credit | MEDIUM | One line must not carry both a debit and a credit. |
| A003 | An opening balance is printed | LOW | Without an opening balance the first transaction cannot be checked. |

## B. Arithmetic accuracy

| ID | Check | Severity | Rule |
|---|---|---|---|
| B001 | Every running balance is correct | HIGH | Previous balance + credit - debit must equal the new balance, within 0.01. |
| B002 | Opening + credits - debits gives the closing balance | HIGH | The sum of all entries must lead from the opening balance to the closing balance. |
| B003 | Printed closing balance matches the last row | HIGH | The closing balance in the summary must equal the balance after the last transaction. |
| B004 | Printed total credits matches the entries | HIGH | The printed credit total must equal the sum of all credit entries. |
| B005 | Printed total debits matches the entries | HIGH | The printed debit total must equal the sum of all debit entries. |
| B006 | No printed summary figure is left unexplained | HIGH | Every figure in the printed summary block must be explained by the transactions. |

## C. Dates and sequence

| ID | Check | Severity | Rule |
|---|---|---|---|
| C001 | Transactions are in date order | MEDIUM | Dates must not go backwards within the statement. |
| C002 | All dates fall inside the printed period | MEDIUM | Every transaction must belong to the statement period. |
| C003 | No transaction is dated in the future | HIGH | No transaction may be dated after the verification date. |
| C004 | No long silent period | LOW | A gap of more than 31 days can mean missing pages. |

## D. Duplicates and unusual entries

| ID | Check | Severity | Rule |
|---|---|---|---|
| D001 | No transaction reference is reused | MEDIUM | One reference must not appear twice with the same amount. |
| D002 | No identical same-day entries | LOW | Entries without a reference that match on date, text and amount need a look. |
| D003 | No amount far outside the usual range | LOW | An amount over 10 times the typical credit or debit is pointed out. |
| D004 | Account is not overdrawn | LOW | The balance should not fall below zero. |
| D005 | No bounced or returned payments | MEDIUM | One returned payment is information; two or more need review. |
| D006 | Reversal entries are accounted for | LOW | A negative amount in a debit or credit column is a reversal. It keeps its sign in every calculation. |

## E. Suspicious patterns

| ID | Check | Severity | Rule |
|---|---|---|---|
| E001 | No unusual large deposit just before the end | MEDIUM | A deposit in the last 14 days that is at least half of monthly inflow and 4 times the typical credit must be explained. |
| E002 | No money moved in and straight out | MEDIUM | A large credit that leaves within 3 days at nearly the same amount must be explained. |
| E003 | File was not submitted for another account holder | HIGH | The same statement file must not belong to two different people. |

## Verdict (first match wins)

| Verdict | Condition |
|---|---|
| INCONCLUSIVE | No balance can be checked; or 3 or more balance checks fail and they are over half of all checks; or over 20% of lines are unread. |
| FAULTS_FOUND | Any HIGH discrepancy. |
| REVIEW_REQUIRED | Any MEDIUM discrepancy. |
| VERIFIED | Otherwise. |

`accountsCorrect` is `false` when any section B check fails, `null` when it cannot be established, and `true` otherwise.

## Likely cause of a balance fault

| Cause | How it is recognised |
|---|---|
| WRONG_BALANCE_FIGURE | The next row is wrong by the same amount in the opposite direction. |
| DUPLICATED_LINE | The row repeats the previous row, including its balance. |
| DEBIT_CREDIT_SWAPPED | The difference is exactly twice the amount. |
| WRONG_AMOUNT_OR_MISSING_ENTRY | None of the above. |

## Reading rules

- A negative figure in a debit or credit column is a reversal and keeps its sign. If a whole column is negative, the sign is only the bank's notation.
- When a PDF row has one amount and a balance, debit or credit follows from how the balance moved.
- When a PDF row prints both columns, the column order is learned from the whole statement and applied to every row.
- Printed summary figures that are separated from their labels are matched against calculated totals; two or more unexplained figures fail check B006.
- A line carrying an amount and a balance is read as a transaction or reported; it is never silently dropped. An isolated undated line with a single amount is not reported.
