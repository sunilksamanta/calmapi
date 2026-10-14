import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from '../helpers.js';

// app.idle() (t.idle() in tests, and stop()) waits for work that starts more work:
// an event listener that queues a background task that emits another event...

test('idle waits for chains of events and background tasks', async () => {
  const project = await makeProject();
  const t = await project.testApp();
  try {
    const done = [];
    const later = (ms) => new Promise((r) => setTimeout(r, ms));
    t.app.events.on('chain.one', () => t.app.background(async () => {
      await later(20);
      done.push('task 1');
      t.app.events.emit('chain.two');
    }));
    t.app.events.on('chain.two', async () => {
      await later(20);
      t.app.background(async () => {
        await later(20);
        done.push('task 2');
      });
    });
    t.app.events.emit('chain.one');
    await t.idle();
    assert.deepEqual(done, ['task 1', 'task 2']);
  } finally {
    await t.close();
    project.cleanup();
  }
});
