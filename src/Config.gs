/**
 * AI Lead Intake — configuration.
 *
 * Business settings live here. Secrets live in Script Properties
 * (Project Settings → Script properties), never in code:
 *   GEMINI_API_KEY      required
 *   OWNER_EMAIL         optional, daily digest recipient (defaults to script owner)
 *   SLACK_WEBHOOK_URL   optional, hot-lead alerts
 *   WEBHOOK_TOKEN       optional, shared secret for the doPost endpoint
 */
const CONFIG = {
  // Who you are — used in the AI prompt and in reply drafts.
  BUSINESS_NAME: 'Acme Studio',
  SERVICES: 'website design, branding, marketing automation',
  IDEAL_CLIENT: 'small and mid-size businesses with a budget of $2,000+ and a clear deadline',
  REPLY_SIGNATURE: 'Best regards,\nAcme Studio team',

  // Model and scoring.
  MODEL: 'gemini-3.8-flash', // or 'gemini-3.5-flash-lite' for lower cost at high volume
  HOT_SCORE: 70,   // score >= HOT  → hot  (Slack alert)
  WARM_SCORE: 40,  // score >= WARM → warm
  MAX_RETRIES: 3,  // Gemini retries on 429 / 5xx

  // Behaviour switches.
  CREATE_GMAIL_DRAFTS: true, // drafts only — a human always presses Send
  SKIP_CATEGORIES_FOR_DRAFT: ['spam'],

  // Sheet names.
  SHEET_LEADS: 'Leads',
  SHEET_LOG: 'Log',

  // Google Form question titles → internal fields (case-insensitive).
  FORM_FIELDS: {
    name: ['name', 'full name', 'your name'],
    email: ['email', 'email address', 'e-mail'],
    company: ['company', 'company name', 'business'],
    message: ['message', 'how can we help?', 'project details', 'details'],
  },
};

/** Column order of the Leads sheet. Changing it is safe: code looks columns up by name. */
const COLUMNS = [
  'ID', 'Received At', 'Source', 'Name', 'Email', 'Company', 'Message',
  'Category', 'Score', 'Priority', 'Budget', 'Timeline', 'Summary',
  'Missing Info', 'Language', 'Reply Draft', 'Status', 'Error',
];

const STATUS = { NEW: 'NEW', DONE: 'DONE', ERROR: 'ERROR', DUPLICATE: 'DUPLICATE' };

function getSecret_(key, required) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (required && !value) {
    throw new Error('Missing Script Property: ' + key + ' (Project Settings → Script properties)');
  }
  return value || '';
}
