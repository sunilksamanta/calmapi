// Field builders. One declaration drives the Mongoose schema, input validation,
// output visibility, query permissions and the OpenAPI schema.
//
//   title: f.string().required().max(200).searchable().sortable()
//   price: f.number().min(0).filterable()
//   cost:  f.number().hidden()          // stored, never returned
//   author: f.ref('user').owner()       // set from the session, drives 'owner' policies

import { passwordProblem } from '../auth/password-policy.js';

const STRING_TYPES = new Set(['string', 'text', 'email', 'url', 'password']);
const OBJECT_ID = /^[a-f\d]{24}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_OPS = {
  string: ['eq', 'ne', 'in', 'nin', 'exists'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'exists'],
  date: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists'],
  boolean: ['eq', 'ne', 'exists'],
  id: ['eq', 'ne', 'in', 'nin', 'exists'],
  array: ['eq', 'in', 'nin', 'all', 'exists'],
  json: ['exists'],
};

export class Field {
  constructor(type, opts = {}) {
    this.type = type;
    this.opts = opts;
  }

  #with(patch) {
    return new Field(this.type, { ...this.opts, ...patch });
  }

  // ---- shape and validation ----------------------------------------------------
  required(message) { return this.#with({ required: true, requiredMessage: message }); }
  optional() { return this.#with({ required: false }); }
  default(value) { return this.#with({ default: value }); }
  min(n, message) { return this.#with({ min: n, minMessage: message }); }
  max(n, message) { return this.#with({ max: n, maxMessage: message }); }
  pattern(re, message) { return this.#with({ pattern: re, patternMessage: message }); }
  trim(on = true) { return this.#with({ trim: on }); }
  lowercase() { return this.#with({ lowercase: true }); }
  uppercase() { return this.#with({ uppercase: true }); }
  unique() { return this.#with({ unique: true, index: true }); }
  index() { return this.#with({ index: true }); }
  /** Custom rule: return true when valid, or a message string when invalid. */
  check(fn, message) { return this.#with({ checks: [...(this.opts.checks ?? []), { fn, message }] }); }
  /** Validate with any Standard Schema library (Zod, Valibot, ArkType...). */
  schema(standardSchema) { return this.#with({ standard: standardSchema }); }
  describe(text) { return this.#with({ description: text }); }
  example(value) { return this.#with({ example: value }); }

  // ---- visibility and write rules --------------------------------------------
  /** Stored but never returned and never accepted from clients. */
  hidden() { return this.#with({ hidden: true }); }
  /** Accepted from clients, never returned (passwords, secrets). */
  writeOnly() { return this.#with({ writeOnly: true }); }
  /** Returned, but clients cannot set it. */
  readOnly() { return this.#with({ readOnly: true }); }
  /** Can be set on create, cannot be changed afterwards. */
  immutable() { return this.#with({ immutable: true }); }
  /** Only users matching the policy may set this field, e.g. .writableBy('admin'). */
  writableBy(policy) { return this.#with({ writableBy: policy }); }
  /** Only users matching the policy see this field, e.g. .visibleTo('owner | admin'). */
  visibleTo(policy) { return this.#with({ visibleTo: policy }); }
  /** Encrypted at rest with AES-256-GCM (CALM_ENCRYPTION_KEYS). Cannot be queried. */
  encrypted() { return this.#with({ encrypted: true }); }
  /**
   * Personal data (a phone number, an address...). calm doctor warns when it is readable by
   * everyone, and the privacy block blanks it when an account is anonymized.
   */
  pii() { return this.#with({ pii: true }); }

  // ---- querying ------------------------------------------------------------------
  filterable(ops) { return this.#with({ filterable: ops ?? true }); }
  sortable() { return this.#with({ sortable: true, index: this.opts.index ?? true }); }
  searchable() { return this.#with({ searchable: true }); }

  // ---- relations -----------------------------------------------------------------
  /** Marks a ref('user') field as the owner of the record. Set automatically on create. */
  owner() {
    if (this.type !== 'ref') throw new Error('.owner() is only valid on f.ref() fields');
    return this.#with({ owner: true, readOnly: true, index: true });
  }
  /** Populate this reference by default when reading. */
  populate() { return this.#with({ populate: true }); }

  // ---- introspection helpers ---------------------------------------------------
  get isString() { return STRING_TYPES.has(this.type); }
  get kind() {
    if (this.isString || this.type === 'enum') return 'string';
    if (this.type === 'integer') return 'number';
    if (this.type === 'ref' || this.type === 'id') return 'id';
    return this.type;
  }
  get isOutput() { return !this.opts.hidden && !this.opts.writeOnly && this.type !== 'password'; }
  get isInput() { return !this.opts.hidden && !this.opts.readOnly; }
  get filterOps() {
    const { filterable } = this.opts;
    if (!filterable) return [];
    return Array.isArray(filterable) ? filterable : (DEFAULT_OPS[this.kind] ?? ['eq']);
  }
}

const make = (type, opts) => new Field(type, opts);

export const f = {
  string: () => make('string', { trim: true }),
  text: () => make('text'),
  email: () => make('email', { trim: true, lowercase: true }),
  url: () => make('url', { trim: true }),
  /** A password: hashed with scrypt before saving, never returned, min 8 chars. */
  password: () => make('password', { writeOnly: true, min: 8, max: 128 }),
  number: () => make('number'),
  integer: () => make('integer'),
  boolean: () => make('boolean'),
  date: () => make('date'),
  enum: (values) => make('enum', { values }),
  id: () => make('id'),
  ref: (resource) => make('ref', { ref: resource }),
  array: (of) => make('array', { of }),
  object: (shape) => make('object', { shape }),
  json: () => make('json'),
};

// ---------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------

/**
 * Validate and normalize a single value. Returns { value } or { error }.
 * `value` is never undefined here; null is handled by the caller.
 */
export async function validateValue(field, value, path = '') {
  const o = field.opts;
  let v = value;

  switch (field.type) {
    case 'string':
    case 'text':
    case 'email':
    case 'url':
    case 'password': {
      if (typeof v !== 'string') return { error: 'Must be a string' };
      if (o.trim) v = v.trim();
      if (o.lowercase) v = v.toLowerCase();
      if (o.uppercase) v = v.toUpperCase();
      if (o.required && v === '') return { error: o.requiredMessage ?? 'Is required' };
      if (o.min !== undefined && v.length < o.min) return { error: o.minMessage ?? `Must be at least ${o.min} characters` };
      if (o.max !== undefined && v.length > o.max) return { error: o.maxMessage ?? `Must be at most ${o.max} characters` };
      if (field.type === 'email' && !EMAIL.test(v)) return { error: 'Must be a valid email address' };
      if (field.type === 'url' && !isHttpUrl(v)) return { error: 'Must be a valid http(s) URL' };
      if (o.pattern && !o.pattern.test(v)) return { error: o.patternMessage ?? 'Has an invalid format' };
      if (field.type === 'password') {
        const problem = passwordProblem(v);
        if (problem) return { error: problem };
      }
      break;
    }
    case 'number':
    case 'integer': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { error: 'Must be a number' };
      if (field.type === 'integer' && !Number.isInteger(v)) return { error: 'Must be an integer' };
      if (o.min !== undefined && v < o.min) return { error: o.minMessage ?? `Must be at least ${o.min}` };
      if (o.max !== undefined && v > o.max) return { error: o.maxMessage ?? `Must be at most ${o.max}` };
      break;
    }
    case 'boolean':
      if (typeof v !== 'boolean') return { error: 'Must be true or false' };
      break;
    case 'date': {
      const d = typeof v === 'string' || typeof v === 'number' ? new Date(v) : null;
      if (!d || Number.isNaN(d.getTime())) return { error: 'Must be a valid date' };
      if (o.min !== undefined && d < new Date(o.min)) return { error: o.minMessage ?? `Must be on or after ${o.min}` };
      if (o.max !== undefined && d > new Date(o.max)) return { error: o.maxMessage ?? `Must be on or before ${o.max}` };
      v = d;
      break;
    }
    case 'enum':
      if (!o.values.includes(v)) return { error: `Must be one of: ${o.values.join(', ')}` };
      break;
    case 'id':
    case 'ref':
      if (typeof v !== 'string' || !OBJECT_ID.test(v)) return { error: 'Must be a valid id' };
      break;
    case 'array': {
      if (!Array.isArray(v)) return { error: 'Must be an array' };
      if (o.min !== undefined && v.length < o.min) return { error: o.minMessage ?? `Must contain at least ${o.min} items` };
      if (o.max !== undefined && v.length > o.max) return { error: o.maxMessage ?? `Must contain at most ${o.max} items` };
      const out = [];
      for (let i = 0; i < v.length; i++) {
        if (v[i] === null || v[i] === undefined) return { error: `Item ${i} is empty` };
        const r = await validateValue(o.of, v[i], `${path}[${i}]`);
        if (r.error) return { error: `Item ${i}: ${r.error}` };
        out.push(r.value);
      }
      v = out;
      break;
    }
    case 'object': {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return { error: 'Must be an object' };
      const out = {};
      for (const key of Object.keys(v)) {
        if (!o.shape[key]) return { error: `Unknown field "${key}"` };
        if (!o.shape[key].isInput) return { error: `${key}: Is read-only` };
      }
      for (const [key, sub] of Object.entries(o.shape)) {
        const raw = v[key];
        if (raw === undefined || raw === null) {
          if (sub.opts.required && sub.opts.default === undefined) return { error: `${key}: Is required` };
          if (raw === null) out[key] = null;
          continue;
        }
        const r = await validateValue(sub, raw, `${path}.${key}`);
        if (r.error) return { error: `${key}: ${r.error}` };
        out[key] = r.value;
      }
      v = out;
      break;
    }
    case 'json':
      break;
    default:
      return { error: `Unknown field type ${field.type}` };
  }

  for (const { fn, message } of o.checks ?? []) {
    const res = await fn(v);
    if (res !== true) return { error: typeof res === 'string' ? res : (message ?? 'Is invalid') };
  }

  if (o.standard?.['~standard']) {
    const res = await o.standard['~standard'].validate(v);
    if (res.issues?.length) return { error: res.issues[0].message };
    v = res.value;
  }

  return { value: v };
}

const isHttpUrl = (s) => {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

export const isObjectId = (s) => typeof s === 'string' && OBJECT_ID.test(s);

// ---------------------------------------------------------------------------------
// JSON Schema (used by OpenAPI)
// ---------------------------------------------------------------------------------

export function toJSONSchema(field) {
  const o = field.opts;
  let s;
  switch (field.type) {
    case 'string': case 'text': case 'password': s = { type: 'string' }; break;
    case 'email': s = { type: 'string', format: 'email' }; break;
    case 'url': s = { type: 'string', format: 'uri' }; break;
    case 'number': s = { type: 'number' }; break;
    case 'integer': s = { type: 'integer' }; break;
    case 'boolean': s = { type: 'boolean' }; break;
    case 'date': s = { type: 'string', format: 'date-time' }; break;
    case 'enum': s = { type: 'string', enum: o.values }; break;
    case 'id': case 'ref': s = { type: 'string', pattern: '^[a-f0-9]{24}$' }; break;
    case 'array': s = { type: 'array', items: toJSONSchema(o.of) }; break;
    case 'object': {
      s = { type: 'object', additionalProperties: false, properties: {} };
      const req = [];
      for (const [k, sub] of Object.entries(o.shape)) {
        s.properties[k] = toJSONSchema(sub);
        if (sub.opts.required) req.push(k);
      }
      if (req.length) s.required = req;
      break;
    }
    default: s = {};
  }
  if (field.isString) {
    if (o.min !== undefined) s.minLength = o.min;
    if (o.max !== undefined) s.maxLength = o.max;
    if (o.pattern) s.pattern = o.pattern.source;
  } else if (field.kind === 'number') {
    if (o.min !== undefined) s.minimum = o.min;
    if (o.max !== undefined) s.maximum = o.max;
  } else if (field.type === 'array') {
    if (o.min !== undefined) s.minItems = o.min;
    if (o.max !== undefined) s.maxItems = o.max;
  }
  if (o.default !== undefined && typeof o.default !== 'function') s.default = o.default;
  if (o.description) s.description = o.description;
  if (o.example !== undefined) s.examples = [o.example];
  if (o.readOnly) s.readOnly = true;
  if (o.writeOnly || field.type === 'password') s.writeOnly = true;
  return s;
}
