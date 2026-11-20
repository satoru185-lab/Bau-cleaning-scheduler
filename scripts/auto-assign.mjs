/**
 * auto-assign.mjs
 * Runs hourly via GitHub Actions.
 * - Fetches iCals for all units
 * - Finds checkout days that have a tbd_claim but no claim yet
 * - Auto-assigns the waitlisted cleaner and sends ntfy notification
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const WORKER    = 'https://green-poetry-6240.satoru185.workers.dev/';
const UNITS     = ['A', 'B', 'C', 'F', 'E'];
const NTFY_TOPIC = 'bau-cleaning-satoru-7x9k';

// ── Firebase init ──────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ── Helpers ────────────────────────────────────────────────
function dayKey(date) {
  // 'YYYY-MM-DD' in local (ET) time
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

// Parse iCal text into [{start, end}] booking objects
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

// Return 'open'|'checkin'|'checkout'|'both'|'occupied'|'unavailable'
function classifyDay(events, day) {
  const next = new Date(day); next.setDate(day.getDate() + 1);
  const checkoutToday = events.some(e => sameDay(e.end, day));
  const checkinToday  = events.some(e => sameDay(e.start, day));
  const checkinTomorrow = events.some(e => sameDay(e.start, next));
  const occupied = events.some(e => e.start < day && e.end > day);
  if (checkoutToday && checkinToday) return 'both';
  if (checkoutToday)  return 'checkout';
  if (checkinToday)   return 'checkin';
  if (occupied)       return 'occupied';
  if (checkinTomorrow) return 'unavailable'; // last free night, booked tomorrow
  return 'open';
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

// ── Fetch all iCals ────────────────────────────────────────
async function fetchAllICals() {
  const icals = {};
  await Promise.all(UNITS.map(async unit => {
    try {
      const res  = await fetch(`${WORKER}?unit=${unit}&_=${Date.now()}`);
      const text = await res.text();
      icals[unit] = text.trim().length > 20 ? parseICal(text) : [];
    } catch (e) {
      console.warn(`iCal fetch failed for Unit ${unit}:`, e.message);
      icals[unit] = [];
    }
  }));
  return icals;
}

// ── Notify Satoru via ntfy ─────────────────────────────────
async function notifySatoru(title, body, tags = 'broom', extraHeaders = {}) {
  await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: { Title: title, Priority: 'high', Tags: tags, ...extraHeaders },
    body,
  });
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  console.log('auto-assign: starting', new Date().toISOString());

  const icals = await fetchAllICals();
  const days  = getDays(60); // look 60 days ahead

  // Build list of checkout days per real unit (E = A+B combo, skip for auto-assign)
  const checkoutDays = []; // [{day, unit}]
  for (const day of days) {
    for (const unit of ['A', 'B', 'C', 'F']) {
      const status = classifyDay(icals[unit] || [], day);
      if (status === 'checkout' || status === 'both') {
        checkoutDays.push({ day, unit });
      }
    }
    // E checkout: treat as units A+B for cleaning
    const eStatus = classifyDay(icals['E'] || [], day);
    if (eStatus === 'checkout' || eStatus === 'both') {
      checkoutDays.push({ day, unit: 'E' });
    }
  }

  // Also build TBD days: unit free tonight AND checkout tomorrow (next day cleaning)
  const tbdDays = []; // [{cleaningDay, unit}]
  for (const day of getDays(61)) { // +1 to capture last day's TBD
    const prev = new Date(day); prev.setDate(day.getDate() - 1);
    for (const unit of ['A', 'B', 'C', 'F', 'E']) {
      const events = icals[unit] || [];
      const prevStatus = classifyDay(events, prev);
      const todayStatus = classifyDay(events, day);
      // TBD: prev night is open/unavailable AND today would be a checkout
      if ((prevStatus === 'open' || prevStatus === 'unavailable') &&
          (todayStatus === 'checkout' || todayStatus === 'both')) {
        tbdDays.push({ cleaningDay: day, unit });
      }
    }
  }

  let assigned = 0;

  for (const { day, unit } of checkoutDays) {
    const key = `${dayKey(day)}_${unit}`;

    // Check if already claimed
    const claimSnap = await db.collection('claims').doc(key).get();
    if (claimSnap.exists) continue; // already assigned

    // Check for TBD pre-claim
    const tbdSnap = await db.collection('tbd_claims').doc(key).get();
    if (!tbdSnap.exists) continue; // no one on waitlist

    const cleanerName = tbdSnap.data().cleaner;
    const dateLabel = day.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York'
    });

    console.log(`Auto-assigning: ${cleanerName} → Unit ${unit} on ${dateLabel}`);

    // Write confirmed claim
    await db.collection('claims').doc(key).set({
      cleaner: cleanerName,
      date: dayKey(day),
      unit,
      claimedAt: new Date().toISOString(),
      autoAssigned: true,
    });

    // Remove TBD claim
    await db.collection('tbd_claims').doc(key).delete();

    // Look up cleaner phone
    const cleanerSnap = await db.collection('cleaners').doc(cleanerName.toLowerCase()).get();
    const cleanerPhone = cleanerSnap.exists ? (cleanerSnap.data().phone || '') : '';

    const smsText = encodeURIComponent(
      `Hi ${cleanerName}! Unit ${unit} on ${dateLabel} just got booked — you're confirmed for cleaning. Check the app for details.`
    );
    const smsLink = cleanerPhone ? `sms:${cleanerPhone}&body=${smsText}` : '';
    const extraHeaders = smsLink
      ? { Actions: `view, Text ${cleanerName}, ${smsLink}` }
      : {};

    await notifySatoru(
      `✅ ${cleanerName} → Unit ${unit} confirmed`,
      `${cleanerName} auto-assigned Unit ${unit} on ${dateLabel} from waitlist.${cleanerPhone ? ' Tap to send confirmation text.' : ' (No phone on file.)'}`,
      'white_check_mark',
      extraHeaders
    );

    assigned++;
  }

  console.log(`auto-assign: done. ${assigned} slot(s) assigned.`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
