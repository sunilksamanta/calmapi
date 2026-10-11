import { Field, validateValue, toJSONSchema } from './fields.js';
import { parsePolicy, fieldAllowed } from './policy.js';
import { kebab, pluralize, camel, isPlainObject } from '../utils/strings.js';
import { validationError } from '../errors.js';

const ACTIONS = ['list', 'read', 'create', 'update', 'delete'];
const RESERVED = new Set(['id', '_id', 'createdAt', 'updatedAt', '__v']);

/**
 * Declare a resource. This is a plain description; the app compiles it at boot.
 *
 * @param {string} name singular name, e.g. 'post' or 'product-category'
 * @param {{
 *   fields: Record<string, Field>,
 *   policy?: Partial<Record<'list'|'read'|'create'|'update'|'delete', any>>,
 *   path?: string, collection?: string, timestamps?: boolean,
 *   owner?: string, defaultSort?: string, crud?: boolean | string[],
 *   indexes?: Array<{ fields: object, options?: object }>,
 *   description?: string,
 *   [key: string]: any,
 * }} def
 */
export function resource(name, def) {
  if (!name || typeof name !== 'string') throw new Error('resource(name, def): name is required');
  if (!def || !isPlainObject(def.fields)) throw new Error(`resource('${name}'): "fields" is required`);

  const slug = kebab(name);
  const fields = {};
  let ownerField = def.owner ?? null;

  for (const [key, field] of Object.entries(def.fields)) {
    if (!(field instanceof Field)) throw new Error(`resource('${slug}'): field "${key}" must be built with f.*()`);
    if (RESERVED.has(key)) throw new Error(`resource('${slug}'): "${key}" is managed by CalmAPI, remove it from fields`);
    if (field.opts.owner) {
      if (ownerField && ownerField !== key) throw new Error(`resource('${slug}'): only one field can be .owner()`);
      ownerField = key;
    }
    fields[key] = field;
  }

  const policy = {};
  const defaultedPolicies = [];
  for (const action of ACTIONS) {
    if (def.policy?.[action] !== undefined) policy[action] = parsePolicy(def.policy[action]);
    else {
      defaultedPolicies.push(action);
      policy[action] = parsePolicy(
        action === 'list' || action === 'read' ? 'authenticated' : ownerField ? 'owner | admin' : 'admin',
      );
    }
  }

  const { fields: _f, policy: _p, ...options } = def;
  return Object.freeze({
    kind: 'calm.resource',
    name: slug,
    modelName: camel(slug),
    collection: def.collection ?? pluralize(slug).replace(/-/g, '_'),
    path: def.path ?? `/${pluralize(slug)}`,
    fields,
    policy,
    defaultedPolicies,
    ownerField,
    timestamps: def.timestamps !== false,
    defaultSort: def.defaultSort ?? (def.timestamps === false ? '_id' : '-createdAt'),
    crud: def.crud ?? true,
    indexes: def.indexes ?? [],
    description: def.description,
    options,
  });
}

export const isResource = (value) => value?.kind === 'calm.resource';

// ---------------------------------------------------------------------------------
// Mongoose compilation
// ---------------------------------------------------------------------------------

export function compileResource(def, mongoose) {
  const { Schema } = mongoose;
  const shape = {};
  for (const [key, field] of Object.entries(def.fields)) shape[key] = mongooseType(field, Schema);

  const schema = new Schema(shape, {
    timestamps: def.timestamps,
    collection: def.collection,
    versionKey: false,
  });
  for (const { fields, options } of def.indexes) schema.index(fields, options);
  for (const plugin of def.options.schemaPlugins ?? []) schema.plugin(plugin);

  return mongoose.model(def.modelName, schema);
}

function mongooseType(field, Schema) {
  const o = field.opts;
  let t;
  switch (field.type) {
    case 'string': case 'text': case 'email': case 'url': case 'password': t = { type: String }; break;
    case 'enum': t = { type: String, enum: o.values }; break;
    case 'number': case 'integer': t = { type: Number }; break;
    case 'boolean': t = { type: Boolean }; break;
    case 'date': t = { type: Date }; break;
    case 'id': t = { type: Schema.Types.ObjectId }; break;
    case 'ref': t = { type: Schema.Types.ObjectId, ref: camel(o.ref) }; break;
    case 'array': t = { type: [mongooseType(o.of, Schema)] }; break;
    case 'object': {
      const sub = {};
      for (const [k, f] of Object.entries(o.shape)) sub[k] = mongooseType(f, Schema);
      t = { type: new Schema(sub, { _id: false }) };
      break;
    }
    case 'json': t = { type: Schema.Types.Mixed }; break;
    default: throw new Error(`Unknown field type ${field.type}`);
  }
  if (o.trim) t.trim = true;
  if (o.lowercase) t.lowercase = true;
  if (o.uppercase) t.uppercase = true;
  if (o.unique) t.unique = true;
  else if (o.index) t.index = true;
  if (o.immutable) t.immutable = true;
  if (o.hidden || o.writeOnly || field.type === 'password') t.select = false;
  if (o.default !== undefined) {
    const d = o.default;
    t.default = typeof d === 'function' ? d : d !== null && typeof d === 'object' ? () => structuredClone(d) : d;
  }
  return t;
}

// ---------------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------------

/**
 * Validate a create/update payload against the resource's fields.
 * Unknown, read-only and hidden fields are rejected with a clear message
 * instead of being silently written (no mass assignment).
 */
