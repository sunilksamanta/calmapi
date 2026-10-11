import { styleText } from 'node:util';
import { currentRequest } from './context.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const BADGE = {
  debug: ['gray', 'DBG'],
  info: ['cyan', 'INF'],
  warn: ['yellow', 'WRN'],
  error: ['red', 'ERR'],
};

/**
 * Tiny structured logger. Pretty in development, one JSON object per line in production.
 * Every line is tagged with the current requestId automatically.
 */
export function createLogger({ level = 'info', format = 'pretty', sinks = [] } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;

  const write = (lvl, msg, fields = {}) => {
    const req = currentRequest();
    const entry = {
      time: new Date().toISOString(),
      level: lvl,
      msg,
      ...(req ? { requestId: req.id } : {}),
      ...serializeFields(fields),
    };
    for (const sink of sinks) sink(entry);
    if (LEVELS[lvl] < min) return;
    const out = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
    out.write(format === 'json' ? `${JSON.stringify(entry)}\n` : pretty(entry));
  };

  const log = {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    addSink: (fn) => sinks.push(fn),
    level,
  };
  return log;
}

function serializeFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    out[key] = value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
  }
  return out;
}

function pretty({ time, level, msg, requestId: _requestId, ...rest }) {
  const [color, badge] = BADGE[level];
  const extras = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      if (v && typeof v === 'object' && v.stack) return `\n${styleText('gray', v.stack)}`;
      return styleText('gray', `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
    })
    .join(' ');
  const t = styleText('gray', time.slice(11, 19));
  return `${t} ${styleText(color, badge)} ${msg}${extras ? ` ${extras}` : ''}\n`;
}
