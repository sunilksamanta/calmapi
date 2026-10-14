import { defineJob } from '#app/blocks/jobs/index.js';

// Example job: runs in the background whenever someone signs up.
// Other triggers: schedule: '0 9 * * 1-5' (cron, UTC) or schedule: 'every 10m',
// or enqueue manually: ctx.app.ext.jobs.enqueue('welcome-email', { user })
export default defineJob({
  name: 'welcome-email',
  on: 'auth.registered',
  retries: 3,
  async run({ user }, { app }) {
    await app.mailer.send({
      to: user.email,
      subject: `Welcome to ${app.config.app.name}`,
      text: `Hi ${user.name},\n\nYour account is ready. Happy building!`,
    });
  },
});