export async function validateInput(def, input, { mode, user, doc, unknownFields = 'reject' } = {}) {
  if (!isPlainObject(input)) throw validationError({ body: 'Request body must be a JSON object' }, 'Request body must be a JSON object');

  const details = {};
  const out = {};
  for (const key of Object.keys(input)) {
    const field = def.fields[key];
    const raw = input[key];
    if (!field) {
      if (unknownFields === 'reject' && !RESERVED.has(key)) details[key] = 'Unknown field';
      continue;
    }
    if (!field.isInput) {
      details[key] = 'Is read-only';
      continue;
    }
    if (mode === 'update' && field.opts.immutable) {
      details[key] = 'Cannot be changed after creation';
      continue;
    }
    if (mode === 'update' && field.type === 'password') {
      details[key] = 'Use POST /api/auth/password (or the reset flow) to change passwords';
      continue;
    }
    if (field.opts.writableBy) {
      const ok = await fieldAllowed(parsePolicy(field.opts.writableBy), { user, resource: def, doc, action: mode });
      if (!ok) {
        details[key] = 'You are not allowed to set this field';
        continue;
      }
    }
    if (raw === undefined) continue;
    if (raw === null) {
      if (field.opts.required) details[key] = field.opts.requiredMessage ?? 'Is required';
      else out[key] = null;
      continue;
    }
    const res = await validateValue(field, raw, key);
    if (res.error) details[key] = res.error;
    else out[key] = res.value;
  }

  if (mode === 'create') {
    for (const [key, field] of Object.entries(def.fields)) {
      if (!field.opts.required || !field.isInput || details[key]) continue;
      if (out[key] === undefined && field.opts.default === undefined) details[key] = field.opts.requiredMessage ?? 'Is required';
    }
  }

  if (Object.keys(details).length) throw validationError(details);
  return out;
}

// ---------------------------------------------------------------------------------
// Output serialization
// ---------------------------------------------------------------------------------

const isObjectIdLike = (v) => v?._bsontype === 'ObjectId';
const isPopulated = (v) => v !== null && typeof v === 'object' && !isObjectIdLike(v) && v._id !== undefined;

/**
 * Turn a stored document into what the API returns.
 * Hidden and write-only fields never appear. visibleTo() rules are applied per record,
 * including on populated references, so a populated author never leaks private data.
 */
export async function serialize(def, doc, ctx, depth = 0) {
  if (!doc) return null;
  const out = { id: String(doc._id) };
  for (const [key, field] of Object.entries(def.fields)) {
    if (!field.isOutput || !(key in doc)) continue;
    if (ctx.only && !ctx.only.includes(key)) continue;
    if (field.opts.visibleTo) {
      const ok = await fieldAllowed(parsePolicy(field.opts.visibleTo), { user: ctx.user, resource: def, doc, action: 'read' });
      if (!ok) continue;
    }
    out[key] = await serializeValue(field, doc[key], ctx, depth);
  }
  if (def.timestamps) {
    if (doc.createdAt !== undefined) out.createdAt = doc.createdAt;
    if (doc.updatedAt !== undefined) out.updatedAt = doc.updatedAt;
  }
  return out;
}

async function serializeValue(field, value, ctx, depth) {
  if (value === null || value === undefined) return value ?? null;
  switch (field.type) {
    case 'ref': {
      if (isPopulated(value)) {
        const target = ctx.registry?.get(field.opts.ref);
        if (target && depth < 2) return serialize(target.def, value, { ...ctx, only: null }, depth + 1);
        return String(value._id);
      }
      return String(value);
    }
    case 'id':
      return String(value);
    case 'array':
      return Promise.all(value.map((v) => serializeValue(field.opts.of, v, ctx, depth)));
    case 'object': {
      const out = {};
      for (const [k, sub] of Object.entries(field.opts.shape)) {
        if (!sub.isOutput || value[k] === undefined) continue;
        out[k] = await serializeValue(sub, value[k], ctx, depth);
      }
      return out;
    }
    default:
      return value;
  }
}

/** Mongoose `select` for a populated reference: only fields that could ever be returned. */
export function outputSelect(def) {
  const keys = Object.entries(def.fields)
    .filter(([, field]) => field.isOutput)
    .map(([key]) => key);
  if (def.ownerField && def.ownerField !== '_id' && !keys.includes(def.ownerField)) keys.push(def.ownerField);
  if (def.timestamps) keys.push('createdAt', 'updatedAt');
  return keys.join(' ');
}

// ---------------------------------------------------------------------------------
// JSON Schemas (OpenAPI, Standard Schema)
// ---------------------------------------------------------------------------------

export function resourceJSONSchema(def, mode) {
  const properties = {};
  const required = [];
  if (mode === 'output') properties.id = { type: 'string', readOnly: true };
  for (const [key, field] of Object.entries(def.fields)) {
    if (mode === 'output' ? !field.isOutput : !field.isInput) continue;
    if (mode === 'update' && field.opts.immutable) continue;
    properties[key] = toJSONSchema(field);
    if (mode === 'create' && field.opts.required && field.opts.default === undefined) required.push(key);
  }
  if (mode === 'output' && def.timestamps) {
    properties.createdAt = { type: 'string', format: 'date-time', readOnly: true };
    properties.updatedAt = { type: 'string', format: 'date-time', readOnly: true };
  }
  const schema = { type: 'object', properties };
  if (mode !== 'output') schema.additionalProperties = false;
  if (required.length) schema.required = required;
  return schema;
}

/**
 * Expose a resource's input rules as a Standard Schema (https://standardschema.dev),
 * so other tools can validate data exactly like the API does.
 */
export function standardSchema(def, mode = 'create') {
  return {
    '~standard': {
      version: 1,
      vendor: 'calmapi',
      async validate(value) {
        try {
          return { value: await validateInput(def, value, { mode }) };
        } catch (err) {
          if (!err.details) throw err;
          return { issues: Object.entries(err.details).map(([key, message]) => ({ message, path: [key] })) };
        }
      },
    },
  };
}
