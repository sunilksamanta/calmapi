import { definePlugin, hasRole, serialize, validateInput, parseListQuery, evaluatePolicy, parsePolicy, CalmError, badRequest, forbidden, notFound, validationError } from '#calm';
import { csvRow, parseCsv, unprotect } from './csv.js';

// Export and import any resource as CSV, NDJSON or JSON.
//
//   GET  /api/admin/export                      what can be exported, with the columns
//   GET  /api/admin/export/:resource            ?format=csv|ndjson|json plus the list filters (?status=draft&sort=-createdAt&fields=title)
//   POST /api/admin/import/:resource            ?format=&dryRun=true&mode=create|upsert&skipInvalid=true
//   GET  /api/export/:resource                  with the `self` option: your own records only
//
//  - Exports stream from a MongoDB cursor and respect backpressure, so a million records never
//    sit in memory. A failure midway cuts the connection: half a file must not look whole.
//  - Every record goes through serialize() as the caller would see it in the API: hidden and
//    write-only fields and password hashes are never read, visibleTo() rules apply, and
//    .encrypted() fields are never exported at all (an export is a copy outside the database).
//  - Filters, sorting and ?fields= use the list route's own parser: only filterable and
//    sortable fields, no Mongo operators from the client.
//  - CSV cells are escaped (RFC 4180) and protected against formula injection (csv.js).
//  - Imports run every row through the resource's own validation (validateInput) and then its
//    service, so hooks, defaults and password hashing apply. Nothing is written when a row is
//    invalid, unless skipInvalid=true. dryRun=true reports per row errors and writes nothing.

const FORMATS = {
  csv: { type: 'text/csv; charset=utf-8', ext: 'csv' },
  ndjson: { type: 'application/x-ndjson; charset=utf-8', ext: 'ndjson' },
  json: { type: 'application/json; charset=utf-8', ext: 'json' },
};
const CONTENT_TYPES = { 'text/csv': 'csv', 'application/x-ndjson': 'ndjson', 'application/ndjson': 'ndjson', 'application/json': 'json' };
const isId = (s) => typeof s === 'string' && /^[a-f\d]{24}$/i.test(s);
const flag = (v) => v === 'true' || v === '1';
const IGNORED_ON_IMPORT = new Set(['id', '_id', 'createdAt', 'updatedAt']); // managed by CalmAPI, present in every export

/** Write respecting backpressure; fail fast when the client went away. */
function writer(res) {
  return (text) => {
    if (res.destroyed) return Promise.reject(new Error('The client disconnected during the export'));
    if (res.write(text)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (err) => {
        res.off('drain', onDrain);
        res.off('close', onClose);
        if (err) reject(err);
        else resolve();
      };
      const onDrain = () => done();
      const onClose = () => done(new Error('The client disconnected during the export'));
      res.once('drain', onDrain);
      res.once('close', onClose);
    });
  };
}

/** Request bodies that are not JSON (CSV, NDJSON) as text, up to `limit` bytes. */
function readText(limit) {
  return (req, _res, next) => {
    if (req.body !== undefined || req.is('application/json')) return next(); // express.json() read it already
    if (Number(req.headers['content-length']) > limit) return next(new CalmError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'));
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        return next(new CalmError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'));
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      req.calmText = Buffer.concat(chunks).toString('utf8');
      next();
    });
    req.on('error', (err) => !failed && next(err));
  };
}

