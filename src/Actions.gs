/**
 * Outputs: Gmail reply draft, Slack alert, daily email digest.
 */

/** Creates a draft, never sends. A human reviews every reply. */
function createReplyDraft_(lead, analysis) {
  if (!CONFIG.CREATE_GMAIL_DRAFTS) return;
  if (CONFIG.SKIP_CATEGORIES_FOR_DRAFT.indexOf(analysis.category) >= 0) return;
  if (!analysis.replyDraft) return;

  const subject = 'Re: your request to ' + CONFIG.BUSINESS_NAME;
  GmailApp.createDraft(lead.email, subject, analysis.replyDraft);
}

function notifySlack_(id, lead, analysis) {
  const url = getSecret_('SLACK_WEBHOOK_URL', false);
  if (!url) return;

  const text = [
    ':fire: *Hot lead* — score ' + analysis.score + '/100',
    '*' + (lead.name || 'Unknown') + '*' + (lead.company ? ' · ' + lead.company : '') + ' · ' + lead.email,
    '> ' + analysis.summary,
    'Budget: ' + analysis.budget + ' · Timeline: ' + analysis.timeline,
    analysis.missingInfo.length ? 'Ask for: ' + analysis.missingInfo.join(', ') : '',
    'Reply draft is waiting in Gmail. Lead ID: `' + id + '`',
  ].filter(Boolean).join('\n');

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Slack HTTP ' + res.getResponseCode() + ': ' + res.getContentText());
  }
}

/** Time-driven trigger (daily). Summary of the last 24 hours to the owner. */
function sendDailyDigest() {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const rows = readLeads_(getLeadsSheet_()).filter(function (r) {
    const t = r['Received At'] instanceof Date ? r['Received At'].getTime() : Date.parse(r['Received At']);
    return t >= since;
  });
  const summary = buildDigest_(rows);
  if (!summary) return; // nothing new — no email

  const to = getSecret_('OWNER_EMAIL', false) || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({ to: to, subject: summary.subject, htmlBody: summary.html });
}

/** Pure function — easy to test. Returns null when there are no leads. */
function buildDigest_(rows) {
  if (!rows.length) return null;
  const count = function (p) { return rows.filter(function (r) { return r['Priority'] === p; }).length; };
  const errors = rows.filter(function (r) { return r['Status'] === STATUS.ERROR; }).length;
  const top = rows
    .filter(function (r) { return r['Priority'] === 'hot' || r['Priority'] === 'warm'; })
    .sort(function (a, b) { return Number(b['Score']) - Number(a['Score']); });

  const esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  const items = top.map(function (r) {
    return '<li><b>' + esc(r['Score']) + '</b> · ' + esc(r['Name']) + ' (' + esc(r['Email']) + ') — ' +
      esc(r['Summary']) + '</li>';
  }).join('');

  const html =
    '<p><b>' + rows.length + '</b> new leads in the last 24h: ' +
    count('hot') + ' hot, ' + count('warm') + ' warm, ' + count('cold') + ' cold, ' +
    count('spam') + ' spam.</p>' +
    (errors ? '<p style="color:#b42318">' + errors + ' failed — run retryFailed().</p>' : '') +
    (items ? '<ol>' + items + '</ol>' : '<p>No hot or warm leads.</p>');

  return {
    subject: CONFIG.BUSINESS_NAME + ' leads: ' + count('hot') + ' hot / ' + rows.length + ' total',
    html: html,
  };
}
