import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailer } from '../../core/mail.js';

const log = { info() {}, error() {} };

test('mail transports get meta as a second argument, never inside the message', async () => {
  const mailer = createMailer({ log, mode: 'test', from: 'App <no-reply@example.test>' });
  const seen = [];
  const observed = [];
  mailer.observe((m) => observed.push(m));
  mailer.use({ name: 'fake', send: async (msg, extra) => seen.push({ msg, extra }) });

  await mailer.send({ to: 'a@example.test', subject: 'Reset', text: 'x', meta: { kind: 'password-reset', token: 'reset_abc' } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].msg.meta, undefined, 'meta (which can hold tokens) is not part of what gets sent');
  assert.equal(seen[0].msg.from, 'App <no-reply@example.test>');
  assert.deepEqual(seen[0].extra.meta, { kind: 'password-reset', token: 'reset_abc' });
  assert.equal(observed[0].meta.kind, 'password-reset', 'observers still see meta');

  seen[0].extra.meta.kind = 'changed';
  assert.equal(observed[0].meta.kind, 'password-reset', 'transports get a copy');

  await mailer.send({ to: 'b@example.test', subject: 'Hi', text: 'y' });
  assert.deepEqual(seen[1].extra.meta, {}, 'an empty object when the message has no meta');
});
