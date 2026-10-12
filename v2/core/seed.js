// Sample data that looks real, built from your field definitions: names that look like names,
// prices that look like prices, enums from their values, references to records that exist.
// Records are created through each resource's service (hooks run, owners are set) and are
// validated like API input, so what you get is what your API would accept. No dependencies.
//
//   await seed(app, { resource: 'post', count: 20 })     -> { created: { post: 20, user: 3 }, users: [...] }

import { validateInput } from './resource/resource.js';

const FIRST = ['Ada', 'Grace', 'Alan', 'Linus', 'Margaret', 'Katherine', 'Dennis', 'Barbara', 'Ken', 'Radia', 'Tim', 'Hedy', 'Edsger', 'Frances', 'John', 'Sophie', 'Yukihiro', 'Anita', 'Guido', 'Mary', 'Donald', 'Shafi', 'Bjarne', 'Lynn'];
const LAST = ['Lovelace', 'Hopper', 'Turing', 'Torvalds', 'Hamilton', 'Johnson', 'Ritchie', 'Liskov', 'Thompson', 'Perlman', 'Berners-Lee', 'Lamarr', 'Dijkstra', 'Allen', 'McCarthy', 'Wilson', 'Matsumoto', 'Borg', 'van Rossum', 'Shaw', 'Knuth', 'Goldwasser', 'Stroustrup', 'Conway'];
const ADJ = ['quiet', 'bright', 'gentle', 'swift', 'golden', 'hidden', 'curious', 'steady', 'little', 'wild', 'clever', 'early', 'silver', 'calm', 'bold', 'simple'];
const NOUN = ['river', 'garden', 'harbor', 'meadow', 'lantern', 'compass', 'orchard', 'bridge', 'canyon', 'atlas', 'beacon', 'notebook', 'kettle', 'workshop', 'market', 'library'];
const VERB = ['builds', 'finds', 'keeps', 'shares', 'tracks', 'plans', 'opens', 'brings', 'shows', 'makes'];
const CITY = ['Lisbon', 'Kyoto', 'Toronto', 'Nairobi', 'Oslo', 'Melbourne', 'Bogota', 'Seoul', 'Berlin', 'Austin', 'Pune', 'Valencia'];
const COMPANY = ['Northwind', 'Acme', 'Globex', 'Initech', 'Umbrella Labs', 'Stark Works', 'Hooli', 'Wayne Logistics', 'Soylent', 'Vandelay'];
const DOMAIN = ['example.com', 'example.org', 'example.net'];

