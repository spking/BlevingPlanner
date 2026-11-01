'use strict';
// Minimal RFC 5545 (iCalendar) writer for all-day meal events.

function escapeText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Lines must be folded at 75 octets (bytes, not characters), without splitting a UTF-8 character.
function fold(line) {
  const parts = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > 75) {
      parts.push(current);
      current = ' ';
      bytes = 1;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n');
}

const compactDate = (ymd) => ymd.replace(/-/g, '');

function previousDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

// "Floating" local time (no Z, no TZID): every device shows it at that clock time in its own time zone,
// which is what a "19:00 at home" reminder means.
function floatingDateTime(ymd, hhmm, plusMinutes = 0) {
  const [h, min] = hhmm.split(':').map(Number);
  const total = h * 60 + min + plusMinutes;
  const day = total >= 1440 ? nextDay(ymd) : ymd;
  const t = total % 1440;
  return `${compactDate(day)}T${String(Math.floor(t / 60)).padStart(2, '0')}${String(t % 60).padStart(2, '0')}00`;
}

function nextDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// SQLite datetime('now') gives "YYYY-MM-DD HH:MM:SS" in UTC.
function sqliteToUtcStamp(value) {
  const dt = new Date(String(value).replace(' ', 'T') + 'Z');
  return Number.isNaN(dt.getTime()) ? null : utcStamp(dt);
}

function describe(event) {
  const lines = [];
  if (event.ingredients.length) {
    lines.push('Ingredients:');
    for (const i of event.ingredients) lines.push(`• ${i.name}${i.quantity ? ` — ${i.quantity}` : ''}`);
  }
  if (event.notes && event.notes.trim()) {
    if (lines.length) lines.push('');
    lines.push(event.notes.trim());
  }
  return lines.join('\n');
}

/**
 * @param {object} opts
 * @param {Array<{date:string,name:string,notes:string,updatedAt:string,ingredients:Array<{name:string,quantity:string}>}>} opts.events
 * @param {string} opts.calendarName
 * @param {string} opts.uidDomain  stable per installation, keeps UIDs unique across calendars
 * @param {string} [opts.thawTime]  "HH:MM": add a reminder event the evening before for frozen ingredients ('' = off)
 * @param {Date} [opts.now]
 */
function buildCalendar({ events, calendarName, uidDomain, thawTime = '', now = new Date() }) {
  const stamp = utcStamp(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Meal Planner//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    'X-WR-CALDESC:Planned meals',
    // Hints to clients on how often to re-fetch. Apple Calendar uses its own setting, but honours these as a suggestion.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const event of events) {
    const description = describe(event);
    const modified = sqliteToUtcStamp(event.updatedAt);
    lines.push(
      'BEGIN:VEVENT',
      // One meal per day, so the date identifies the event: changing the meal updates it rather than duplicating it.
      `UID:meal-${event.date}@${uidDomain}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compactDate(event.date)}`,
      `DTEND;VALUE=DATE:${compactDate(nextDay(event.date))}`,
      `SUMMARY:${escapeText(event.name)}`,
      ...(description ? [`DESCRIPTION:${escapeText(description)}`] : []),
      ...(modified ? [`LAST-MODIFIED:${modified}`] : []),
      'TRANSP:TRANSPARENT', // don't show you as "busy" all day
      'END:VEVENT',
    );

    const frozen = event.ingredients.filter((i) => i.frozen);
    if (thawTime && frozen.length) {
      const day = previousDay(event.date);
      const names = frozen.map((i) => i.name).join(', ');
      const details = [`For tomorrow's ${event.name}:`, ...frozen.map((i) => `• ${i.name}${i.quantity ? ` — ${i.quantity}` : ''}`)].join('\n');
      lines.push(
        'BEGIN:VEVENT',
        // Keyed to the meal's date, so it moves/updates along with that day's meal.
        `UID:thaw-${event.date}@${uidDomain}`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${floatingDateTime(day, thawTime)}`,
        `DTEND:${floatingDateTime(day, thawTime, 15)}`,
        `SUMMARY:${escapeText(`❄ Take out: ${names}`)}`,
        `DESCRIPTION:${escapeText(details)}`,
        ...(modified ? [`LAST-MODIFIED:${modified}`] : []),
        'TRANSP:TRANSPARENT',
        // Apple Calendar removes alerts from subscriptions unless "Remove alerts" is unticked;
        // the event itself is always visible either way.
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escapeText(`Take out of the freezer: ${names}`)}`,
        'TRIGGER:PT0M',
        'END:VALARM',
        'END:VEVENT',
      );
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildCalendar, escapeText, fold, nextDay, previousDay, floatingDateTime };
