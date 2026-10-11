// Checks that run against the booted app (config, resources, routes). `calm doctor`
// adds static checks on your source files on top of these, and devtools shows them live.

const SECRET_NAME = /^(password|passcode|otp|token|secret|api[-_]?key|private[-_]?key|refresh[-_]?token)$/i;

export function runtimeChecks(app) {
  const findings = [];
  const add = (level, id, title, detail, file) => findings.push({ level, id, title, detail, file });
  const { config, registry, routes } = app;
  const prod = config.mode === 'production';

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) add('error', 'node-version', `Node ${process.versions.node} is too old`, 'CalmAPI 2 needs Node 22.12 or newer (24 LTS recommended).');

  if (config.cors.origins === '*' && prod) add('warn', 'cors-wildcard', 'CORS allows every origin in production', 'Set CORS_ORIGINS to the domains of your frontends.');
  if (!config.rateLimit.enabled && config.mode !== 'test') add('warn', 'rate-limit-off', 'Rate limiting is disabled', 'Auth endpoints can be brute forced. Re-enable config.rateLimit.');
  if (prod && config.trustProxy === false) add('info', 'trust-proxy', 'TRUST_PROXY is not set', 'Behind a load balancer every client shares one IP for rate limiting. Set TRUST_PROXY (e.g. 1).');
  if (app.auth && prod && !app.mailer.transport) add('warn', 'no-mail', 'No mail transport in production', 'Password reset emails cannot be delivered. Run `calm add @calmapi/mail-resend` or register a transport.');

  for (const { def, files } of registry.values()) {
    const file = files?.resource;
    if (def.defaultedPolicies.length) {
      add('warn', 'policy-defaulted', `${def.name}: no explicit policy for ${def.defaultedPolicies.join(', ')}`,
        'Defaults applied (reads: authenticated, writes: owner | admin or admin). Write them out so the intent is visible.', file);
    }
    for (const action of ['create', 'update', 'delete']) {
      if (def.policy[action]?.includes('public')) add('warn', 'public-write', `${def.name}: anyone can ${action}`, `policy.${action} is 'public'. Is that intended?`, file);
    }
    for (const [key, field] of Object.entries(def.fields)) {
      if (SECRET_NAME.test(key) && field.isOutput) {
        add('error', 'secret-exposed', `${def.name}.${key} looks secret but is returned by the API`, 'Use f.password(), .writeOnly() or .hidden().', file);
      }
      const ref = field.type === 'ref' ? field.opts.ref : field.type === 'array' && field.opts.of.type === 'ref' ? field.opts.of.opts.ref : null;
      if (ref && !registry.has(ref)) add('error', 'unknown-ref', `${def.name}.${key} references unknown resource "${ref}"`, 'Create it with `calm make resource` or fix the name.', file);
    }
    if (def.name === 'user') {
      if (def.fields.email && !def.fields.email.opts.unique) add('error', 'user-email-unique', 'user.email is not unique', 'Add .unique() so two accounts cannot share an email.', file);
      const roles = def.fields.roles;
      if (roles && roles.isInput && !roles.opts.writableBy) {
        add('error', 'roles-writable', 'Users can set their own roles', "Mark roles .writableBy('admin') or .readOnly() to prevent privilege escalation.", file);
      }
    }
  }

  for (const route of routes) {
    if (route.source === 'crud' || route.source === 'auth') continue;
    if (!route.policyExplicit) {
      add('warn', 'route-policy', `${route.method} ${config.apiPrefix}${route.path} has no explicit policy`, "Defaulted to 'authenticated'. Add { policy: '...' } to say who may call it.", route.file);
    }
  }

  for (const fn of app.hooks.doctor) {
    try {
      for (const f of fn(app) ?? []) findings.push(f);
    } catch (err) {
      add('warn', 'doctor-hook', 'A block doctor check crashed', err.message);
    }
  }
  return findings;
}
