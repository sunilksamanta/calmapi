import { parseArgs } from 'node:util';
import { requireProject, capture } from '../lib/project.js';
import { c, out, ok } from '../lib/ui.js';

export const help = `
${c.bold('calm admin <email>')} [--revoke]

  Give an existing user the admin role (or take it away with --revoke).
  Uses MONGODB_URI from .env. The change applies to their next request.

  First admin: sign up through POST /api/auth/register, then run this.
`;

// Runs inside the project with its own calm/ code and database connection.
const SCRIPT = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [email, revoke] = [process.env.CALM_ADMIN_EMAIL, process.env.CALM_ADMIN_REVOKE === '1'];
let result;
try {
  const { createApp } = await import(pathToFileURL(join(process.cwd(), 'calm', 'index.js')).href);
  const app = await createApp({ root: process.cwd(), config: { mode: process.env.NODE_ENV || 'development', log: { level: 'silent' }, devtools: { enabled: false }, db: { connectRetries: 1 } } });
  if (!app.registry.has('user')) throw new Error('This project has no user resource.');
  await app.start();
  const User = app.model('user');
  const user = await User.findOne({ email: email.toLowerCase().trim() }).lean();
  if (!user) throw new Error('No user with email ' + email + '. Sign up first (POST /api/auth/register), then run this again.');
  const update = revoke ? { $pull: { roles: 'admin' } } : { $addToSet: { roles: 'admin' } };
  const after = await User.findOneAndUpdate({ _id: user._id }, update, { returnDocument: 'after' }).lean();
  result = { id: String(after._id), name: after.name, email: after.email, roles: after.roles };
  await app.stop();
} catch (err) {
  result = { error: err.message };
}
// Exit once the pipe took everything: exiting right after a large write cuts the output short.
process.stdout.write('\\n@@CALM@@' + JSON.stringify(result), () => process.exit(0));
`;

export async function run(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { revoke: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help || !positionals[0]) return out(help);
  const root = requireProject();
  const res = await capture(process.execPath, ['--input-type=module', '-e', SCRIPT], {
    cwd: root,
    env: { CALM_ADMIN_EMAIL: positionals[0], CALM_ADMIN_REVOKE: values.revoke ? '1' : '0' },
  });
  const marker = res.stdout.lastIndexOf('@@CALM@@');
  if (marker === -1) throw new Error(`Could not run in the project:\n${res.stderr || res.stdout}`);
  const result = JSON.parse(res.stdout.slice(marker + 8));
  if (result.error) throw new Error(result.error);
  ok(`${result.name} <${result.email}> roles: ${result.roles.join(', ') || '(none)'}`);
}
