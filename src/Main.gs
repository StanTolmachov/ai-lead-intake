/**
 * Entry points:
 *   onFormSubmit(e) — installable trigger from a Google Form linked to the spreadsheet
 *   doPost(e)       — web app endpoint for any website form / Zapier / Make / Webflow
 *   retryFailed()   — re-processes rows with Status = ERROR
 */

function onFormSubmit(e) {
  const raw = mapFormResponse_(e && e.namedValues ? e.namedValues : {});
  processLead_(raw, 'google_form');
}

function doPost(e) {
  try {
    const body = parseBody_(e);
    const expected = getSecret_('WEBHOOK_TOKEN', false);
    const given = body.token || (e && e.parameter && e.parameter.token) || '';
    if (expected && given !== expected) return json_({ ok: false, error: 'unauthorized' });

    const result = processLead_(body, body.source || 'webhook');
    return json_({ ok: true, id: result.id, status: result.status });
  } catch (err) {
    log_('ERROR', 'doPost failed', { error: String(err) });
    return json_({ ok: false, error: String(err.message || err) });
  }
}

/**
 * Core pipeline: validate → dedupe → save → AI → update row → draft → alert.
 * The row is saved BEFORE the AI call, so a lead is never lost if Gemini fails.
 */
function processLead_(raw, source) {
  const lead = normalizeLead_(raw);
  const problems = validateLead_(lead);
  if (problems.length) {
    log_('WARN', 'Rejected invalid lead', { problems: problems, email: lead.email });
    throw new Error('Invalid lead: ' + problems.join(', '));
  }

  const id = leadId_(lead);
  const sheet = getLeadsSheet_();

  // Lock only around the check-and-append, never around the slow AI call.
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (findRowById_(sheet, id)) {
      log_('INFO', 'Duplicate lead skipped', { id: id });
      return { id: id, status: STATUS.DUPLICATE };
    }
    appendLead_(sheet, {
      'ID': id,
      'Received At': new Date(),
      'Source': source,
      'Name': lead.name,
      'Email': lead.email,
      'Company': lead.company,
      'Message': lead.message,
      'Status': STATUS.NEW,
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  return enrichLead_(sheet, id, lead);
}

function enrichLead_(sheet, id, lead) {
  let analysis;
  try {
    analysis = analyzeLead_(lead);
  } catch (err) {
    updateLead_(sheet, id, { 'Status': STATUS.ERROR, 'Error': String(err.message || err) });
    log_('ERROR', 'AI analysis failed', { id: id, error: String(err) });
    return { id: id, status: STATUS.ERROR };
  }

  updateLead_(sheet, id, {
    'Company': lead.company || analysis.company,
    'Category': analysis.category,
    'Score': analysis.score,
    'Priority': analysis.priority,
    'Budget': analysis.budget,
    'Timeline': analysis.timeline,
    'Summary': analysis.summary,
    'Missing Info': analysis.missingInfo.join(', '),
    'Language': analysis.language,
    'Reply Draft': analysis.replyDraft,
    'Status': STATUS.DONE,
    'Error': '',
  });

  // Side effects are best-effort: a Slack outage must not mark the lead as failed.
  runSideEffect_('gmail_draft', id, function () { createReplyDraft_(lead, analysis); });
  if (analysis.priority === 'hot') {
    runSideEffect_('slack_alert', id, function () { notifySlack_(id, lead, analysis); });
  }

  log_('INFO', 'Lead processed', { id: id, category: analysis.category, score: analysis.score });
  return { id: id, status: STATUS.DONE, priority: analysis.priority };
}

function retryFailed() {
  const sheet = getLeadsSheet_();
  const failed = readLeads_(sheet).filter(function (r) { return r['Status'] === STATUS.ERROR; });
  failed.forEach(function (r) {
    enrichLead_(sheet, String(r['ID']), {
      name: String(r['Name']), email: String(r['Email']),
      company: String(r['Company'] || ''), message: String(r['Message']),
    });
  });
  log_('INFO', 'retryFailed finished', { count: failed.length });
}

// ---------- helpers ----------

function normalizeLead_(raw) {
  const clean = function (v, max) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  };
  return {
    name: clean(raw.name, 200),
    email: clean(raw.email, 254).toLowerCase(),
    company: clean(raw.company, 200),
    message: String(raw.message == null ? '' : raw.message).trim().slice(0, 5000),
  };
}

function validateLead_(lead) {
  const problems = [];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) problems.push('invalid email');
  if (lead.message.length < 5) problems.push('empty message');
  return problems;
}

/** Same email + same message = same lead (protects against double submits and webhook retries). */
function leadId_(lead) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    lead.email + '|' + lead.message.toLowerCase().replace(/\s+/g, ' '),
    Utilities.Charset.UTF_8
  );
  return digest.slice(0, 6).map(function (b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2);
  }).join('');
}

function mapFormResponse_(namedValues) {
  const lower = {};
  Object.keys(namedValues).forEach(function (k) {
    const v = namedValues[k];
    lower[k.trim().toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  });
  const out = {};
  Object.keys(CONFIG.FORM_FIELDS).forEach(function (field) {
    const match = CONFIG.FORM_FIELDS[field].filter(function (t) { return t in lower; })[0];
    out[field] = match ? lower[match] : '';
  });
  return out;
}

function parseBody_(e) {
  if (e && e.postData && e.postData.contents) {
    const type = String(e.postData.type || '');
    if (type.indexOf('json') >= 0) return JSON.parse(e.postData.contents);
  }
  return (e && e.parameter) || {};
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function runSideEffect_(name, id, fn) {
  try {
    fn();
  } catch (err) {
    log_('WARN', name + ' failed', { id: id, error: String(err) });
  }
}
