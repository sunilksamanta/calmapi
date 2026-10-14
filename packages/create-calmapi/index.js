#!/usr/bin/env node
// npm create calmapi@latest [dir] [--template api|minimal] [--yes] ...
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`CalmAPI needs Node.js 22.12 or newer (you have ${process.versions.node}). Node 24 LTS is recommended.`);
  process.exit(1);
}
const { main } = await import('calmapi/cli');
await main(['create', ...process.argv.slice(2)]);
