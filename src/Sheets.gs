/**
 * Google Sheets as a lightweight CRM.
 * Columns are resolved by header name, so the client can reorder or add columns freely.
 */

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function getLeadsSheet_() {
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.SHEET_LEADS);
  if (!sheet) throw new Error('Sheet "' + CONFIG.SHEET_LEADS + '" not found. Run setup() first.');
  return sheet;
}

/** { 'ID': 1, 'Received At': 2, ... } — 1-based column indexes. */
function headerIndex_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach(function (h, i) { if (h) map[String(h).trim()] = i + 1; });
  COLUMNS.forEach(function (c) {
    if (!map[c]) throw new Error('Column "' + c + '" is missing in the Leads sheet.');
  });
  return map;
}

function findRowById_(sheet, id) {
  const col = headerIndex_(sheet)['ID'];
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const ids = sheet.getRange(2, col, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === id) return i + 2;
  }
  return 0;
}

function appendLead_(sheet, record) {
  const idx = headerIndex_(sheet);
  const row = new Array(sheet.getLastColumn()).fill('');
  Object.keys(record).forEach(function (k) {
    if (idx[k]) row[idx[k] - 1] = sanitizeCell_(record[k]);
  });
  sheet.appendRow(row);
}

/** Updates only the given fields of the row with this ID (row is looked up by ID, not cached). */
function updateLead_(sheet, id, fields) {
  const rowNum = findRowById_(sheet, id);
  if (!rowNum) throw new Error('Lead ' + id + ' not found in sheet');
  const idx = headerIndex_(sheet);
  Object.keys(fields).forEach(function (k) {
    if (idx[k]) sheet.getRange(rowNum, idx[k]).setValue(sanitizeCell_(fields[k]));
  });
}

/** All rows as objects keyed by header name. */
function readLeads_(sheet) {
  const values = sheet.getDataRange().getValues();
  const headers = values.shift().map(String);
  return values.map(function (r) {
    const o = {};
    headers.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}

/**
 * Form input is untrusted: a value starting with = + - @ would be executed
 * as a formula in Sheets (CSV/formula injection). Prefix it with a quote.
 */
function sanitizeCell_(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function log_(level, message, details) {
  console.log('[' + level + '] ' + message + (details ? ' ' + JSON.stringify(details) : ''));
  try {
    const sheet = getSpreadsheet_().getSheetByName(CONFIG.SHEET_LOG);
    if (sheet) sheet.appendRow([new Date(), level, message, details ? JSON.stringify(details) : '']);
  } catch (e) {
    console.error('Log sheet write failed: ' + e);
  }
}
