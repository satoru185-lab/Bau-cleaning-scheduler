/**
 * morning-reminders.mjs
 * Runs every morning via GitHub Actions (.github/workflows/morning-reminders.yml).
 * For each cleaner with a claim today, sends Satoru one ntfy push with the
 * reminder text already written and a "Text <name>" button that opens it in
 * his messages app. Nothing is sent to cleaners automatically.
 *
 * Usage:
 *   node morning-reminders.mjs                 → today's reminders (ET), only on the 9 AM ET scheduled run
 *   node morning-reminders.mjs --test          → send now, marked TEST
 *   node morning-reminders.mjs --test --date 2026-11-28
 */

const PROJECT    = 'bau-guesthaus-cleaning';
const API_KEY    = 'AIzaSyDuX4TVEewvrrwJqttBESb0AOf6gbJYkKs'; // same public web key as index.html
const NTFY_TOPIC = 'bau-cleaning-satoru-7x9k';
const CHECKOUT_TIME = '11 AM';
const SEND_HOUR_ET  = 9;
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const args   = process.argv.slice(2);
const isTest = args.includes('--test') || process.env.TEST_MODE === 'true';
const dateArg = (args[args.indexOf('--date') + 1] && args.includes('--date'))
  ? args[args.indexOf('--date') + 1] : (process.env.TEST_DATE || '');

// ── Time helpers (always America/New_York, whatever the runner's zone) ──
function etParts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, timeZoneName: 'shortOffset',
  }).formatToParts(d).map(x => [x.type, x.value]));
  const offset = parseInt((p.timeZoneName || 'GMT-5').replace('GMT', ''), 10); // -4 or -5
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) % 24, offset };
}

// GitHub cron is UTC and has two runs (13:05 and 14:05 UTC). Only the one that
// lands on 9 AM ET today should send, so daylight saving never doubles it up.
function isTheRightRun() {
  const sched = process.env.SCHEDULE || '';
  const m = sched.match(/^\S+\s+(\d+)\s/);
  if (!m) return false; // not a scheduled run: only --test sends
  const { offset } = etParts();
  return parseInt(m[1], 10) === SEND_HOUR_ET - offset;
}

// ── Firestore reads (public REST, same access the web app has) ──
async function listDocs(collection) {
  const out = [];
  let token = '';
  do {
    const url = `${FS}/${collection}?pageSize=300&key=${API_KEY}${token ? `&pageToken=${token}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Firestore ${collection}: HTTP ${res.status}`);
    const json = await res.json();
    for (const d of json.documents || []) {
      const f = {};
      for (const [k, v] of Object.entries(d.fields || {})) f[k] = Object.values(v)[0];
      out.push({ id: d.name.split('/').pop(), ...f });
    }
    token = json.nextPageToken || '';
  } while (token);
  return out;
}

// ── Message ────────────────────────────────────────────────
function unitList(units) {
  const u = [...units].sort();
  if (u.length === 1) return `Unit ${u[0]}`;
  return `Units ${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}`;
}

export function buildText(name, units) {
  return `Good morning ${name}! You're cleaning ${unitList(units)} today. ` +
         `Checkout is at ${CHECKOUT_TIME}. What time are you planning to arrive?`;
}

function asciiOnly(str) {
  return String(str).replace(/[^\x00-\x7F]/g, '').trim();
}

async function pushToSatoru(title, body, actions = '') {
  const headers = { Title: asciiOnly(title), Priority: 'high', Tags: 'sunrise' };
  if (actions) headers.Actions = asciiOnly(actions);
  const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`ntfy: HTTP ${res.status}`);
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  if (!isTest && !isTheRightRun()) {
    console.log('Not the 9 AM ET run today, skipping.');
    return;
  }
  const date = dateArg || etParts().date;
  const [claims, cleaners] = await Promise.all([listDocs('claims'), listDocs('cleaners')]);

  const byCleaner = {};
  for (const c of claims) {
    if (c.id.split('_')[0] !== date || !c.cleaner) continue;
    (byCleaner[c.cleaner] ||= new Set()).add(c.unit || c.id.split('_')[1]);
  }
  const phoneOf = {};
  for (const c of cleaners) if (c.name) phoneOf[c.name.toLowerCase()] = (c.phone || '').replace(/\D/g, '');

  const names = Object.keys(byCleaner).sort();
  console.log(`${date}: ${names.length} cleaner(s) with cleanings`);
  for (const name of names) {
    const units = byCleaner[name];
    const text  = buildText(name, units);
    const phone = phoneOf[name.toLowerCase()] || '';
    const title = `${isTest ? 'TEST - ' : ''}Text ${name} - ${unitList(units)}`;
    const body  = phone ? text : `${text}\n\n(No phone on file for ${name}.)`;
    const actions = phone ? `view, Text ${name}, sms:${phone}&body=${encodeURIComponent(text)}, clear=true` : '';
    await pushToSatoru(title, body, actions);
    console.log(`Sent prompt for ${name}: ${unitList(units)}${phone ? '' : ' (no phone)'}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
