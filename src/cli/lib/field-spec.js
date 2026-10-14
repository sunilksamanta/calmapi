// Parse `calm make resource` field specs into f.*() code.
//
//   title:string+required         required string
//   price:number=0                number with default
//   status:enum:draft,live=draft  enum with default
//   category:ref:category         reference (ref alone uses the field name: category:ref)
//   tags:string+array             array of strings
//   title:string+required+searchable+sortable    extra modifiers
//
// Every spec above is safe to type unquoted in bash, zsh and fish. The short forms
// `title:string!` (required) and `tags:string[]` (array) still work, but `!` starts history
// expansion and `[]` a filename pattern in zsh, so they need quotes there: 'title:string!'.

import { kebab } from './strings.js';

const TYPES = {
  string: 'string', str: 'string', text: 'text', email: 'email', url: 'url', password: 'password',
  number: 'number', num: 'number', float: 'number', integer: 'integer', int: 'integer',
  boolean: 'boolean', bool: 'boolean', date: 'date', datetime: 'date', enum: 'enum',
  ref: 'ref', id: 'id', json: 'json', object: 'json',
};
// required and array are flags of the spec itself, the others become f.*() calls.
const FLAGS = { required: 'required', req: 'required', array: 'array', list: 'array', many: 'array' };
const MODIFIERS = new Set(['searchable', 'sortable', 'filterable', 'unique', 'index', 'hidden', 'writeOnly', 'readOnly', 'immutable', 'populate', 'owner']);

export function parseFieldSpec(spec) {
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('Empty field spec. Expected name:type, e.g. title:string+required');
  // A default may contain '+' (a phone prefix, say): only the part before '=' carries modifiers,
  // unless modifiers follow the default (price:number=0+sortable).
  const eq = spec.indexOf('=');
  const head = eq === -1 ? spec : spec.slice(0, eq);
  let tail = eq === -1 ? '' : spec.slice(eq);
  const headParts = head.split('+');
  let mods = headParts.slice(1);
  if (tail) {
    const extra = tail.split('+');
    const known = extra.slice(1).every((m) => MODIFIERS.has(m) || Object.hasOwn(FLAGS, m));
    if (extra.length > 1 && known) {
      tail = extra[0];
      mods = [...mods, ...extra.slice(1)];
    }
  }
  const main = headParts[0] + tail;
  const m = /^([A-Za-z_][\w]*):([A-Za-z]+)(\[\])?(?::([^=!]+?))?(\[\])?(!)?(?:=(.*))?$/.exec(main);
  if (!m) throw new Error(`Cannot parse field "${spec}". Expected name:type[+required][+array][=default], e.g. title:string+required or tags:string+array`);
  const [, name, rawType, arr1, arg, arr2, bang, def] = m;
  const type = TYPES[rawType.toLowerCase()];
  if (!type) throw new Error(`Unknown type "${rawType}" in "${spec}". Types: ${[...new Set(Object.values(TYPES))].join(', ')}`);
  const flags = new Set();
  const modifiers = [];
  for (const mod of mods) {
    if (mod === '') throw new Error(`Empty modifier in "${spec}" (two + in a row?)`);
    if (Object.hasOwn(FLAGS, mod)) flags.add(FLAGS[mod]);
    else if (MODIFIERS.has(mod)) modifiers.push(mod);
    else throw new Error(`Unknown modifier "+${mod}" in "${spec}". Modifiers: required, array, ${[...MODIFIERS].join(', ')}`);
  }
  if (type === 'enum' && !arg) throw new Error(`enum needs values: ${name}:enum:a,b,c`);
  if (type === 'enum' && arg.split(',').some((v) => !v.trim())) throw new Error(`enum "${name}" has an empty value: ${arg}`);
  if (def === '') throw new Error(`Empty default in "${spec}": remove the = or give a value`);
  return {
    name,
    type,
    array: Boolean(arr1 || arr2 || flags.has('array')),
    arg: type === 'ref' ? kebab(arg ?? name) : arg,
    required: Boolean(bang || flags.has('required')),
    default: def,
    modifiers: [...new Set(modifiers)],
  };
}

export function fieldCode(field) {
  let base;
  if (field.type === 'enum') base = `f.enum([${field.arg.split(',').map((v) => quote(v.trim())).join(', ')}])`;
  else if (field.type === 'ref') base = `f.ref('${field.arg}')`;
  else base = `f.${field.type}()`;

  const chain = [];
  if (field.array) base = `f.array(${base})`;
  if (field.required) chain.push('required()');
  if (field.default !== undefined) chain.push(`default(${literal(field)})`);
  else if (field.array) chain.push('default([])');

  // Only the modifiers in the spec: a field is never made sortable or filterable unasked.
  const mods = new Set(field.modifiers);
  for (const mod of ['unique', 'index', 'searchable', 'sortable', 'filterable', 'hidden', 'writeOnly', 'readOnly', 'immutable', 'populate', 'owner']) {
    if (mods.has(mod)) chain.push(`${mod}()`);
  }
  return [base, ...chain].join('.');
}

function literal(field) {
  const v = field.default;
  switch (field.type) {
    case 'number': case 'integer':
      if (!Number.isFinite(Number(v))) throw new Error(`Default for ${field.name} must be a number`);
      return String(Number(v));
    case 'boolean':
      if (v !== 'true' && v !== 'false') throw new Error(`Default for ${field.name} must be true or false`);
      return v;
    case 'enum':
      if (!field.arg.split(',').map((s) => s.trim()).includes(v)) throw new Error(`Default "${v}" is not one of ${field.arg}`);
      return quote(v);
    case 'date':
      if (v === 'now') return '() => new Date()';
      if (Number.isNaN(Date.parse(v))) throw new Error(`Default for ${field.name} must be a date (2026-01-31) or now`);
      return quote(v);
    default:
      return quote(v);
  }
}

/** A single-quoted JavaScript string literal, safe for any input. */
const quote = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
