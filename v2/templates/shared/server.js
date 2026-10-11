import { createApp } from '#calm';

try {
  const app = await createApp({ root: import.meta.dirname });
  await app.listen();
} catch (err) {
  console.error(err.code === 'CALM_CONFIG' ? `\n${err.message}\n` : err);
  process.exit(1);
}
