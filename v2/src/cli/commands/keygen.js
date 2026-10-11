import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { findProjectRoot } from '../lib/project.js';
import { c, out, ok, info } from '../lib/ui.js';

export const help = `
${c.bold('calm keygen')} [--write]

  Generate an AES-256 key for .encrypted() fields.

  --write   add it to .env. If CALM_ENCRYPTION_KEYS already exists, the new key goes
            first (it encrypts from now on) and the old keys stay (they still decrypt):
            that is key rotation. Re-save records over time, then drop old keys.
`;

export async function run(argv) {
  const { values } = parseArgs({ args: argv, options: { write: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) return out(help);
  const secret = randomBytes(32).toString('base64');
  const root = findProjectRoot();
  const envFile = root ? join(root, '.env') : null;
  if (!values.write || !envFile) {
    out('', `CALM_ENCRYPTION_KEYS=k1:${secret}`, '');
    return info('Add this line to .env (and to your production secrets). Never commit it.');
  }
  const text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  const m = /^CALM_ENCRYPTION_KEYS=(.*)$/m.exec(text);
  if (!m) {
    writeFileSync(envFile, `${text}${text.endsWith('\n') || !text ? '' : '\n'}CALM_ENCRYPTION_KEYS=k1:${secret}\n`);
    return ok('Added CALM_ENCRYPTION_KEYS to .env (key k1).');
  }
  const ids = m[1].split(',').map((p) => p.split(':')[0]);
  let n = ids.length + 1;
  while (ids.includes(`k${n}`)) n++;
  writeFileSync(envFile, text.replace(m[0], `CALM_ENCRYPTION_KEYS=k${n}:${secret},${m[1]}`));
  ok(`Rotated: k${n} encrypts new data; ${ids.join(', ')} still decrypt existing data.`);
}
