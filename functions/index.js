const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

// Direct Airbnb iCal export URLs
const ICAL_URLS = {
  A: 'https://www.airbnb.com/calendar/ical/18235365.ics?t=f78efaf49f424d03b706bb45fa82a1ff',
  B: 'https://www.airbnb.com/calendar/ical/18238047.ics?t=fa040a67ff82429dbb059ea3caf1fb62',
  C: 'https://www.airbnb.com/calendar/ical/26917317.ics?t=e51a46ca491742c689cf28844f7586a3',
  F: 'https://www.airbnb.com/calendar/ical/46242495.ics?t=fc82344e5e4a4558880d64c9a7b80f7d',
  E: 'https://www.airbnb.com/calendar/ical/18241519.ics?t=d1151a4fbdc84d55a8cf0ff314ced1bf',
};
const UNITS      = ['A', 'B', 'C', 'F', 'E'];
const NTFY_TOPIC = 'bau-cleaning-satoru-7x9k';

// ── Helpers ────────────────────────────────────────────────
function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDays(n) {
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    days.push(d);
  }
  return days;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

function parseICal(text) {
  const events = [];
  const blocks = text.split('BEGIN:VEVENT');
  for (const block of blocks.slice(1)) {
    const dtstart = block.match(/DTSTART[^:]*:(\d+)/)?.[1];
    const dtend   = block.match(/DTEND[^:]*:(\d+)/)?.[1];
    if (!dtstart || !dtend) continue;
    const parseDate = s => new Date(
      `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T12:00:00`
    );
    events.push({ start: parseDate(dtstart), end: parseDate(dtend) });
  }
  return events;
}

function classifyDay(events, day) {
  const next = new Date(day); next.setDate(day.getDate() + 1);
  const checkoutToday   = events.some(e => sameDay(e.end, day));
  const checkinToday    = events.some(e => sameDay(e.start, day));
  const checkinTomorrow = events.some(e => sameDay(e.start, next));
  const occupied        = events.some(e => e.start < day && e.end > day);
  if (checkoutToday && checkinToday) return 'both';
  if (checkoutToday)   return 'checkout';
  if (checkinToday)    return 'checkin';
  if (occupied)        return 'occupied';
  if (checkinTomorrow) return 'unavailable';
  return 'open';
}

async function fetchAllICals() {
  const icals = {};
  await Promise.all(UNITS.map(async unit => {
    const url = ICAL_URLS[unit];
    if (!url) { icals[unit] = []; return; }
    try {
      const res  = await fetch(url);
      const text = await res.text();
      icals[unit] = text.trim().length > 20 ? parseICal(text) : [];
    } catch (e) {
      console.warn(`iCal fetch failed for Unit ${unit}:`, e.message);
      icals[unit] = [];
    }
  }));
  return icals;
}

function asciiOnly(str) {
  return String(str).replace(/[^\x00-\x7F]/g, '').trim();
}

async function notifySatoru(title, body, tags = 'broom', extraHeaders = {}) {
  const safeHeaders = {};
  for (const [k, v] of Object.entries(extraHeaders)) {
    safeHeaders[k] = asciiOnly(v);
  }
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { Title: asciiOnly(title), Priority: 'high', Tags: tags, ...safeHeaders },
      body,
    });
  } catch (e) {
    console.warn('ntfy notification failed:', e.message);
  }
}

// ── Core logic (shared between scheduled + manual) ─────────
async function runAutoAssign() {
  console.log('auto-assign: starting', new Date().toISOString());
  const icals = await fetchAllICals();
  const days  = getDays(60);

  // Build checkout days
  const checkoutDays = [];
  for (const day of days) {
    for (const unit of ['A', 'B', 'C', 'F']) {
      const status = classifyDay(icals[unit] || [], day);
      if (status === 'checkout' || status === 'both') {
        checkoutDays.push({ day, unit });
      }
    }
    const eStatus = classifyDay(icals['E'] || [], day);
    if (eStatus === 'checkout' || eStatus === 'both') {
      checkoutDays.push({ day, unit: 'E' });
    }
  }

  // Expire stale TBD claims after 10 PM ET
  const nowET  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hourET = nowET.getHours();
  if (hourET >= 22) {
    const tomorrow = new Date(nowET);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    for (const unit of ['A', 'B', 'C', 'F', 'E']) {
      const key     = `${dayKey(tomorrow)}_${unit}`;
      const tbdSnap = await db.collection('tbd_claims').doc(key).get();
      if (!tbdSnap.exists) continue;
      const isCheckout = checkoutDays.some(c => sameDay(c.day, tomorrow) && c.unit === unit);
      if (isCheckout) continue;
      const cleanerName = tbdSnap.data().cleaner;
      console.log(`Expiring stale TBD: ${cleanerName} on Unit ${unit} tomorrow`);
      await db.collection('tbd_claims').doc(key).delete();
      await notifySatoru(
        `TBD expired - Unit ${unit}`,
        `No booking came in. ${cleanerName}'s waitlist for Unit ${unit} tomorrow was removed.`,
        'hourglass'
      );
    }
  }

  // Auto-assign waitlisted cleaners for confirmed checkouts
  let assigned = 0;
  for (const { day, unit } of checkoutDays) {
    const key       = `${dayKey(day)}_${unit}`;
    const claimSnap = await db.collection('claims').doc(key).get();
    if (claimSnap.exists) continue;

    const tbdSnap = await db.collection('tbd_claims').doc(key).get();
    if (!tbdSnap.exists) continue;

    const cleanerName = tbdSnap.data().cleaner;
    const dateLabel   = day.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York'
    });
    console.log(`Auto-assigning: ${cleanerName} -> Unit ${unit} on ${dateLabel}`);

    await db.collection('claims').doc(key).set({
      cleaner: cleanerName,
      date: dayKey(day),
      unit,
      claimedAt: new Date().toISOString(),
      autoAssigned: true,
    });
    await db.collection('tbd_claims').doc(key).delete();

    const cleanerSnap = await db.collection('cleaners').doc(cleanerName.toLowerCase()).get();
    const cleanerPhone = cleanerSnap.exists ? (cleanerSnap.data().phone || '') : '';
    const smsText = encodeURIComponent(
      `Hi ${cleanerName}! Unit ${unit} on ${dateLabel} just got booked - you're confirmed for cleaning. Check the app for details.`
    );
    const smsLink     = cleanerPhone ? `sms:${cleanerPhone}&body=${smsText}` : '';
    const extraHeaders = smsLink ? { Actions: `view, Text ${cleanerName}, ${smsLink}` } : {};

    await notifySatoru(
      `${cleanerName} - Unit ${unit} confirmed`,
      `${cleanerName} auto-assigned Unit ${unit} on ${dateLabel} from waitlist.${cleanerPhone ? ' Tap to send confirmation text.' : ' (No phone on file.)'}`,
      'white_check_mark',
      extraHeaders
    );
    assigned++;
  }

  console.log(`auto-assign: done. ${assigned} slot(s) assigned.`);
}

// ── Scheduled function — runs every 10 minutes ─────────────
exports.autoAssign = onSchedule(
  {
    schedule: 'every 10 minutes',
    timeZone: 'America/New_York',
    region: 'us-east1',
  },
  async () => {
    await runAutoAssign();
  }
);
