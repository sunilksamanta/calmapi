// The five CRUD routes every resource gets (unless `crud: false` or a subset is listed).
//
//   GET    /posts        list     200 { data: [...], meta: { total, page, limit, pages } }
//   GET    /posts/:id    read     200 { data }
//   POST   /posts        create   201 { data }
//   PATCH  /posts/:id    update   200 { data }   (partial; PUT is accepted as an alias)
//   DELETE /posts/:id    delete   204

import { RouteBuilder, Reply } from '../http/router.js';
import { validateInput, serialize } from './resource.js';
import { parseListQuery, parseInclude } from './query.js';

export function crudRoutes(app, entry) {
  const { def } = entry;
  const enabled = def.crud === true ? ['list', 'read', 'create', 'update', 'delete'] : Array.isArray(def.crud) ? def.crud : [];
  const r = new RouteBuilder({ app, prefix: def.path, entry, source: 'crud', file: entry.files?.resource });
  const ser = (doc, ctx, only) => serialize(def, doc, { user: ctx.user, registry: app.registry, only });
  const opts = (action, extra) => ({ policy: def.policy[action], action, ...extra });

  if (enabled.includes('list')) {
    r.get('/', opts('list', { summary: `List ${def.name} records`, output: 'list' }), async (ctx) => {
      const q = parseListQuery(def, ctx.query, { registry: app.registry, pagination: app.config.pagination });
      const { items, total } = await entry.service.list(q, ctx);
      const data = await Promise.all(items.map((doc) => ser(doc, ctx, q.only)));
      return new Reply(data, { meta: { total, page: q.page, limit: q.limit, pages: Math.ceil(total / q.limit) } });
    });
  }

  if (enabled.includes('read')) {
    r.get('/:id', opts('read', { summary: `Get one ${def.name}`, output: 'item' }), async (ctx) => {
      const details = {};
      const populate = parseInclude(def, ctx.query.include, app.registry, details);
      const doc = populate.length ? await entry.service.get(ctx.doc._id, { populate }, ctx) : ctx.doc;
      return ser(doc, ctx);
    });
  }

  if (enabled.includes('create')) {
    r.post('/', opts('create', { summary: `Create a ${def.name}`, status: 201, output: 'item', input: 'create' }), async (ctx) => {
      const data = await validateInput(def, ctx.req.body, { mode: 'create', user: ctx.user, unknownFields: app.config.unknownFields });
      const doc = await entry.service.create(data, ctx);
      return ser(doc, ctx);
    });
  }

  if (enabled.includes('update')) {
    const update = async (ctx) => {
      const data = await validateInput(def, ctx.req.body, { mode: 'update', user: ctx.user, doc: ctx.doc, unknownFields: app.config.unknownFields });
      const doc = await entry.service.update(ctx.doc._id, data, ctx);
      return ser(doc, ctx);
    };
    r.patch('/:id', opts('update', { summary: `Update a ${def.name}`, output: 'item', input: 'update' }), update);
    r.put('/:id', opts('update', { summary: `Update a ${def.name} (alias of PATCH)`, output: 'item', input: 'update', hidden: true }), update);
  }

  if (enabled.includes('delete')) {
    r.delete('/:id', opts('delete', { summary: `Delete a ${def.name}` }), async (ctx) => {
      await entry.service.remove(ctx.doc._id, ctx);
    });
  }

  // CRUD routes validate their own bodies (they need the record for writableBy rules),
  // so the builder must not run generic input validation on them.
  for (const route of r.routes) {
    route.inputSchema = route.input;
    route.input = null;
    route.policyExplicit = !def.defaultedPolicies.includes(route.action);
  }
  return r.routes;
}
