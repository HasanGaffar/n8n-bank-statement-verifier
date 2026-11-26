/**
 * File      : src/request.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Validates the API request and returns a clear error code when it is not acceptable.
 * n8n node  : Check Request
 * Flow      : Receive Statement -> Ensure Audit Table -> [Check Request] -> Request OK?
 */
// Validates the API request before the file is processed.
// --- imports ---
const { parseDate } = require('./parse');
// --- end imports ---

const SUPPORTED_TYPES = ['csv', 'xlsx', 'pdf'];
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const fail = (status, code, message) => ({ valid: false, httpStatus: status, error: { code, message } });

// `file` is { fileName, sizeBytes } or null. `today` is 'YYYY-MM-DD'.
function checkRequest({ body, file, today }) {
  const text = (name, max) => String(body[name] ?? '').trim().slice(0, max);
  const reference = text('reference', 60);

  const check = () => {
    if (!file) {
      return fail(400, 'MISSING_FILE', 'Send the statement as a multipart/form-data file field named "statement".');
    }
    let asOfDate = today;
    if (text('as_of_date', 20)) {
      asOfDate = parseDate(text('as_of_date', 20));
      if (!asOfDate) return fail(400, 'INVALID_FIELD', '"as_of_date" must be a date such as 2026-11-26.');
    }
    const fileType = String(file.fileName || '').toLowerCase().split('.').pop();
    if (!SUPPORTED_TYPES.includes(fileType)) {
      return fail(415, 'UNSUPPORTED_FILE_TYPE', `Supported file types: ${SUPPORTED_TYPES.join(', ')}.`);
    }
    if (file.sizeBytes > MAX_FILE_BYTES) return fail(413, 'FILE_TOO_LARGE', 'The file is larger than 5 MB.');
    return {
      valid: true,
      accountHolder: text('account_holder', 120),
      asOfDate,
      aiReview: text('ai_review', 5).toLowerCase() === 'true',
      fileName: file.fileName,
      fileType,
    };
  };

  return { reference, ...check() };
}

// --- exports ---
module.exports = { checkRequest, SUPPORTED_TYPES, MAX_FILE_BYTES };
