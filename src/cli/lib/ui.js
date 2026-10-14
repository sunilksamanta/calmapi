import { styleText } from 'node:util';
import { createInterface } from 'node:readline/promises';

export const c = {
  bold: (s) => styleText('bold', String(s)),
  dim: (s) => styleText('gray', String(s)),
  green: (s) => styleText('green', String(s)),
  red: (s) => styleText('red', String(s)),
  yellow: (s) => styleText('yellow', String(s)),
  cyan: (s) => styleText('cyan', String(s)),
  magenta: (s) => styleText('magenta', String(s)),
  blue: (s) => styleText('blue', String(s)),
};

export const out = (...lines) => process.stdout.write(`${lines.join('\n')}\n`);
export const ok = (msg) => out(`${c.green('✔')} ${msg}`);
export const info = (msg) => out(`${c.cyan('•')} ${msg}`);
export const warn = (msg) => out(`${c.yellow('!')} ${msg}`);
export const fail = (msg) => process.stderr.write(`${c.red('✖')} ${msg}\n`);

export const METHOD_COLOR = { GET: c.green, POST: c.blue, PUT: c.yellow, PATCH: c.yellow, DELETE: c.red };

export function banner(subtitle) {
  out('', `  ${styleText(['bold', 'green'], 'CalmAPI')} ${c.dim(subtitle)}`, '');
}

/** Render rows as an aligned table. Columns are padded on visible width. */
export function table(rows, { indent = 2 } = {}) {
  if (!rows.length) return '';
  const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => strip(r[i] ?? '').length)));
  return rows
    .map((r) => ' '.repeat(indent) + r.map((cell, i) => String(cell ?? '') + ' '.repeat(widths[i] - strip(cell ?? '').length)).join('  ').trimEnd())
    .join('\n');
}

const interactive = () => process.stdin.isTTY && process.stdout.isTTY && !process.env.CI;

export async function ask(question, fallback) {
  if (!interactive()) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${c.cyan('?')} ${question}${fallback ? c.dim(` (${fallback})`) : ''} `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

export async function choose(question, options, fallback = options[0].value) {
  if (!interactive()) return fallback;
  out(`${c.cyan('?')} ${question}`);
  options.forEach((o, i) => out(`  ${c.bold(i + 1)}. ${o.label}${o.hint ? c.dim(`  ${o.hint}`) : ''}`));
  const def = options.findIndex((o) => o.value === fallback) + 1;
  const answer = await ask('Choose', String(def));
  const n = Number(answer);
  return options[n - 1]?.value ?? fallback;
}

export async function confirm(question, fallback = true) {
  const answer = await ask(`${question} ${c.dim(fallback ? '[Y/n]' : '[y/N]')}`, '');
  if (!answer) return fallback;
  return /^y(es)?$/i.test(answer);
}
