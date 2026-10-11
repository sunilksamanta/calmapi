import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from '../helpers.js';

test('calm audit passes on the api template and covers every persona', async () => {
  const project = await makeProject();
  try {
    const { runAudit } = await project.load('calm/security/audit.js');
    const report = await runAudit({ root: project.dir });
    assert.equal(report.ok, true, JSON.stringify(report.results.filter((r) => r.ok === false).concat(report.leaks, report.probes.filter((p) => !p.ok))));
    assert.deepEqual(report.matrix.personas.map((p) => p.key), ['anonymous', 'user', 'owner', 'admin']);
    const userCreate = report.results.find((r) => r.resource === 'user' && r.action === 'create' && r.persona === 'user');
    assert.deepEqual([userCreate.expected, userCreate.ok], ['deny', true]);
    assert.ok(report.probes.some((p) => p.name === 'mass assignment: post.author' && p.ok));
  } finally {
    project.cleanup();
  }
});

test('calm audit catches a service that ignores ownership and a field that leaks', async () => {
  const project = await makeProject({
    files: {
      'app/resources/note/note.resource.js': `
import { resource, f } from '#calm';
export default resource('note', {
  fields: { text: f.string().required(), author: f.ref('user').owner(), diagnosis: f.string().visibleTo('owner') },
  policy: { list: 'owner', read: 'authenticated', create: 'authenticated', update: 'owner', delete: 'owner' },
});`,
      // Bug 1: list() ignores the owner scope. Bug 2: a custom route returns raw docs to anyone.
      'app/resources/note/note.service.js': `
import { ResourceService } from '#calm';
export default class NoteService extends ResourceService {
  async list(q) { const items = await this.model.find({}).lean(); return { items, total: items.length }; }
}`,
      'app/resources/editor-role/editor-role.resource.js': `
import { resource, f } from '#calm';
export default resource('editor-role', {
  fields: { title: f.string().required(), draft: f.string().visibleTo('editor | admin') },
  policy: { list: 'editor | admin', read: 'editor | admin', create: 'editor | admin', update: 'editor', delete: 'admin' },
});`,
    },
  });
  try {
    const { runAudit } = await project.load('calm/security/audit.js');
    const report = await runAudit({ root: project.dir });
    assert.equal(report.ok, false);
    const ownBug = report.results.find((r) => r.resource === 'note' && r.action === 'list' && r.ok === false);
    assert.match(ownBug.note, /owned by someone else/);
    assert.ok(report.matrix.personas.some((p) => p.key === 'role:editor'), 'custom roles become personas');
    const editorRead = report.results.find((r) => r.resource === 'editor-role' && r.action === 'read' && r.persona === 'role:editor');
    assert.deepEqual([editorRead.expected, editorRead.ok], ['allow', true]);
  } finally {
    project.cleanup();
  }
});