/** Small seeded PRNG (mulberry32), so `seed: 42` gives the same data every time. */
function rng(seedValue = Date.now()) {
  let a = seedValue >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const pick = (list) => list[int(0, list.length - 1)];
  return { next, int, pick, chance: (p) => next() < p };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function sentence(r, words = r.int(6, 12)) {
  const out = [];
  for (let i = 0; i < words; i++) out.push(i % 3 === 0 ? r.pick(ADJ) : i % 3 === 1 ? r.pick(NOUN) : r.pick(VERB));
  return `${cap(out.join(' '))}.`;
}
const paragraph = (r) => Array.from({ length: r.int(2, 4) }, () => sentence(r)).join(' ');
const title = (r) => `${cap(r.pick(ADJ))} ${r.pick(NOUN)}${r.chance(0.4) ? ` in ${r.pick(CITY)}` : ''}`;

/** A plausible value for one field, by type first and then by what its name suggests. */
function valueFor(name, field, r, n, person) {
  const o = field.opts;
  const key = name.toLowerCase();
  const fit = (s) => (typeof s === 'string' && o.max ? s.slice(0, o.max) : s);
  switch (field.type) {
    case 'enum':
      return r.pick(o.values);
    case 'boolean':
      return r.chance(0.5);
    case 'email':
      return `${slugify(person.first)}.${slugify(person.last)}${n}@${r.pick(DOMAIN)}`;
    case 'url':
      return /avatar|image|photo|picture|logo/.test(key) ? `https://picsum.photos/seed/${r.int(1, 9999)}/400/400` : `https://${r.pick(DOMAIN)}/${slugify(r.pick(NOUN))}/${n}`;
    case 'password':
      return 'calm-demo-password-1';
    case 'date': {
      const day = 86_400_000;
      const future = /due|expire|end|until|deadline|start|scheduled|next/.test(key);
      return new Date(Date.now() + (future ? 1 : -1) * r.int(1, 90) * day + r.int(0, day)).toISOString();
    }
    case 'number':
    case 'integer': {
      let [min, max] = [o.min ?? 0, o.max ?? 1000];
      if (/price|amount|cost|total|fee/.test(key)) [min, max] = [Math.max(min, 5), Math.min(max, 500)];
      else if (/rating|stars|score/.test(key)) [min, max] = [Math.max(min, 1), Math.min(max, 5)];
      else if (/age/.test(key)) [min, max] = [Math.max(min, 18), Math.min(max, 80)];
      else if (/qty|quantity|count|stock|seats/.test(key)) [min, max] = [Math.max(min, 0), Math.min(max, 100)];
      else if (/^lat/.test(key)) [min, max] = [-60, 70];
      else if (/^(lng|lon)/.test(key)) [min, max] = [-170, 170];
      if (field.type === 'integer' || /qty|quantity|count|stock|seats|age|rating|stars/.test(key)) return r.int(Math.ceil(min), Math.floor(max));
      return Math.round((min + r.next() * (max - min)) * 100) / 100;
    }
    case 'json':
      return { note: sentence(r, 4), level: r.int(1, 3) };
    case 'id':
      return null;
    case 'array': {
      if (!o.of || o.of.type === 'ref') return [];
      const len = Math.min(r.int(1, 3), o.max ?? 3);
      const items = new Set();
      for (let i = 0; i < len; i++) items.add(valueFor(key.replace(/s$/, ''), o.of, r, n, person));
      return [...items].filter((x) => x !== null);
    }
    case 'object': {
      const out = {};
      for (const [k, f] of Object.entries(o.shape ?? {})) out[k] = valueFor(k, f, r, n, person);
      return out;
    }
    default: {
      // string and text
      let s;
      if (/^(full)?name$|^display_?name|author_?name/.test(key)) s = `${person.first} ${person.last}`;
      else if (/first_?name/.test(key)) s = person.first;
      else if (/last_?name|surname/.test(key)) s = person.last;
      else if (/user_?name|handle|login/.test(key)) s = `${slugify(person.first)}${n}`;
      else if (/phone|mobile/.test(key)) s = `+1 555 ${String(r.int(100, 999))} ${String(r.int(1000, 9999))}`;
      else if (/city|town/.test(key)) s = r.pick(CITY);
      else if (/company|organi[sz]ation|brand/.test(key)) s = r.pick(COMPANY);
      else if (/color|colour/.test(key)) s = `#${r.int(0, 0xffffff).toString(16).padStart(6, '0')}`;
      else if (/sku|code|ref(erence)?$/.test(key)) s = `${r.pick(NOUN).slice(0, 3).toUpperCase()}-${r.int(1000, 9999)}`;
      else if (/slug/.test(key)) s = `${slugify(title(r))}-${n}`;
      else if (/tag|label|category/.test(key)) s = r.pick(NOUN);
      else if (/title|subject|headline|^name/.test(key)) s = title(r);
      else if (field.type === 'text' || /body|content|description|bio|summary|comment|message|note|text/.test(key)) s = paragraph(r);
      else s = `${cap(r.pick(ADJ))} ${r.pick(NOUN)}`;
      if (o.lowercase) s = s.toLowerCase();
      if (o.unique) s = `${s} ${n}`;
      if (o.min && s.length < o.min) s = s.padEnd(o.min, '.');
      return fit(s);
    }
  }
}

/** Resources in an order where referenced ones come first. */
function order(app, names) {
  const out = [];
  const visit = (name, path = []) => {
    if (out.includes(name) || path.includes(name)) return;
    const entry = app.registry.get(name);
    if (!entry) return;
    for (const field of Object.values(entry.def.fields)) {
      const target = field.type === 'ref' ? field.opts.ref : field.type === 'array' && field.opts.of?.type === 'ref' ? field.opts.of.opts.ref : null;
      if (target && target !== name && !field.opts.owner) visit(target, [...path, name]);
    }
    out.push(name);
  };
  for (const n of names) visit(n);
  return out;
}

/**
 * Create sample records. Options: { resource | resources, count = 10, users = 3, seed }.
 * Demo users (demo.ada.<stamp>@example.test, password calm-demo-password-1) are created when
 * none exist, and own the records. With a seed the values repeat; unique values such as
 * emails get a per-run suffix so a second run does not collide.
 */
export async function seed(app, { resource, resources, count = 10, users = 3, seed: seedValue } = {}) {
  const r = rng(seedValue ?? Date.now());
  const created = {};
  const credentials = [];
  const names = resources ?? (resource ? [resource] : [...app.registry.keys()].filter((n) => n !== 'user'));
  for (const name of names) if (!app.registry.has(name)) throw new Error(`Unknown resource "${name}". Known: ${[...app.registry.keys()].join(', ')}`);

  // People to own things: existing users first, demo users when there are none.
  let people = [];
  if (app.registry.has('user')) {
    const User = app.registry.get('user');
    people = await User.model.find({ status: { $ne: 'disabled' } }).sort({ _id: 1 }).limit(20).lean();
    const wantUsers = names.includes('user') ? count : people.length ? 0 : users;
    for (let i = 0; i < wantUsers; i++) {
      const first = r.pick(FIRST);
      const last = r.pick(LAST);
      const stamp = `${Date.now().toString(36)}${i}`;
      const email = `demo.${slugify(first)}.${stamp}@example.test`;
      const data = { name: `${first} ${last}`, email, password: 'calm-demo-password-1' };
      for (const [key, field] of Object.entries(User.def.fields)) {
        if (key in data || !field.isInput || !field.opts.required || field.opts.default !== undefined) continue;
        data[key] = valueFor(key, field, r, i, { first, last });
      }
      const input = await validateInput(User.def, data, { mode: 'create', user: null, unknownFields: 'ignore' });
      const doc = await User.service.create(input, { system: true });
      people.push(doc);
      credentials.push({ email, password: 'calm-demo-password-1' });
      created.user = (created.user ?? 0) + 1;
    }
  }
  const asUser = (doc) => (doc ? { ...doc, id: String(doc._id) } : null);

  for (const name of order(app, names.filter((n) => n !== 'user'))) {
    const entry = app.registry.get(name);
    const { def, service, model } = entry;
    const wanted = names.includes(name) ? count : (await model.estimatedDocumentCount()) ? 0 : Math.min(count, 5); // referenced resources get a few
    for (let i = 0; i < wanted; i++) {
      const owner = people.length ? r.pick(people) : null;
      const person = { first: r.pick(FIRST), last: r.pick(LAST) };
      const data = {};
      for (const [key, field] of Object.entries(def.fields)) {
        if (!field.isInput || field.type === 'id' || field.opts.writableBy) continue;
        if (field.opts.default !== undefined && !field.opts.required && r.chance(0.5)) continue;
        if (!field.opts.required && r.chance(0.25)) continue;
        if (field.type === 'ref' || (field.type === 'array' && field.opts.of?.type === 'ref')) {
          const target = field.opts.ref ?? field.opts.of.opts.ref;
          const pool = target === 'user' ? people : await app.registry.get(target)?.model.find().select('_id').limit(50).lean();
          if (!pool?.length) continue;
          data[key] = field.type === 'array' ? [String(r.pick(pool)._id)] : String(r.pick(pool)._id);
          continue;
        }
        const v = valueFor(key, field, r, `${Date.now().toString(36).slice(-4)}${i}`, person);
        if (v !== null && v !== undefined) data[key] = v;
      }
      const input = await validateInput(def, data, { mode: 'create', user: asUser(owner), unknownFields: 'ignore' });
      await service.create(input, { user: asUser(owner), system: true });
      created[name] = (created[name] ?? 0) + 1;
    }
  }
  app.log.info(`Seeded ${Object.entries(created).map(([n, c]) => `${c} ${n}`).join(', ') || 'nothing'}`);
  return { created, users: credentials };
}
