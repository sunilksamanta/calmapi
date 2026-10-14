// Tiny schedule parser (UTC).
//   cron:      '*/15 * * * *', '0 9 * * 1-5', '@hourly', '@daily', '@weekly', '@monthly'
//   interval:  'every 30s', 'every 5m', 'every 2h', 'every 1d'

const SHORTCUTS = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *' };
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export const parseDuration = (text) => {
  if (typeof text === 'number') return text;
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(String(text).trim());
  if (!m) throw new Error(`Invalid duration "${text}" (use e.g. 30s, 5m, 2h, 1d)`);
  return Number(m[1]) * UNITS[m[2]];
};

function parseField(field, [min, max]) {
  const values = new Set();
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    const [lo, upper] = range === '*' ? [min, max] : range.split('-').map(Number);
    const hi = upper ?? (stepText ? max : lo);
    if (![lo, hi, step].every(Number.isInteger) || lo < min || hi > max || lo > hi || step < 1) throw new Error(`Invalid cron field "${field}"`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

export function parseSchedule(expr) {
  const text = String(expr).trim();
  if (text.startsWith('every ')) return { kind: 'interval', ms: parseDuration(text.slice(6)) };
  const fields = (SHORTCUTS[text] ?? text).split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron "${expr}": expected 5 fields`);
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f.replace(/^7$/, '0'), RANGES[i]));
  return { kind: 'cron', minute, hour, dom, month, dow, domAny: fields[2] === '*', dowAny: fields[4] === '*' };
}

/** Next run strictly after `from`. */
export function nextRun(schedule, from = new Date()) {
  if (schedule.kind === 'interval') return new Date(from.getTime() + schedule.ms);
  const d = new Date(from.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const dayOk = schedule.domAny && schedule.dowAny
      ? true
      : schedule.domAny
        ? schedule.dow.has(d.getUTCDay())
        : schedule.dowAny
          ? schedule.dom.has(d.getUTCDate())
          : schedule.dom.has(d.getUTCDate()) || schedule.dow.has(d.getUTCDay());
    if (!schedule.month.has(d.getUTCMonth() + 1) || !dayOk) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!schedule.hour.has(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (schedule.minute.has(d.getUTCMinutes())) return d;
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  throw new Error('Schedule never matches');
}
