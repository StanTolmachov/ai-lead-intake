/**
 * Local test harness: runs the real .gs files in Node with in-memory mocks of
 * SpreadsheetApp, UrlFetchApp, GmailApp etc. No Google account needed.
 *   node test/run-tests.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');

// ---------- in-memory Sheets ----------
function makeSheet(name) {
  const data = [];
  const width = () => data.reduce((m, r) => Math.max(m, r.length), 0);
  const chain = {};
  ['setFontWeight', 'setBackground', 'setFontColor'].forEach((f) => (chain[f] = () => chain));
  const sheet = {
    name, data,
    getLastRow: () => data.length,
    getLastColumn: () => width(),
    getMaxRows: () => 1000,
    appendRow: (row) => { data.push(row.slice()); return sheet; },
    setFrozenRows: () => {}, setColumnWidth: () => {}, setConditionalFormatRules: () => {},
    getDataRange: () => sheet.getRange(1, 1, data.length, width()),
    getRange: (r, c, nr = 1, nc = 1) => Object.assign(Object.create(chain), {
      getValues: () => Array.from({ length: nr }, (_, i) =>
        Array.from({ length: nc }, (_, j) => ((data[r - 1 + i] || [])[c - 1 + j] ?? ''))),
      setValues: (vals) => {
        vals.forEach((row, i) => row.forEach((v, j) => {
          while (data.length < r + i) data.push([]);
          data[r - 1 + i][c - 1 + j] = v;
        }));
        return chain;
      },
      setValue: (v) => { while (data.length < r) data.push([]); data[r - 1][c - 1] = v; return chain; },
    }),
  };
  return sheet;
}

function makeEnv(geminiHandler) {
  const sheets = {};
  const ss = {
    getId: () => 'SHEET123',
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n)),
  };
  const props = { GEMINI_API_KEY: 'test-key', SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', WEBHOOK_TOKEN: 'secret' };
  const calls = { gemini: 0, slack: [], drafts: [], mails: [], sleeps: [] };
  let slackFails = false;

  const ctx = {
    console: { log: () => {}, error: () => {} },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss, openById: () => ss, flush: () => {},
      newConditionalFormatRule: () => {
        const b = {}; ['whenTextEqualTo', 'setBackground', 'setFontColor', 'setRanges'].forEach((f) => (b[f] = () => b));
        b.build = () => ({}); return b;
      },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => (props[k] = v) }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      sleep: (ms) => calls.sleeps.push(ms),
    },
    UrlFetchApp: {
      fetch: (url, opts) => {
        if (url.includes('slack')) {
          calls.slack.push(JSON.parse(opts.payload).text);
          return resp(slackFails ? 500 : 200, slackFails ? 'down' : 'ok');
        }
        calls.gemini++;
        assert.strictEqual(opts.headers['x-goog-api-key'], 'test-key');
        const body = JSON.parse(opts.payload);
        assert.strictEqual(body.generationConfig.responseMimeType, 'application/json');
        return geminiHandler(body.contents[0].parts[0].text, calls.gemini);
      },
    },
    GmailApp: { createDraft: (to, subj, body) => calls.drafts.push({ to, subj, body }) },
    MailApp: { sendEmail: (m) => calls.mails.push(m) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@test.example' }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ setMimeType: () => ({ body: JSON.parse(s) }) }),
    },
    ScriptApp: {
      getProjectTriggers: () => [], deleteTrigger: () => {},
      newTrigger: () => { const t = {}; ['forSpreadsheet', 'onFormSubmit', 'timeBased', 'everyDays', 'atHour'].forEach((f) => (t[f] = () => t)); t.create = () => {}; return t; },
    },
  };
  vm.createContext(ctx);
  const src = path.join(__dirname, '..', 'src');
  // Apps Script shares one global scope across files; concatenate to mimic that.
  const code = ['Config.gs', 'Sheets.gs', 'Gemini.gs', 'Actions.gs', 'Main.gs', 'Setup.gs']
    .map((f) => fs.readFileSync(path.join(src, f), 'utf8')).join('\n');
  vm.runInContext(code + '\nthis.__x = { CONFIG, STATUS, setup, testWithSamples, processLead_, doPost, onFormSubmit, retryFailed, buildDigest_, sendDailyDigest, readLeads_, getLeadsSheet_, sanitizeCell_ };', ctx);
  return { x: ctx.__x, sheets, calls, props, setSlackFails: (v) => (slackFails = v) };
}

function resp(code, text) { return { getResponseCode: () => code, getContentText: () => text }; }
function geminiOk(obj) { return resp(200, JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] })); }

/** Fake model: keyword rules standing in for Gemini, enough to drive every branch. */
function fakeGemini(prompt) {
  const msg = prompt.split('Message: ')[1] || '';
  const base = { budget: 'unknown', timeline: 'unknown', company: '', missing_info: [], language: 'en', summary: 'x', reply_draft: 'Hi!\nBest regards' };
  if (/backlinks/.test(msg)) return geminiOk({ ...base, category: 'spam', score: 5 });
  if (/stopped sending/.test(msg)) return geminiOk({ ...base, category: 'support', score: 50 });
  if (/\$6,000/.test(msg)) return geminiOk({ ...base, category: 'sales_inquiry', score: 92, budget: '$6,000', timeline: 'March 1' });
  if (/Hei!/.test(msg)) return geminiOk({ ...base, category: 'sales_inquiry', score: 85, language: 'no' });
  if (/food truck/.test(msg)) return geminiOk({ ...base, category: 'sales_inquiry', score: 55, missing_info: ['budget'] });
  return geminiOk({ ...base, category: 'sales_inquiry', score: 15 });
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('setup creates Leads and Log sheets with headers', () => {
  const env = makeEnv(fakeGemini);
  env.x.setup();
  assert.ok(env.sheets.Leads && env.sheets.Log);
  assert.strictEqual(env.sheets.Leads.data[0][0], 'ID');
  assert.strictEqual(env.props.SPREADSHEET_ID, 'SHEET123');
});

test('sample leads: 7 saved, invalid one rejected, priorities correct', () => {
  const env = makeEnv(fakeGemini);
  env.x.setup();
  env.x.testWithSamples();
  const rows = env.x.readLeads_(env.x.getLeadsSheet_());
  assert.strictEqual(rows.length, 7);
  assert.ok(rows.every((r) => r.Status === 'DONE'));
  const by = (email) => rows.find((r) => r.Email === email);
  assert.strictEqual(by('laura@brightdental.example').Priority, 'hot');
  assert.strictEqual(by('tom.r@gmail.example').Priority, 'warm');
  assert.strictEqual(by('kevin@mossbuild.example').Priority, 'cold');
  assert.strictEqual(by('anna@client-existing.example').Priority, 'n/a');
  assert.strictEqual(by('promo@cheap-backlinks.example').Priority, 'spam');
  assert.strictEqual(by('promo@cheap-backlinks.example').Score, 0);
  // drafts for everyone except spam; Slack only for the 2 hot leads
  assert.strictEqual(env.calls.drafts.length, 6);
  assert.strictEqual(env.calls.slack.length, 2);
});

test('duplicate submission is skipped without a second AI call', () => {
  const env = makeEnv(fakeGemini);
  env.x.setup();
  const lead = { name: 'A', email: 'A@X.example', message: 'Need a site, budget $6,000' };
  assert.strictEqual(env.x.processLead_(lead, 't').status, 'DONE');
  assert.strictEqual(env.x.processLead_({ ...lead, email: 'a@x.example ' }, 't').status, 'DUPLICATE');
  assert.strictEqual(env.calls.gemini, 1);
});

test('429 is retried with backoff, then succeeds', () => {
  const env = makeEnv((p, n) => (n <= 2 ? resp(429, 'rate limited') : fakeGemini(p)));
  env.x.setup();
  const r = env.x.processLead_({ name: 'B', email: 'b@x.example', message: 'budget $6,000 site' }, 't');
  assert.strictEqual(r.status, 'DONE');
  assert.deepStrictEqual(env.calls.sleeps, [1000, 2000]);
});

test('400 fails fast, lead kept as ERROR, retryFailed recovers it', () => {
  let broken = true;
  const env = makeEnv((p) => (broken ? resp(400, 'bad request') : fakeGemini(p)));
  env.x.setup();
  const r = env.x.processLead_({ name: 'C', email: 'c@x.example', message: 'budget $6,000 site' }, 't');
  assert.strictEqual(r.status, 'ERROR');
  assert.strictEqual(env.calls.sleeps.length, 0);
  let row = env.x.readLeads_(env.x.getLeadsSheet_())[0];
  assert.strictEqual(row.Status, 'ERROR');
  assert.match(row.Error, /HTTP 400/);
  broken = false;
  env.x.retryFailed();
  row = env.x.readLeads_(env.x.getLeadsSheet_())[0];
  assert.strictEqual(row.Status, 'DONE');
  assert.strictEqual(row.Error, '');
});

test('model output is clamped and validated', () => {
  const env = makeEnv(() => geminiOk({ category: 'weird', score: 150, missing_info: 'nope' }));
  env.x.setup();
  env.x.processLead_({ name: 'D', email: 'd@x.example', message: 'hello there' }, 't');
  const row = env.x.readLeads_(env.x.getLeadsSheet_())[0];
  assert.strictEqual(row.Category, 'other');
  assert.strictEqual(row.Score, 100);
  assert.strictEqual(row.Priority, 'n/a');
  assert.strictEqual(row['Missing Info'], '');
});

test('formula injection in form input is neutralised', () => {
  const env = makeEnv(fakeGemini);
  env.x.setup();
  env.x.processLead_({ name: '=IMPORTXML("http://evil")', email: 'e@x.example', message: '+cmd|calc budget' }, 't');
  const row = env.x.readLeads_(env.x.getLeadsSheet_())[0];
  assert.ok(row.Name.startsWith("'="));
  assert.ok(row.Message.startsWith("'+"));
});

test('Slack outage does not fail the lead', () => {
  const env = makeEnv(fakeGemini);
  env.x.setup();
  env.setSlackFails(true);
  const r = env.x.processLead_({ name: 'F', email: 'f@x.example', message: 'site, budget $6,000' }, 't');
  assert.strictEqual(r.status, 'DONE');
  assert.ok(env.sheets.Log.data.some((l) => /slack_alert failed/.test(l[2])));
});

test('doPost: rejects wrong token, accepts JSON with right token', () => {
  const env = makeEnv(fakeGemini);
  env.x.setup();
  const post = (obj) => env.x.doPost({ postData: { type: 'application/json', contents: JSON.stringify(obj) }, parameter: {} }).body;
  assert.deepStrictEqual(post({ token: 'wrong', email: 'g@x.example', message: 'hello there' }), { ok: false, error: 'unauthorized' });
  const ok = post({ token: 'secret', name: 'G', email: 'g@x.example', message: 'site budget $6,000' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.status, 'DONE');
  assert.strictEqual(post({ token: 'secret', email: 'bad', message: 'hello there' }).ok, false);
});

test('onFormSubmit maps Google Form question titles', () => {
  const env = makeEnv(fakeGemini);
  env.x.setup();
  env.x.onFormSubmit({ namedValues: { 'Full name': ['H'], 'Email address': ['h@x.example'], 'How can we help?': ['site, budget $6,000'] } });
  const row = env.x.readLeads_(env.x.getLeadsSheet_())[0];
  assert.strictEqual(row.Name, 'H');
  assert.strictEqual(row.Source, 'google_form');
});

test('daily digest: counts, ordering, HTML escaping, empty day', () => {
  const env = makeEnv(fakeGemini);
  assert.strictEqual(env.x.buildDigest_([]), null);
  const d = env.x.buildDigest_([
    { Priority: 'warm', Score: 55, Name: 'W', Email: 'w@x', Summary: 'logo', Status: 'DONE' },
    { Priority: 'hot', Score: 92, Name: '<b>H</b>', Email: 'h@x', Summary: 'site', Status: 'DONE' },
    { Priority: '', Score: '', Name: 'E', Email: 'e@x', Summary: '', Status: 'ERROR' },
  ]);
  assert.match(d.subject, /1 hot \/ 3 total/);
  assert.ok(d.html.indexOf('&lt;b&gt;H') < d.html.indexOf('>W<') || d.html.indexOf('92') < d.html.indexOf('55'));
  assert.match(d.html, /1 failed/);
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log('✓ ' + t.name); }
  catch (e) { failed++; console.log('✗ ' + t.name + '\n  ' + e.message); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
