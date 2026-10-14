// requireFlag(key): put a route (or a resource action) behind a feature flag.
//
//   import { requireFlag } from '#app/blocks/feature-flags/index.js';
//
//   r.post('/checkout/v2', { policy: [requireFlag('new-checkout'), 'authenticated'] }, handler);
//   r.get('/labs', { policy: requireFlag('labs') }, handler);          // anyone the flag is on for
//
// Policy lists mean "any of" in CalmAPI, so a plain policy function could only widen
// access. A gate is different: the feature-flags guard finds gates in the route's policy
// before the policy runs and answers 404 when the flag is off for the caller (the route
// does not exist for them). Inside the policy a gate never grants access on its own; the
// rest of the list decides, unchanged ('owner' still scopes to owned records). A policy
// made only of gates allows whoever the flags are on for.
//
// Gates are for route and resource action policies. In field rules (visibleTo,
// writableBy) and tooling that runs without a request, a gate is simply false.

export const GATE = Symbol.for('calm.feature-flags.gate');

export function requireFlag(key) {
  if (typeof key !== 'string' || !key) throw new Error('requireFlag(key): key must be a non-empty string');
  const gate = async ({ req } = {}) => {
    const policy = req?.calmRoute?.policy;
    if (!policy?.includes(gate)) return false;
    if (!policy.every((token) => typeof token === 'function' && token[GATE] !== undefined)) return false;
    return Boolean(req.calmFlags?.enabled(key));
  };
  Object.defineProperty(gate, 'name', { value: `flag:${key}` }); // shown in `calm routes` and devtools
  gate[GATE] = key;
  return gate;
}
