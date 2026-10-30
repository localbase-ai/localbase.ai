/**
 * What this connector stores from CallRail, and how a record becomes a row.
 *
 * The point of the table is attribution: which source, campaign and keyword
 * produced a phone call, and whether it turned into a lead. So the attribution
 * fields are requested explicitly (CallRail returns a lean default set unless
 * `fields=` names more), and everything that identifies the caller is left out.
 *
 * PRIVACY. Caller name, raw phone number, transcripts and recording URLs are
 * never stored. The phone number is reduced to a salted SHA-256 hash so repeat
 * callers can still be counted and joined across calls and form submissions
 * without the number itself sitting in a local file anyone with workspace
 * access can read. Only whether a recording exists is kept.
 */
import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/** Extra call fields requested beyond CallRail's defaults. */
export const CALL_FIELDS = [
  'company_id', 'tracker_id', 'call_type', 'device_type',
  'source', 'source_name', 'medium', 'campaign', 'keywords',
  'landing_page_url', 'referring_url',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid',
  'first_call', 'lead_status', 'value', 'tags', 'note',
  'formatted_customer_location',
];

/**
 * Lead status, value and tags are edited after the call — often days later,
 * when someone reviews it. Incremental runs re-pull this many trailing days.
 */
export const TRAILING_DAYS = 14;

/** How far back a --full run reaches without --since. */
export const DEFAULT_LOOKBACK_YEARS = 2;

/* ------------------------------------------------------------- hashing -- */

/** Digits only, so the same number hashes the same however it was formatted. */
export const normalisePhone = (v) => {
  if (v == null) return null;
  const digits = String(v).replace(/\D/g, '');
  return digits || null;
};

export function hashPhone(phone, salt) {
  const n = normalisePhone(phone);
  if (!n) return null;
  return createHash('sha256').update(`${salt}:${n}`).digest('hex');
}

/**
 * The salt: CALLRAIL_HASH_SALT if set, else one generated once and kept beside
 * the database. Changing it changes every hash, so repeat-caller counts only
 * hold within one salt.
 */
export function loadSalt(saltPath, env = process.env) {
  if (env.CALLRAIL_HASH_SALT) return env.CALLRAIL_HASH_SALT;
  if (existsSync(saltPath)) return readFileSync(saltPath, 'utf8').trim();
  mkdirSync(dirname(saltPath), { recursive: true });
  const salt = randomBytes(32).toString('hex');
  writeFileSync(saltPath, salt, { mode: 0o600 });
  return salt;
}

/* ---------------------------------------------------------------- rows -- */

const bool = (v) => (v == null ? null : v ? 1 : 0);
const num = (v) => (v == null || v === '' ? null : Number(v));
const text = (v) => (v == null || v === '' ? null : Array.isArray(v) ? v.join(', ') : String(v));

/** Tags arrive as strings or as {name, color} objects depending on the endpoint. */
export function tagNames(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean))];
}

/** Local calendar date of an ISO timestamp, in the offset CallRail sent it with. */
export const localDate = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

export function toCallRow(call, { salt, fetchedAt, companyId = null }) {
  return {
    id: String(call.id),
    company_id: text(call.company_id ?? companyId),
    tracker_id: text(call.tracker_id),
    start_time: call.start_time ?? null,
    call_date: localDate(call.start_time),
    direction: text(call.direction),
    call_type: text(call.call_type),
    answered: bool(call.answered),
    voicemail: bool(call.voicemail),
    duration: num(call.duration),
    first_call: bool(call.first_call),
    caller_hash: hashPhone(call.customer_phone_number, salt),
    customer_city: text(call.customer_city),
    customer_state: text(call.customer_state),
    customer_country: text(call.customer_country),
    formatted_customer_location: text(call.formatted_customer_location),
    device_type: text(call.device_type),
    source: text(call.source),
    source_name: text(call.source_name),
    medium: text(call.medium),
    campaign: text(call.campaign),
    keywords: text(call.keywords),
    landing_page_url: text(call.landing_page_url),
    referring_url: text(call.referring_url),
    utm_source: text(call.utm_source),
    utm_medium: text(call.utm_medium),
    utm_campaign: text(call.utm_campaign),
    utm_term: text(call.utm_term),
    utm_content: text(call.utm_content),
    gclid: text(call.gclid),
    fbclid: text(call.fbclid),
    lead_status: text(call.lead_status),
    value: num(call.value),
    note: text(call.note),
    has_recording: bool(Boolean(call.recording || call.recording_player || call.recording_duration)),
    fetched_at: fetchedAt,
  };
}

