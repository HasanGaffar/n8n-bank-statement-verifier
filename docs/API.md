# API Reference

**Author:** Hasan Gaffar

## Configuration with .env

The helper scripts need no machine-specific paths in the code. To use your own files and n8n instance, copy `.env.example` to `.env` in the project root and edit it. `.env` is optional and ignored by git, and variables already set in the real environment take priority over it. Node.js loads it without extra dependencies. It configures these scripts only, not n8n or the workflow.

| Variable | Default | Use |
|---|---|---|
| `N8N_BASE_URL` | `http://localhost:5678` | Address of your running n8n. |
| `WEBHOOK_PATH` | `verify-statement` | Path after `/webhook/`. |
| `SAMPLE_DIR` | `sample-data` | Folder of the project samples and `expected-fault-rows.json`, used by `npm run e2e`. |
| `STATEMENT_FILE` | none | Statement sent by `npm run verify` when no file argument is given. |
| `ACCOUNT_HOLDER` | empty | `account_holder` for `verify`. |
| `AS_OF_DATE` | empty | `as_of_date` for `verify`. |
| `AI_REVIEW` | `false` | `true` requests the AI review in `verify`. |
| `WEBHOOK_AUTH_HEADER_NAME`, `WEBHOOK_AUTH_HEADER_VALUE` | empty | Header sent by both scripts when Header Auth is enabled; set both or neither. |

Paths can be absolute, relative or start with `~` (the home folder). **Relative paths, including the file argument, start at the project root**, not at the current directory. Do not double-quote Windows paths in `.env` (`\n` inside double quotes becomes a line break); put a value containing `#` in single quotes.

Do **not** put the Anthropic API key in `.env`: enter it in n8n as an Anthropic credential.

```bash
npm run verify -- path/to/statement.csv          # short summary
npm run verify -- path/to/statement.csv --json   # raw response
npm run e2e                                      # all samples plus a request without a file
```

`verify` exits with 0 only for an HTTP 200 response with `success: true`; this does not mean the statement passed, so read the verdict. A missing file, an unreachable server, or an empty, non-JSON or unrecognised response gives a non-zero exit code. `e2e` always sends `as_of_date=2026-11-26` and `ai_review=false`, and exits with 1 on any failure. Both scripts add rows to the audit table.

## `POST /webhook/verify-statement`

The request is `multipart/form-data`. The Webhook node in the build script configures no authentication; add access control before exposing the endpoint.

| Field | Required | Description |
|---|---|---|
| `statement` | Yes | File: `.csv`, `.xlsx` or text-based `.pdf`, up to 5 MB (5,242,880 bytes, compared with the rounded size n8n reports). The type is taken from the extension. If this field is absent, the workflow uses the first uploaded file. |
| `account_holder` | No | Account holder name; trimmed to 120 characters. Used to detect the same file submitted under another name. |
| `reference` | No | Your reference; trimmed to 60 characters. |
| `as_of_date` | No | Verification date, for example `2026-11-26`; defaults to the current UTC date. |
| `ai_review` | No | `true` (case-insensitive) requests the advisory AI review. Requires an Anthropic credential on both Claude nodes. |

A statement may produce at most 20,000 transactions and unread lines combined.

## Success response (HTTP 200)

`success: true` means the statement was processed, **not** that it passed. Read `result.verdict`.

