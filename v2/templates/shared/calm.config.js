import { defineConfig } from '#calm';

// Overrides for calm/config.js defaults. Keep secrets in .env, not here.
// This file can also export a function: ({ env, mode }) => ({ ... })
export default defineConfig({
  pagination: { defaultLimit: 20, maxLimit: 100 },
  auth: {
    sessionTtlDays: 30,
    resetTokenTtlMinutes: 30,
  },
  mail: { from: '{{title}} <no-reply@example.com>' },
});
