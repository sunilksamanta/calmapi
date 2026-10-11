// String helpers used across the framework. Small on purpose: read them, change them.

const UNCOUNTABLE = new Set([
  'auth', 'analytics', 'audio', 'data', 'deer', 'equipment', 'feedback', 'fish',
  'information', 'info', 'media', 'metadata', 'money', 'news', 'police', 'rice',
  'series', 'settings', 'sheep', 'software', 'hardware', 'species', 'staff', 'traffic',
]);

const IRREGULAR = {
  child: 'children', foot: 'feet', goose: 'geese', man: 'men', mouse: 'mice',
  ox: 'oxen', person: 'people', quiz: 'quizzes', tooth: 'teeth', woman: 'women',
};

const VES = new Set(['half', 'knife', 'leaf', 'life', 'loaf', 'self', 'shelf', 'thief', 'wife', 'wolf']);
const OES = new Set(['echo', 'hero', 'potato', 'tomato', 'veto']);

/** Pluralize one English word. Words ending in a digit (v1, v2) are left alone. */
export function pluralizeWord(word) {
  const lower = word.toLowerCase();
  if (!lower || /\d$/.test(lower) || UNCOUNTABLE.has(lower)) return word;
  if (IRREGULAR[lower]) return matchCase(word, IRREGULAR[lower]);
  if (VES.has(lower)) return word.replace(/(fe|f)$/i, 'ves');
  if (OES.has(lower)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, 'ies');
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

/** Pluralize the last segment of a kebab-case name: "product-category" -> "product-categories". */
export function pluralize(name) {
  const parts = name.split('-');
  parts[parts.length - 1] = pluralizeWord(parts[parts.length - 1]);
  return parts.join('-');
}

function matchCase(source, target) {
  return source[0] === source[0].toUpperCase() ? target[0].toUpperCase() + target.slice(1) : target;
}

/** Split any casing ("productMeta", "Product Meta", "product_meta") into lowercase words. */
export function words(input) {
  return String(input)
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z\d]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export const kebab = (input) => words(input).join('-');
export const camel = (input) => words(input).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join('');
export const pascal = (input) => words(input).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
export const humanize = (input) => {
  const out = words(input).join(' ');
  return out ? out[0].toUpperCase() + out.slice(1) : out;
};

/** Escape user input so it can be embedded in a RegExp as a literal. */
export const escapeRegex = (input) => String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
