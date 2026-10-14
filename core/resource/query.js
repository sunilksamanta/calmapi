// List query language. Only fields you mark filterable/sortable/searchable can be used,
// so clients can never filter on private data or run arbitrary Mongo operators.
//
//   GET /api/posts?status=published&price[gte]=10&tags[in]=a,b
//                 &sort=-createdAt,title&page=2&limit=20
//                 &q=hello&include=author&fields=title,status

import { badRequest } from '../errors.js';
import { escapeRegex } from '../utils/strings.js';
import { isObjectId } from './fields.js';
import { outputSelect } from './resource.js';

const RESERVED = new Set(['page', 'limit', 'sort', 'q', 'include', 'fields']);
const KEY = /^([A-Za-z_][\w.]*)(?:\[(\w+)\])?$/;
const MONGO_OP = { eq: '$eq', ne: '$ne', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte', in: '$in', nin: '$nin', all: '$all' };

export function parseListQuery(def, query, { registry, pagination = { defaultLimit: 20, maxLimit: 100 } } = {}) {
  const details = {};
  const filter = {};

  for (const [rawKey, rawValue] of Object.entries(query ?? {})) {
    if (RESERVED.has(rawKey)) continue;
    const m = KEY.exec(rawKey);
    if (!m) {
      details[rawKey] = 'Unknown query parameter';
      continue;
    }
    const [, name, op = 'eq'] = m;
    const value = Array.isArray(rawValue) ? rawValue.flatMap(splitList) : rawValue;

    if (name === 'id') {
      if (op !== 'eq' && op !== 'in' && op !== 'nin') {
        details[rawKey] = 'id supports eq, in, nin';
        continue;
      }
      const ids = [value].flat().flatMap(splitList);
      if (!ids.every(isObjectId)) {
        details[rawKey] = 'Must be valid ids';
        continue;
      }
      filter._id = op === 'eq' && ids.length === 1 ? ids[0] : { [op === 'nin' ? '$nin' : '$in']: ids };
      continue;
    }

    const field = def.fields[name];
    const ops = field?.filterOps ?? [];
    if (!field || !field.isOutput || ops.length === 0) {
      details[rawKey] = `Not filterable. Filterable fields: ${filterableList(def) || 'none'}`;
      continue;
    }
    if (!ops.includes(op)) {
      details[rawKey] = `Operator "${op}" not allowed on ${name}. Allowed: ${ops.join(', ')}`;
      continue;
    }

    if (op === 'exists') {
      const b = parseBool(value);
      if (b === undefined) details[rawKey] = 'Must be true or false';
      else (filter[name] ??= {}).$exists = b;
      continue;
    }

    const list = op === 'in' || op === 'nin' || op === 'all';
    const rawItems = list ? [value].flat().flatMap(splitList) : [value].flat();
    if (rawItems.length === 0 || rawItems.length > 100 || (!list && rawItems.length > 1)) {
      details[rawKey] = list ? 'Provide between 1 and 100 values' : 'Provide a single value';
      continue;
    }
    const itemField = field.type === 'array' ? field.opts.of : field;
    const coerced = rawItems.map((v) => coerce(itemField, v));
    if (coerced.some((c) => c === INVALID)) {
      details[rawKey] = `Invalid value for ${name}`;
      continue;
    }

    const mongoValue = list ? coerced : coerced[0];
    if (op === 'eq' && !isPlainObjectFilter(filter[name])) filter[name] = mongoValue;
    else {
      const current = isPlainObjectFilter(filter[name]) ? filter[name] : filter[name] !== undefined ? { $eq: filter[name] } : {};
      current[MONGO_OP[op]] = mongoValue;
      filter[name] = current;
    }
  }

  // Free text search across .searchable() fields (escaped, so no regex injection).
  const q = typeof query?.q === 'string' ? query.q.trim() : '';
  if (q) {
    const searchable = Object.entries(def.fields).filter(([, field]) => field.opts.searchable).map(([k]) => k);
    if (!searchable.length) details.q = 'This resource has no searchable fields';
    else if (q.length > 100) details.q = 'Search is limited to 100 characters';
    else {
      const re = new RegExp(escapeRegex(q), 'i');
      filter.$or = searchable.map((k) => ({ [k]: re }));
    }
  }

  // Sorting
  const sortable = new Set(['_id', ...Object.entries(def.fields).filter(([, field]) => field.opts.sortable).map(([k]) => k)]);
  if (def.timestamps) sortable.add('createdAt').add('updatedAt');
  const sort = {};
  const sortParam = typeof query?.sort === 'string' && query.sort ? query.sort : def.defaultSort;
  for (const part of splitList(sortParam)) {
    const desc = part.startsWith('-');
    let key = desc ? part.slice(1) : part;
    if (key === 'id') key = '_id';
    if (!sortable.has(key)) {
      details.sort = `Cannot sort by "${key}". Sortable: ${[...sortable].map((k) => (k === '_id' ? 'id' : k)).join(', ')}`;
      break;
    }
    sort[key] = desc ? -1 : 1;
  }
  if (!('_id' in sort)) sort._id = sort[Object.keys(sort)[0]] ?? -1; // stable pagination

  // Pagination
  const page = query?.page === undefined ? 1 : Number(query.page);
  const limit = query?.limit === undefined ? pagination.defaultLimit : Number(query.limit);
  if (!Number.isInteger(page) || page < 1) details.page = 'Must be a positive integer';
  if (!Number.isInteger(limit) || limit < 1 || limit > pagination.maxLimit) {
    details.limit = `Must be an integer between 1 and ${pagination.maxLimit}`;
  }

  const populate = parseInclude(def, query?.include, registry, details);
  const only = parseFields(def, query?.fields, details);

  if (Object.keys(details).length) throw badRequest('Invalid query', details);
  return { filter, sort, page, limit, skip: (page - 1) * limit, populate, only };
}

/** ?include=author,category → populate specs with each target's safe projection. */
export function parseInclude(def, include, registry, details = {}) {
  const names = new Set(Object.entries(def.fields).filter(([, field]) => field.opts.populate).map(([k]) => k));
  if (typeof include === 'string') {
    for (const name of splitList(include)) {
      const field = def.fields[name];
      const ref = field?.type === 'ref' ? field : field?.type === 'array' && field.opts.of.type === 'ref' ? field.opts.of : null;
      if (!ref || !field.isOutput) {
        details.include = `Cannot include "${name}". Includable: ${includableList(def) || 'none'}`;
        continue;
      }
      names.add(name);
    }
  }
  return [...names].map((name) => {
    const field = def.fields[name];
    const refName = field.type === 'ref' ? field.opts.ref : field.opts.of.opts.ref;
    const target = registry?.get(refName);
    return { path: name, select: target ? outputSelect(target.def) : '_id' };
  });
}

function parseFields(def, fields, details) {
  if (typeof fields !== 'string' || !fields) return null;
  const list = splitList(fields);
  const bad = list.filter((k) => !def.fields[k]?.isOutput);
  if (bad.length) details.fields = `Unknown fields: ${bad.join(', ')}`;
  return list;
}

const INVALID = Symbol('invalid');

function coerce(field, raw) {
  const value = String(raw);
  switch (field.kind) {
    case 'number': {
      const n = Number(value);
      if (value.trim() === '' || !Number.isFinite(n)) return INVALID;
      return n;
    }
    case 'boolean':
      return parseBool(value) ?? INVALID;
    case 'date': {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? INVALID : d;
    }
    case 'id':
      return isObjectId(value) ? value : INVALID;
    case 'string':
      if (field.type === 'enum' && !field.opts.values.includes(value)) return INVALID;
      return field.opts.lowercase ? value.toLowerCase() : value;
    default:
      return INVALID;
  }
}

const splitList = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const parseBool = (v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : undefined);
const isPlainObjectFilter = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
const filterableList = (def) => Object.entries(def.fields).filter(([, f]) => f.filterOps.length).map(([k]) => k).join(', ');
const includableList = (def) =>
  Object.entries(def.fields)
    .filter(([, f]) => f.isOutput && (f.type === 'ref' || (f.type === 'array' && f.opts.of.type === 'ref')))
    .map(([k]) => k)
    .join(', ');