| Key | Meaning |
|---|---|
| `success` | `true`. |
| `reference` | Yours, or `STM-<processing date YYYYMMDD>-<first 8 characters of the SHA-256>`. |
| `accountHolder` | Supplied name, or an empty string. |
| `statement` | `fileName`, `fileType`, `sha256`, `periodStart`, `periodEnd`, `transactionCount`, `verifiedAsOf`. |
| `result` | `verdict` (`VERIFIED`, `REVIEW_REQUIRED`, `FAULTS_FOUND`, `INCONCLUSIVE`), `accountsCorrect` (`true`, `false`, `null`) and `headline`. |
| `reconciliation` | Opening balance and its source, total credit and debit, calculated closing balance, last row balance, printed closing and totals (`null` if unavailable), `unexplainedDifference` (printed closing, or else last row balance, minus calculated closing) and `balanceCalculationsChecked`. |
| `faults` | Up to 100 balance faults: `row`, `date`, `description`, `debit`, `credit`, `expectedBalance`, `shownBalance`, `difference`, `cause`, `explanation`, `summary`. `row` is the spreadsheet row (header is row 1) or the line number in the extracted PDF text. |
| `faultCount` | Total balance faults, including any beyond the first 100. Other discrepancies are not counted here. |
| `verification` | `summary` (`totalChecks`, `ok`, `discrepancy`, `notApplicable`), `discrepancies` (ordered by severity) and `sections` with every check. AI notes appear as `aiNote` on check items. |
| `analysis` | `periodStart`, `periodEnd`, `transactionCount`, `creditCount`, `debitCount`, `netChange`, `averageDailyBalance`, `lowestBalance`, `highestBalance`, `largestCredit`, `largestDebit`, `monthly`, `categories`. |
| `unreadLines` | Up to 50 rejected lines, each with `row` and `reason`. |
| `aiReview` | `requested`, `status` (`NOT_REQUESTED`, `COMPLETED`, `PARTIAL`, `UNAVAILABLE`), `concerns`, `failedSections`; when requested, also `routing` and `usage` (tokens and estimated cost). |
| `processing` | `straightThrough` (`true` only for `VERIFIED` with nothing to handle), `manualHandling` (reasons for human review) and `durationMs` (processing time in milliseconds). When a review ran, `aiReview.durationMs` is also present. |
| `audit` | Audit record: `table`, `rowId`, `loggedAt`. |

### Example

All values are fictitious. The example is shortened: some arrays are left empty or partial, and `analysis` shows only some of its keys.

```json
{
  "success": true,
  "reference": "EXAMPLE-001",
  "accountHolder": "Example Trading Co",
  "statement": {
    "fileName": "example.csv", "fileType": "csv", "sha256": "<64 hex characters>",
    "periodStart": "2026-01-05", "periodEnd": "2026-01-20",
    "transactionCount": 3, "verifiedAsOf": "2026-11-26"
  },
  "result": {
    "verdict": "FAULTS_FOUND", "accountsCorrect": false,
    "headline": "The accounts do not add up: 1 fault(s), first at row 5."
  },
  "reconciliation": {
    "openingBalance": 10000, "openingBalanceSource": "stated",
    "totalCredit": 5000, "totalDebit": 3000,
    "calculatedClosingBalance": 12000, "lastRowBalance": 12500,
    "printedClosingBalance": null, "printedTotalCredit": null, "printedTotalDebit": null,
    "unexplainedDifference": 500, "balanceCalculationsChecked": 3
  },
  "faults": [{
    "row": 5, "date": "2026-01-20", "description": "EXAMPLE PAYMENT",
    "debit": 1000, "credit": 0,
    "expectedBalance": 12000, "shownBalance": 12500, "difference": 500,
    "cause": "WRONG_AMOUNT_OR_MISSING_ENTRY",
    "explanation": "Either the amount on this row is wrong by 500.00, or a credit of 500.00 is missing just before it.",
    "summary": "Row 5, 2026-01-20: expected 12,000.00 but the statement shows 12,500.00."
  }],
  "faultCount": 1,
  "verification": {
    "summary": { "totalChecks": 22, "ok": 13, "discrepancy": 2, "notApplicable": 7 },
    "discrepancies": [],
    "sections": []
  },
  "analysis": { "periodStart": "2026-01-05", "periodEnd": "2026-01-20", "transactionCount": 3, "netChange": 2000 },
  "unreadLines": [],
  "aiReview": { "requested": false, "status": "NOT_REQUESTED", "concerns": [], "failedSections": [] },
  "processing": { "straightThrough": false, "manualHandling": ["B001 (HIGH): Every running balance is correct", "B002 (HIGH): Opening + credits - debits gives the closing balance"], "durationMs": 180 },
  "audit": { "table": "statement_audit_log", "rowId": 1, "loggedAt": "2026-11-26T10:00:00.000Z" }
}
```

## Error response

Handled errors, except `AUDIT_UNAVAILABLE` (below), are also recorded in the audit table before the response is sent. Like success responses, they carry `processing.durationMs`, and `aiReview.durationMs` when a review ran. This time is measured from request checking until the audit record is prepared, so it excludes the final save and send.

