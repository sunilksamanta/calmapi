// Parse `calm make resource` field specs into f.*() code.
//
//   title:string!                 required string
//   price:number=0                number with default
//   status:enum:draft,live=draft  enum with default
//   category:ref:category         reference (ref alone uses the field name: category:ref)
//   tags:string[]                 array of strings
//   title:string!+searchable+sortable    extra modifiers

import { kebab } from './strings.js';

const TYPES = {
  string: 'string', str: 'string', text: 'text', email: 'email', url: 'url', password: 'password',
  number: 'number', num: 'number', float: 'number', integer: 'integer', int: 'integer',
  boolean: 'boolean', bool: 'boolean', date: 'date', datetime: 'date', enum: 'enum',
  ref: 'ref', id: 'id', json: 'json', object: 'json',
};
const MODIFIERS = new Set(['searchable', 'sortable', 'filterable', 'unique', 'index', 'hidden', 'writeOnly', 'readOnly', 'immutable', 'populate', 'owner']);

export function parseFieldSpec(spec) {
  const [main, ...mods] = spec.split('+');
  const m = /^([A-Za-z_][\w]*):([A-Za-z]+)(\[\])?(?::([^=!]+?))?(\[\])?(!)?(?:=(.*))?$/.exec(main);
  if (!m) throw new Error(`Cannot parse field "${spec}". Expected name:type, e.g. title:string! or tags:string[]`);
  const [, name, rawType, arr1, arg, arr2, bang, def] = m;
  const type = TYPES[rawType.toLowerCase()];
  if (!type) throw new Error(`Unknown type "${rawType}" in "${spec}". Types: ${[...new Set(Object.values(TYPES))].join(', ')}`);
  for (const mod of mods) if (!MODIFIERS.has(mod)) throw new Error(`Unknown modifier "+${mod}" in "${spec}". Modifiers: ${[...MODIFIERS].join(', ')}`);
  if (type === 'enum' && !arg) throw new Error(`enum needs values: ${name}:enum:a,b,c`);
  return {
    name,
    type,
    array: Boolean(arr1 || arr2),
    arg: type === 'ref' ? kebab(arg ?? name) : arg,
    required: Boolean(bang),
    default: def,
    modifiers: mods,
  };
}

export function fieldCode(field) {
  let base;
  if (field.type === 'enum') base = `f.enum([${field.arg.split(',').map((v) => `'${v.trim()}'`).join(', ')}])`;
  else if (field.type === 'ref') base = `f.ref('${field.arg}')`;
  else base = `f.${field.type}()`;

  const chain = [];
  if (field.array) base = `f.array(${base})`;
  if (field.required) chain.push('required()');
  if (field.default !== undefined) chain.push(`default(${literal(field)})`);
  else if (field.array) chain.push('default([])');

  // Sensible query defaults: small value sets are filterable, numbers and dates sortable.
  const mods = new Set(field.modifiers);
  if (['enum', 'boolean', 'ref'].includes(field.type) && !field.array) mods.add('filterable');
  if (['number', 'integer', 'date'].includes(field.type) && !field.array) {
    mods.add('filterable');
    mods.add('sortable');
  }
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
      return `'${v}'`;
    case 'date':
      return v === 'now' ? '() => new Date()' : `'${v}'`;
    default:
      return `'${v.replace(/'/g, "\\'")}'`;
  }
}
