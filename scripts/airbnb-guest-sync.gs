/**
 * Bau Guesthaus — Airbnb guest-count sync (Google Apps Script)
 *
 * Reads Airbnb reservation emails in this Gmail account, pulls out the
 * confirmation code (HMxxxxxxxx) and guest count, and saves them to the
 * cleaning scheduler's Firestore. The scheduler matches the code against
 * the reservation link in the Airbnb calendar feed, so the guest count
 * shows up on the right unit and day automatically.
 *
 * SETUP (one time):
 *   1. Go to https://script.google.com while signed in to the Gmail that
 *      receives Airbnb booking emails → New project.
 *   2. Replace everything in Code.gs with this file → Save.
 *   3. Choose "setup" in the function dropdown → Run → allow access.
 *      That does a first sync and schedules it every 15 minutes.
 *   4. (Optional) View → Executions / Logs to see what it found.
 */

const FIREBASE_PROJECT = 'bau-guesthaus-cleaning';
const FIREBASE_API_KEY = 'AIzaSyDuX4TVEewvrrwJqttBESb0AOf6gbJYkKs';
const COLLECTION = 'checkins';      // docs saved as res_<CODE>
const LOOKBACK = '120d';            // how far back to read emails

const SEARCH =
  'from:airbnb.com newer_than:' + LOOKBACK + ' (' +
  'subject:"Reservation confirmed" OR subject:"Reservation altered" OR ' +
  'subject:"Reservation updated" OR subject:"Reservation change" OR ' +
  'subject:"Instant Booking" OR subject:"New booking" OR subject:"booking confirmed")';

function setup() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncGuestCounts')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncGuestCounts').timeBased().everyMinutes(15).create();
  syncGuestCounts();
}

function syncGuestCounts() {
  const threads = GmailApp.search(SEARCH, 0, 300);
  // Collect every message, oldest first, so a later alteration wins.
  const msgs = [];
  threads.forEach(th => th.getMessages().forEach(m => msgs.push(m)));
  msgs.sort((a, b) => a.getDate() - b.getDate());

  const latest = {}; // code → { guests, subject, date }
  msgs.forEach(m => {
    const parsed = parseReservationEmail(m.getSubject(), m.getPlainBody());
    if (parsed) latest[parsed.code] = { guests: parsed.guests, subject: m.getSubject(), date: m.getDate() };
  });

  const props = PropertiesService.getScriptProperties();
  let written = 0, skipped = 0;
  Object.keys(latest).forEach(code => {
    const r = latest[code];
    const cacheKey = 'g_' + code;
    if (props.getProperty(cacheKey) === String(r.guests)) { skipped++; return; }
    saveToFirestore(code, r.guests, r.subject);
    props.setProperty(cacheKey, String(r.guests));
    written++;
  });
  Logger.log('Emails: %s · reservations parsed: %s · saved: %s · unchanged: %s',
    msgs.length, Object.keys(latest).length, written, skipped);
}

/** Returns { code, guests } or null. Exposed for testing with testParse(). */
function parseReservationEmail(subject, body) {
  const text = (body || '').replace(/\r/g, '');
  const codeM = text.match(/\b(HM[A-Z0-9]{8})\b/) || (subject || '').match(/\b(HM[A-Z0-9]{8})\b/);
  if (!codeM) return null;

  let guests = null;
  // "3 adults, 1 child, 1 infant" (infants don't need a bed, so not counted)
  const adults   = text.match(/(\d+)\s+adults?\b/i);
  const children = text.match(/(\d+)\s+(?:children|child)\b/i);
  if (adults) guests = parseInt(adults[1], 10) + (children ? parseInt(children[1], 10) : 0);
  // "3 guests"
  if (!guests) {
    const g = text.match(/(\d+)\s+guests?\b/i);
    if (g) guests = parseInt(g[1], 10);
  }
  // "Guests\n3"
  if (!guests) {
    const g2 = text.match(/\bGuests?\s*[:\n]\s*(\d+)/i);
    if (g2) guests = parseInt(g2[1], 10);
  }
  if (!guests || guests > 16) return null;
  return { code: codeM[1], guests: guests };
}

function saveToFirestore(code, guests, subject) {
  const url = 'https://firestore.googleapis.com/v1/projects/' + FIREBASE_PROJECT +
    '/databases/(default)/documents/' + COLLECTION + '/res_' + code + '?key=' + FIREBASE_API_KEY;
  const body = {
    fields: {
      code:      { stringValue: code },
      guests:    { integerValue: String(guests) },
      source:    { stringValue: 'gmail' },
      subject:   { stringValue: (subject || '').slice(0, 200) },
      updatedAt: { stringValue: new Date().toISOString() }
    }
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'patch', contentType: 'application/json',
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Firestore write failed for ' + code + ': ' + res.getResponseCode() + ' ' + res.getContentText());
  }
}

/** Handy check: Run this to see what the script reads from your latest Airbnb emails. */
function testParse() {
  GmailApp.search(SEARCH, 0, 5).forEach(th => {
    const m = th.getMessages().pop();
    Logger.log('%s → %s', m.getSubject(), JSON.stringify(parseReservationEmail(m.getSubject(), m.getPlainBody())));
  });
}
