/**
 * File      : src/util.js
 * Author    : Hasan Gaffar
 * Project   : n8n Bank Statement Verifier
 * Purpose   : Shared helpers: rounding, statistics, timezone-safe dates, money formatting.
 * n8n node  : Pasted into every n8n Code node that needs these helpers.
 */
// Shared helpers. The build script prepends this file to Code nodes that need it.

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const sum = (values) => values.reduce((total, v) => total + v, 0);
const mean = (values) => (values.length ? sum(values) / values.length : 0);

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const stdDev = (values) => {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - avg) ** 2)));
};

// Dates are handled as 'YYYY-MM-DD' strings and UTC day numbers, so the
// server timezone can never shift a transaction into another day.
const toDay = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);
const fromDay = (day) => new Date(day * 86400000).toISOString().slice(0, 10);

const AVG_DAYS_PER_MONTH = 30.4375;

const formatMoney = (n) =>
  Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// --- exports ---
module.exports = {
  round2, sum, mean, median, stdDev, toDay, fromDay,
  AVG_DAYS_PER_MONTH, formatMoney,
};
