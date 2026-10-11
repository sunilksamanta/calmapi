#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`CalmAPI needs Node.js 22.12 or newer (you have ${process.versions.node}). Node 24 LTS is recommended.`);
  process.exit(1);
}
// `calm routes | head` closes the pipe early: that is not an error.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});
const { main } = await import('../src/cli/index.js');
await main(process.argv.slice(2));
