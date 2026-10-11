import { definePlugin, f, notFound } from '#calm';

// resource('post', { softDelete: true, ... }) turns deletes into a deletedAt timestamp.
// Every query on that resource ignores deleted records unless its filter mentions
// deletedAt itself (e.g. { deletedAt: { $ne: null } }) or it sets { withDeleted: true }.

const QUERY_HOOKS = ['find', 'findOne', 'countDocuments', 'findOneAndUpdate', 'updateOne', 'updateMany'];

function excludeDeleted(schema) {
  for (const hook of QUERY_HOOKS) {
    schema.pre(hook, function () {
      if (this.getOptions().withDeleted) return;
      const filter = this.getFilter();
      if (filter.deletedAt === undefined) this.where({ deletedAt: null });
    });
  }
  schema.pre('aggregate', function () {
    if (!this.options.withDeleted) this.pipeline().unshift({ $match: { deletedAt: null } });
  });
}

export default definePlugin({
  name: 'soft-delete',
  setup(calm) {
    const enabled = new Set();

    calm.onResource((def) => {
      if (!def.options.softDelete) return def;
      enabled.add(def.name);
      def.fields.deletedAt = f.date().hidden();
      def.options.schemaPlugins = [...(def.options.schemaPlugins ?? []), excludeDeleted];
      return def;
    });

    calm.onService(({ def, model, service }) => {
      if (!enabled.has(def.name)) return;
      service.remove = async (id, ctx = {}) => {
        const doc = await model.findOne(service.filterFor(ctx, { _id: id })).select(service.internalSelect).lean();
        if (!doc) throw notFound(`${def.name} not found`);
        await service.beforeDelete(doc, ctx);
        await model.updateOne({ _id: doc._id }, { $set: { deletedAt: new Date() } });
        await service.afterDelete(doc, ctx);
        calm.events.emit(`${def.name}.deleted`, { doc, resource: def.name, user: ctx.user ?? null, soft: true });
        return doc;
      };
      service.restore = async (id, ctx = {}) => {
        const doc = await model.findOneAndUpdate({ _id: id, deletedAt: { $ne: null } }, { $set: { deletedAt: null } }, { returnDocument: 'after' }).lean();
        if (!doc) throw notFound(`No deleted ${def.name} with that id`);
        calm.events.emit(`${def.name}.restored`, { doc, resource: def.name, user: ctx.user ?? null });
        return doc;
      };
    });

    calm.onStart((app) => {
      for (const name of enabled) {
        const entry = app.registry.get(name);
        app.log.debug(`soft-delete enabled for ${name}`, { path: entry.def.path });
      }
    });

    calm.routes((r) => {
      for (const name of calm.app.registry.keys()) {
        if (!enabled.has(name)) continue;
        const entry = calm.app.registry.get(name);
        const base = entry.def.path;
        r.get(`${base}/trash`, { policy: 'admin', summary: `Deleted ${name} records`, tags: [name] }, async (ctx) => {
          const docs = await entry.model.find({ deletedAt: { $ne: null } }).sort({ deletedAt: -1 }).limit(100).lean();
          return Promise.all(docs.map((d) => ctx.serialize(d, name)));
        });
        r.post(`${base}/:recordId/restore`, { policy: 'admin', summary: `Restore a deleted ${name}`, tags: [name] }, async (ctx) =>
          ctx.serialize(await entry.service.restore(ctx.params.recordId, ctx), name),
        );
      }
    });
  },
});