```json
{
  "success": false,
  "reference": "REQ-123",
  "error": { "code": "UNSUPPORTED_FILE_TYPE", "message": "Supported file types: csv, xlsx, pdf." },
  "processing": { "durationMs": 25 },
  "audit": { "table": "statement_audit_log", "rowId": 2, "loggedAt": "2026-11-26T10:01:00.000Z" }
}
```

`reference` is yours, or `REQ-<n8n execution ID>`.

**Clients must treat any response without a boolean `success` field as a failure**, including an empty body or one that is not JSON, whatever the HTTP status.

Two HTTP 500 codes cover internal failures:

- `UNEXPECTED_ERROR`: a processing node crashed. Its error output leads to `Build Error Response`, so the response has the format above. The audit row holds `failed_node` and `error_message`; the caller gets no internal detail. Quote `reference` to find the row.
- `AUDIT_UNAVAILABLE`: the audit record could not be prepared or saved (`Ensure Audit Table`, `Prepare Audit Record` or `Save Audit Log` failed). No result is returned. The body has only `success`, `reference` (always `REQ-<n8n execution ID>`) and `error`, with no `processing` or `audit`. The node `Stop With Audit Error` then fails the execution, which triggers the Error Trigger safety net so that a row is written if the database allows.

The safety net also covers other failures that stop a published webhook execution (not manual editor runs). Its row has `success=false`, `http_status=500`, `error_code=UNEXPECTED_ERROR`, `error_message`, `failed_node` and `execution_id`, but no file details or duration; its `reference` is `ERR-<execution ID>`. After `AUDIT_UNAVAILABLE`, the row therefore has a different code and reference from the response. If the database itself is unavailable, only the server log remains. A failure that no workflow path handles may not return this format.

| HTTP | Code | Cause |
|---|---|---|
| 400 | `MISSING_FILE` | No file was uploaded. |
| 400 | `INVALID_FIELD` | `as_of_date` is not a valid date. |
| 415 | `UNSUPPORTED_FILE_TYPE` | The extension is not `csv`, `xlsx` or `pdf`. |
| 413 | `FILE_TOO_LARGE` | The file is larger than 5 MB. |
| 413 | `TOO_MANY_ROWS` | More than 20,000 rows. |
| 422 | `MISSING_COLUMNS` | Required CSV or Excel columns were not found: date, balance, description (or type), and debit with credit (or amount with type). |
| 422 | `LAYOUT_NOT_SUPPORTED` | Fewer than 2 transactions were recognised in the PDF text. |
| 422 | `OCR_REQUIRED` | The PDF has fewer than 50 characters of readable text, for example a scanned image. OCR is not included. |
| 422 | `STATEMENT_UNREADABLE` | The file could not be extracted or parsed, or has no readable transactions. |
| 500 | `UNEXPECTED_ERROR` | A processing node crashed. |
| 500 | `AUDIT_UNAVAILABLE` | The audit record could not be prepared or saved; no result is returned. |

Request checks run in this order: missing file, date, file type, size. The first failure is returned.

## curl examples

Run from the project root. Set `BASE_URL` to your n8n instance; the value below assumes a local one. The workflow must be imported and active for the `/webhook/` URL.

```bash
BASE_URL=http://localhost:5678

# CSV
curl -X POST "$BASE_URL/webhook/verify-statement" \
  -F "statement=@sample-data/01-correct.csv" \
  -F "as_of_date=2026-11-26"

# CSV with an altered amount, with account holder and reference
curl -X POST "$BASE_URL/webhook/verify-statement" \
  -F "statement=@sample-data/02-altered-amount.csv" \
  -F "account_holder=Example Trading Co" \
  -F "reference=EXAMPLE-001" \
  -F "as_of_date=2026-11-26"

# Excel
curl -X POST "$BASE_URL/webhook/verify-statement" \
  -F "statement=@sample-data/09-correct.xlsx" \
  -F "as_of_date=2026-11-26"

# Text PDF with AI review
curl -X POST "$BASE_URL/webhook/verify-statement" \
  -F "statement=@sample-data/10-correct.pdf" \
  -F "ai_review=true" \
  -F "as_of_date=2026-11-26"

# Unsupported file type; -i shows the HTTP status
curl -i -X POST "$BASE_URL/webhook/verify-statement" \
  -F "statement=@sample-data/15-unsupported.txt" \
  -F "as_of_date=2026-11-26"
```
