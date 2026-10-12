// What an API key may call. Scopes only narrow what the key's user can do: route policies
// still run after the scope check, so a key never does more than its owner.
//
//   *               everything the user can do (except /auth/*, see index.js)
//   read            every GET request, except routes that ask for their own scope
//   posts:read      GET requests to /api/posts...
//   posts:write     POST, PUT, PATCH and DELETE requests to /api/posts... (no reading)
//   posts:*         both, plus any custom posts:<name> scope
//   reports:export  a custom scope a route asks for (options.routeScopes)
//
// The name before the colon is the first segment of the URL after /api, so it matches
// what people see in requests: /api/posts/123/publish needs posts:write.

export const isReadRoute = (route) => route.method === 'GET' || route.method === 'HEAD';

/** A custom scope must look like area:action, e.g. reports:export. */
export const CUSTOM_SCOPE = /^[a-z0-9][\w.-]*:[\w.-]+$/i;

/** 'POST /api/reports/export' and 'POST /reports/export' both mean the same route. */
export function routeKey(method, path, apiPrefix) {
  const bare = apiPrefix && path.startsWith(`${apiPrefix}/`) ? path.slice(apiPrefix.length) : path;
  return `${method.toUpperCase()} ${bare}`;
}

/** The URL area a route belongs to: /posts/:id -> 'posts'. */
export function areaOf(route, registry) {
  const path = (route.resource && registry?.get(route.resource)?.def.path) || route.path;
  const first = path.split('/').find(Boolean);
  return first && !first.startsWith(':') ? first : 'app';
}

/** The scope a route asks for when it did not name one. */
export const impliedScope = (route, registry) => `${areaOf(route, registry)}:${isReadRoute(route) ? 'read' : 'write'}`;

/**
 * @param {object} route
 * @param {{ registry: Map, custom: Map<string, string> }} ctx custom maps routeKey -> scope
 * @returns {{ scope: string, custom: boolean }}
 */
export function requiredScope(route, { registry, custom }) {
  const own = route.scope ?? custom.get(`${route.method} ${route.path}`);
  return own ? { scope: own, custom: true } : { scope: impliedScope(route, registry), custom: false };
}

/** Does any of the key's scopes cover this route? */
export function grants(scopes, route, need) {
  return scopes.some(
    (s) =>
      s === '*' ||
      s === need.scope ||
      (s === 'read' && !need.custom && isReadRoute(route)) ||
      (s.endsWith(':*') && need.scope.startsWith(s.slice(0, -1))),
  );
}

/**
 * Every scope that means something in this app, with a description, for validation at key
 * creation and for GET /api/auth/api-keys/scopes.
 *
 * @param {Array} routes app.routes
 * @param {{ registry: Map, custom: Map<string, string>, apiPrefix: string, skip: (route) => boolean }} ctx
 */
export function catalog(routes, ctx) {
  const areas = new Map();
  const own = new Map();
  for (const route of routes) {
    if (ctx.skip(route)) continue;
    const need = requiredScope(route, ctx);
    const area = need.custom ? need.scope.split(':')[0] : areaOf(route, ctx.registry);
    const a = areas.get(area) ?? { read: false, write: false };
    areas.set(area, a);
    if (need.custom) {
      if (!own.has(need.scope)) own.set(need.scope, []);
      own.get(need.scope).push(`${route.method} ${ctx.apiPrefix}${route.path}`);
    } else if (isReadRoute(route)) a.read = true;
    else a.write = true;
  }

  const out = [
    { scope: '*', description: 'Everything your account can do, except managing API keys, passwords and sessions' },
    { scope: 'read', description: 'Every GET request (routes with their own scope excepted)' },
  ];
  for (const [area, a] of [...areas].sort(([x], [y]) => x.localeCompare(y))) {
    const url = `${ctx.apiPrefix}/${area}`;
    if (a.read) out.push({ scope: `${area}:read`, description: `GET requests to ${url}` });
    if (a.write) out.push({ scope: `${area}:write`, description: `POST, PUT, PATCH and DELETE requests to ${url}` });
    out.push({ scope: `${area}:*`, description: `Every ${area} scope` });
  }
  for (const [scope, list] of [...own].sort(([x], [y]) => x.localeCompare(y))) out.push({ scope, description: list.join(', ') });
  return out;
}