export function toFormRow(form, { salt, fetchedAt, companyId = null }) {
  return {
    id: String(form.id),
    company_id: text(form.company_id ?? companyId),
    submitted_at: form.submitted_at ?? null,
    submitted_date: localDate(form.submitted_at),
    first_form: bool(form.first_form),
    // Hash, never store: the same salt as calls, so one person's call and form join.
    caller_hash: hashPhone(form.customer_phone_number, salt),
    form_url: text(form.form_url),
    landing_page_url: text(form.landing_page_url),
    referring_url: text(form.referring_url ?? form.referrer),
    source: text(form.source),
    medium: text(form.medium),
    campaign: text(form.campaign),
    utm_source: text(form.utm_source),
    utm_medium: text(form.utm_medium),
    utm_campaign: text(form.utm_campaign),
    utm_term: text(form.utm_term),
    utm_content: text(form.utm_content),
    gclid: text(form.gclid),
    fbclid: text(form.fbclid),
    lead_status: text(form.lead_status),
    value: num(form.value),
    fetched_at: fetchedAt,
  };
}

export function toCompanyRow(c, { fetchedAt }) {
  return {
    id: String(c.id),
    name: text(c.name),
    status: text(c.status),
    time_zone: text(c.time_zone),
    created_at: c.created_at ?? null,
    disabled_at: c.disabled_at ?? null,
    fetched_at: fetchedAt,
  };
}

export function toTrackerRow(t, { fetchedAt, companyId = null }) {
  return {
    id: String(t.id),
    company_id: text(t.company?.id ?? t.company_id ?? companyId),
    name: text(t.name),
    type: text(t.type),
    status: text(t.status),
    // Tracking numbers are the business's own, not callers' — safe to keep.
    tracking_numbers: text(t.tracking_numbers),
    source_type: text(t.source?.type),
    source_detail: t.source ? JSON.stringify(t.source) : null,
    created_at: t.created_at ?? null,
    disabled_at: t.disabled_at ?? null,
    fetched_at: fetchedAt,
  };
}

/* ----------------------------------------------------------------- DDL -- */

export const DDL = `
CREATE TABLE IF NOT EXISTS callrail_companies (
  id TEXT PRIMARY KEY, name TEXT, status TEXT, time_zone TEXT,
  created_at TEXT, disabled_at TEXT, fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS callrail_trackers (
  id TEXT PRIMARY KEY, company_id TEXT, name TEXT, type TEXT, status TEXT,
  tracking_numbers TEXT, source_type TEXT, source_detail TEXT,
  created_at TEXT, disabled_at TEXT, fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS callrail_calls (
  id TEXT PRIMARY KEY,
  company_id TEXT, tracker_id TEXT,
  start_time TEXT, call_date TEXT,
  direction TEXT, call_type TEXT,
  answered INTEGER, voicemail INTEGER, duration REAL, first_call INTEGER,
  caller_hash TEXT,
  customer_city TEXT, customer_state TEXT, customer_country TEXT, formatted_customer_location TEXT,
  device_type TEXT,
  source TEXT, source_name TEXT, medium TEXT, campaign TEXT, keywords TEXT,
  landing_page_url TEXT, referring_url TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
  gclid TEXT, fbclid TEXT,
  lead_status TEXT, value REAL, note TEXT,
  has_recording INTEGER,
  fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS callrail_calls_company_date ON callrail_calls (company_id, call_date);
CREATE INDEX IF NOT EXISTS callrail_calls_caller ON callrail_calls (caller_hash);

CREATE TABLE IF NOT EXISTS callrail_call_tags (
  call_id TEXT, tag TEXT,
  PRIMARY KEY (call_id, tag)
);

CREATE TABLE IF NOT EXISTS callrail_form_submissions (
  id TEXT PRIMARY KEY,
  company_id TEXT, submitted_at TEXT, submitted_date TEXT, first_form INTEGER,
  caller_hash TEXT,
  form_url TEXT, landing_page_url TEXT, referring_url TEXT,
  source TEXT, medium TEXT, campaign TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
  gclid TEXT, fbclid TEXT,
  lead_status TEXT, value REAL,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_state (
  company_id TEXT,
  entity TEXT,
  watermark_date TEXT,
  last_run_at TEXT,
  last_row_count INTEGER,
  PRIMARY KEY (company_id, entity)
);

-- call_date is the date in the offset CallRail reports start_time with, which
-- is the company's own timezone, so days line up with the business's day.
DROP VIEW IF EXISTS callrail_calls_daily;
CREATE VIEW callrail_calls_daily AS
SELECT
  company_id,
  call_date AS date,
  COALESCE(source_name, source, '(none)') AS source,
  COALESCE(campaign, '(none)') AS campaign,
  COUNT(*) AS calls,
  SUM(answered = 1) AS answered,
  SUM(voicemail = 1) AS voicemails,
  SUM(first_call = 1) AS first_time_callers,
  SUM(lead_status = 'good_lead') AS qualified_leads,
  SUM(value) AS value,
  AVG(duration) AS avg_duration
FROM callrail_calls
GROUP BY company_id, call_date, COALESCE(source_name, source, '(none)'), COALESCE(campaign, '(none)');
`;