export default definePlugin({
  name: 'export',
  options: {
    /** Resources admins may export and import. null: every resource. */
    resources: null,
    /** Never exported or imported, whatever `resources` says. */
    exclude: [],
    /** Let signed-in users export their own records: true (every resource with an owner) or ['note', 'order']. */
    self: false,
    /** Records read from MongoDB per batch. */
    batchSize: 500,
    /** Exports per user (needs config.rateLimit.enabled). false: only the global limit. */
    exportLimit: { windowMs: 60 * 60_000, max: 30 },
    /** Largest CSV or NDJSON import body. JSON imports use config.bodyLimit and config.jsonLimits. */
    importLimitMb: 10,
    importMaxRows: 10_000,
    /** Most per row errors listed in an import report. */
    maxErrors: 100,
  },
  setup(calm, options) {
    const exportable = (name) => {
      if ((options.exclude ?? []).includes(name)) return false;
      return options.resources === null || options.resources === undefined || options.resources.includes(name);
    };
    const selfAllowed = (name) => options.self === true || (Array.isArray(options.self) && options.self.includes(name));

    function entryFor(name) {
      const entry = calm.app.registry.get(String(name));
      if (!entry || !exportable(entry.def.name)) throw notFound('Unknown or not exportable resource');
      return entry;
    }

    /** Fields that may leave the database in an export: returned by the API and not encrypted. */
    const exportFields = (def) => Object.entries(def.fields).filter(([, field]) => field.isOutput && !field.opts.encrypted).map(([key]) => key);

    /** Columns for this viewer: a visibleTo() field the viewer can never see gets no column. */
    async function columnsOf(def, only, user) {
      const fields = [];
      for (const key of exportFields(def)) {
        if (only && !only.includes(key)) continue;
        const rule = def.fields[key].opts.visibleTo;
        if (rule && !(await evaluatePolicy(parsePolicy(rule), { user, action: 'read', explain: false })).allow) continue;
        fields.push(key);
      }
      return ['id', ...fields, ...(def.timestamps ? ['createdAt', 'updatedAt'] : [])];
    }

    function formatOf(value, fallback) {
      const format = value ?? fallback;
      if (!FORMATS[format]) throw badRequest('Invalid query', { format: `One of: ${Object.keys(FORMATS).join(', ')}` });
      return format;
    }

    /** Stream the records of `entry` matching the request's filters to the response. */
    async function streamExport(ctx, entry, { scope }) {
      const { def, model, service } = entry;
      const { format: rawFormat, page: _page, limit: _limit, ...query } = ctx.query;
      const format = formatOf(rawFormat, 'csv');
      const q = parseListQuery(def, query, { registry: calm.app.registry, pagination: calm.config.pagination });
      // Without ?sort, _id order: the cheapest and stable for big collections.
      const sort = query.sort ? q.sort : { _id: 1 };
      const where = service.filterFor({ ...ctx, scope }, q.filter);
      const columns = await columnsOf(def, q.only, ctx.user);
      // Only what may be exported is read: hidden and encrypted values never leave MongoDB.
      const select = [...new Set([...exportFields(def), ...(def.ownerField && def.ownerField !== '_id' ? [def.ownerField] : []), ...(def.timestamps ? ['createdAt', 'updatedAt'] : [])])].join(' ');
      const encrypted = Object.entries(def.fields).filter(([, field]) => field.opts.encrypted).map(([key]) => key);

      const res = ctx.res;
      const date = new Date().toISOString().slice(0, 10);
      res.status(200);
      res.setHeader('Content-Type', FORMATS[format].type);
      res.setHeader('Content-Disposition', `attachment; filename="${def.name}-export-${date}.${FORMATS[format].ext}"`);
      res.setHeader('Cache-Control', 'no-store');
      const write = writer(res);

      let n = 0;
      let chunk = format === 'csv' ? csvRow(columns) : format === 'json' ? '[' : '';
      const cursor = model.find(where).sort(sort).select(select).allowDiskUse(true).lean().cursor({ batchSize: options.batchSize });
      try {
        for await (const doc of cursor) {
          const out = await serialize(def, doc, { user: ctx.user, registry: calm.app.registry, only: q.only });
          for (const key of encrypted) delete out[key];
          if (format === 'csv') chunk += csvRow(columns.map((c) => out[c]));
          else if (format === 'ndjson') chunk += `${JSON.stringify(out)}\n`;
          else chunk += `${n ? ',' : ''}\n${JSON.stringify(out)}`;
          n += 1;
          if (n % options.batchSize === 0) {
            await write(chunk);
            chunk = '';
          }
        }
      } finally {
        await cursor.close();
      }
      await write(format === 'json' ? `${chunk}${n ? '\n' : ''}]\n` : chunk);
      res.end();
      return n;
    }

    async function exportRoute(ctx, entry, meta) {
      let count;
      try {
        count = await streamExport(ctx, entry, meta);
      } catch (err) {
        if (!ctx.res.headersSent) {
          ctx.res.removeHeader('Content-Disposition');
          throw err;
        }
        if (ctx.res.destroyed) calm.log.info('export: cancelled by the client', { resource: entry.def.name });
        else calm.log.error('export: failed midway', { err, resource: entry.def.name });
        ctx.res.destroy();
        return;
      }
      calm.events.emit('export.exported', { resource: entry.def.name, count, userId: ctx.user.id, self: meta.scope === 'owner', format: ctx.query.format ?? 'csv' });
    }

    /** Rows of an import body: [{ ...values }], CSV cells as strings. */
    function rowsOf(ctx) {
      const contentType = String(ctx.req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const format = formatOf(ctx.query.format, CONTENT_TYPES[contentType] ?? 'csv');
      if (format === 'json') {
        const body = ctx.req.body;
        const rows = Array.isArray(body) ? body : Array.isArray(body?.rows) ? body.rows : null;
        if (!rows) throw badRequest('Send a JSON array of records, or { "rows": [...] }');
        return { format, rows };
      }
      const text = ctx.req.calmText ?? (typeof ctx.req.body === 'string' ? ctx.req.body : '');
      if (format === 'ndjson') {
        const rows = [];
        for (const [i, line] of text.split(/\r?\n/).entries()) {
          if (!line.trim()) continue;
          try {
            rows.push(JSON.parse(line));
          } catch {
            throw badRequest(`Line ${i + 1} is not valid JSON`);
          }
        }
        return { format, rows };
      }
      let table;
      try {
        table = parseCsv(text);
      } catch (err) {
        throw badRequest(`Invalid CSV: ${err.message}`);
      }
      const [header = [], ...lines] = table;
      const keys = header.map((h) => h.trim());
      if (new Set(keys).size !== keys.length) throw badRequest('The CSV header has duplicate columns');
      return { format, rows: lines.map((cells) => Object.fromEntries(keys.map((k, i) => [k, cells[i] ?? '']))) };
    }

    /** CSV cells are text: turn them into the types the fields expect before validation. */
    function fromCsv(field, raw) {
      const text = unprotect(raw);
      if (text === '') return undefined;
      const type = field?.type === 'array' || field?.type === 'object' || field?.type === 'json' ? 'structured' : field?.kind;
      if (type === 'number') return text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : text;
      if (type === 'boolean') return text === 'true' || text === '1' ? true : text === 'false' || text === '0' ? false : text;
      if (type === 'structured') {
        try {
          return JSON.parse(text);
        } catch {
          return text; // a plain string: fine for json fields, validation reports it for the others
        }
      }
      return text;
    }

    async function importRows(ctx, entry) {
      const { def, model, service } = entry;
      const { format, rows } = rowsOf(ctx);
      if (rows.length > options.importMaxRows) throw badRequest(`Too many rows: ${rows.length}, at most ${options.importMaxRows}`);
      const dryRun = flag(ctx.query.dryRun);
      const skipInvalid = flag(ctx.query.skipInvalid);
      const mode = ctx.query.mode ?? 'create';
      if (!['create', 'upsert'].includes(mode)) throw badRequest('Invalid query', { mode: 'One of: create, upsert' });
      const owner = def.ownerField && def.ownerField !== '_id' ? def.ownerField : null;

      const ignoredColumns = new Set();
      const errors = [];
      const planned = [];
      for (const [i, row] of rows.entries()) {
        const line = i + 1;
        if (row === null || typeof row !== 'object' || Array.isArray(row)) {
          errors.push({ row: line, errors: { row: 'Must be an object' } });
          continue;
        }
        const input = {};
        let ownerValue;
        for (const [key, value] of Object.entries(row)) {
          if (IGNORED_ON_IMPORT.has(key)) continue;
          const field = def.fields[key];
          const v = format === 'csv' ? fromCsv(field, String(value ?? '')) : value;
          if (key === owner) {
            ownerValue = v;
            continue;
          }
          // Read-only columns (computed fields, slugs...) are in every export: skip, do not fail.
          if (field?.isOutput && !field.isInput) {
            ignoredColumns.add(key);
            continue;
          }
          if (v !== undefined) input[key] = v;
        }
        const id = row.id ?? row._id;
        try {
          const existing = mode === 'upsert' && isId(String(id ?? '')) ? await model.findOne(service.filterFor({ ...ctx, scope: null }, { _id: String(id) })).lean() : null;
          const data = await validateInput(def, input, { mode: existing ? 'update' : 'create', user: ctx.user, doc: existing ?? undefined, unknownFields: calm.config.unknownFields });
          // Admins keep the owner of imported records (a restore), never change it on update.
          if (owner && ownerValue !== undefined && !existing) {
            if (!isId(String(ownerValue))) throw validationError({ [owner]: 'Must be a valid id' });
            data[owner] = String(ownerValue);
          }
          planned.push({ line, id: existing?._id ?? null, data });
        } catch (err) {
          if (!err?.details) throw err;
          errors.push({ row: line, errors: err.details });
        }
      }

      const report = (extra) => ({
        dryRun,
        format,
        mode,
        total: rows.length,
        valid: planned.length,
        invalid: errors.length,
        created: 0,
        updated: 0,
        failed: 0,
        ignoredColumns: [...ignoredColumns],
        ...extra,
        errors: (extra?.errors ?? errors).slice(0, options.maxErrors),
      });
      if (dryRun) return report();
      if (errors.length && !skipInvalid) {
        const details = {};
        for (const e of errors.slice(0, options.maxErrors)) for (const [key, message] of Object.entries(e.errors)) details[`rows.${e.row}.${key}`] = message;
        throw validationError(details, `${errors.length} of ${rows.length} rows are invalid; nothing was imported (dryRun=true lists them, skipInvalid=true imports the others)`);
      }

      // Writes go through the service: hooks, defaults, password hashing and events apply.
      let created = 0;
      let updated = 0;
      const writeErrors = [];
      for (const p of planned) {
        try {
          if (p.id) {
            await service.update(p.id, p.data, { ...ctx, scope: null });
            updated += 1;
          } else {
            await service.create(p.data, ctx);
            created += 1;
          }
        } catch (err) {
          const field = err?.code === 11000 ? Object.keys(err.keyValue ?? err.keyPattern ?? {})[0] : null;
          if (field) writeErrors.push({ row: p.line, errors: { [field]: 'Already taken' } });
          else if (err?.details) writeErrors.push({ row: p.line, errors: err.details });
          else if (err instanceof CalmError) writeErrors.push({ row: p.line, errors: { row: err.message } });
          else throw err;
        }
      }
      const all = [...errors, ...writeErrors].sort((a, b) => a.row - b.row);
      calm.events.emit('export.imported', { resource: def.name, created, updated, failed: all.length, userId: ctx.user.id });
      return report({ created, updated, failed: all.length, errors: all });
    }

    calm.routes((r) => {
      const tags = ['export'];
      const limit = options.exportLimit ? { ...options.exportLimit, key: (req) => `export:${req.user?.id ?? req.ip}` } : null;

      r.get('/admin/export', { policy: 'admin', summary: 'Resources that can be exported, with their columns', tags }, async (ctx) => {
        const list = [];
        for (const { def } of calm.app.registry.values()) {
          if (!exportable(def.name)) continue;
          list.push({ resource: def.name, columns: await columnsOf(def, null, ctx.user), ownerField: def.ownerField ?? null, self: selfAllowed(def.name) && Boolean(def.ownerField) });
        }
        return list;
      });

      r.get(
        '/admin/export/:resource',
        { policy: 'admin', rateLimit: limit, summary: 'Export a resource (CSV, NDJSON or JSON), streamed', description: 'Takes the list route filters, ?sort= and ?fields=.', tags },
        (ctx) => exportRoute(ctx, entryFor(ctx.params.resource), { scope: null }),
      );

      r.post(
        '/admin/import/:resource',
        {
          policy: 'admin',
          summary: 'Import records from CSV, NDJSON or JSON (dryRun=true validates only)',
          description: 'Every row is validated by the resource. ?mode=upsert updates rows whose id exists. ?skipInvalid=true imports the valid rows when some are invalid.',
          // Admins only, checked before the body is read: nobody else can make the server buffer it.
          middleware: [(req, _res, next) => next(hasRole(req.user, 'admin') ? undefined : forbidden()), readText(options.importLimitMb * 1024 * 1024)],
          tags,
        },
        (ctx) => importRows(ctx, entryFor(ctx.params.resource)),
      );

      if (options.self) {
        r.get('/export/:resource', { policy: 'authenticated', rateLimit: limit, summary: 'Export your own records of a resource', tags }, async (ctx) => {
          const entry = entryFor(ctx.params.resource);
          if (!selfAllowed(entry.def.name) || !entry.def.ownerField) throw notFound('Unknown or not exportable resource');
          // Only records the user owns, and only if the resource lets them read their own.
          const read = await evaluatePolicy(entry.def.policy.read, { user: ctx.user, action: 'read', req: ctx.req, explain: false });
          if (!read.allow) throw forbidden();
          return exportRoute(ctx, entry, { scope: 'owner' });
        });
      }
    });

    calm.doctor((app) => {
      const findings = [];
      const unknown = [...(options.resources ?? []), ...(options.exclude ?? []), ...(Array.isArray(options.self) ? options.self : [])].filter((name) => !app.registry.has(name));
      if (unknown.length) findings.push({ level: 'warn', id: 'export-unknown-resource', title: `export: blocks.export names ${[...new Set(unknown)].join(', ')}`, detail: 'No resource has that name. Check the spelling.' });
      const noOwner = Array.isArray(options.self) ? options.self.filter((name) => app.registry.has(name) && !app.registry.get(name).def.ownerField) : [];
      if (noOwner.length) findings.push({ level: 'warn', id: 'export-self-no-owner', title: `export: ${noOwner.join(', ')} cannot be exported by users`, detail: 'Self export needs an owner field (f.ref(\'user\').owner()).' });
      return findings;
    });
  },
});
