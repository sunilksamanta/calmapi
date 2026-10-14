import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFieldSpec, fieldCode } from '../../src/cli/lib/field-spec.js';

const code = (spec) => fieldCode(parseFieldSpec(spec));

test('shell-safe forms: +required and +array (no ! or [] needed in zsh)', () => {
  assert.equal(code('name:string+required+searchable'), 'f.string().required().searchable()');
  assert.equal(code('tags:string+array'), 'f.array(f.string()).default([])');
  assert.equal(code('n:int+req'), 'f.integer().required().sortable().filterable()');
  assert.equal(code('ids:ref:user+list'), "f.array(f.ref('user')).default([])");
});

test('the short forms still work when quoted', () => {
  assert.equal(code('title:string!'), 'f.string().required()');
  assert.equal(code('title:string!+searchable'), 'f.string().required().searchable()');
  assert.equal(code('tags:string[]'), 'f.array(f.string()).default([])');
});

test('defaults, enums and modifiers in any order', () => {
  assert.equal(code('status:enum:draft,live=draft'), "f.enum(['draft', 'live']).default('draft').filterable()");
  assert.equal(code('status:enum:a,b+required=a'), "f.enum(['a', 'b']).required().default('a').filterable()");
  assert.equal(code('price:number=0+sortable'), 'f.number().default(0).sortable().filterable()');
  assert.equal(code('phone:string=+44'), "f.string().default('+44')", 'a + inside a default is part of it');
  assert.equal(code('d:date=now'), 'f.date().default(() => new Date()).sortable().filterable()');
});

test('generated code is always a valid literal', () => {
  assert.equal(code("note:string=it's"), "f.string().default('it\\'s')");
  assert.equal(code('p:string=a\\b'), "f.string().default('a\\\\b')");
  assert.equal(code("s:enum:a',b=b"), "f.enum(['a\\'', 'b']).default('b').filterable()");
});

test('clear errors for bad specs', () => {
  const err = (spec, re) => assert.throws(() => code(spec), re, spec);
  err('', /Empty field spec/);
  err('x', /Cannot parse field "x".*title:string\+required/);
  err('x:wat', /Unknown type "wat"/);
  err('x:string+constructor', /Unknown modifier "\+constructor"/);
  err('x:string++required', /Empty modifier/);
  err('x:enum', /enum needs values/);
  err('x:enum:a,,b', /empty value/);
  err('x:number=abc', /must be a number/);
  err('x:bool=yes', /true or false/);
  err('x:date=nope', /must be a date/);
  err('x:string=', /Empty default/);
  err('s:enum:a,b=c', /not one of/);
});
