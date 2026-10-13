import { definePlugin, f, Field, validateInput, forbidden, validationError } from '#calm';
import { createRoles, OWNER } from './roles.js';
import { createTeams, isId } from './teams.js';

// Teams (organizations, workspaces): members with roles, email invitations, and team-scoped
// resources, the multi-tenancy almost every SaaS needs.
//
//   resource('project', { team: true, fields, policy: { list: 'member', read: 'member', create: 'member', update: 'team:admin', delete: 'team:admin' } })
//
// A team-scoped resource gets a `team` field (f.ref('team'), immutable) and these guarantees,
// whatever its policies say:
//  - Every query is scoped to the teams the caller belongs to (the service scope()), so records of
//    other teams are invisible: lists skip them and ids answer 404, guessed or not. Global admins
//    are no exception: tenants stay apart (use { system: true } in your own admin tooling).
//  - Creating needs membership in the target team (body `team`, else the X-Team header).
//  - Records never move to another team (immutable field, also enforced for service calls).
//
// Policies, usable in resources and routes ('member | admin', visibleTo('team:admin')...):
//   'member'        anyone in the team          'team:<role>'  that role or above
// The team is the record's team, else :teamId in the path, else (create) body.team, else the
// X-Team header, else (list) ?team=. With a record in hand, only the record's team counts.

const TEAM_FIELD = 'team';

export default definePlugin({
  name: 'teams',
  options: {
    /** Roles from most to least powerful. Must start with 'owner', 'admin'; add your own after them. */
    roles: ['owner', 'admin', 'member'],
    /** Role of an invitation that does not say. */
    defaultRole: 'member',
    /** Who may create teams (any policy, e.g. 'admin'). */
    createPolicy: 'authenticated',
    /** Lowest team role that may invite (and list, resend, revoke invitations). 'member': everyone in the team. */
    inviteRole: 'admin',
    invitationTtlDays: 7,
    /** Open (pending or expired) invitations one team may have. 0: no limit. */
    maxOpenInvitations: 100,
    /** Minimum time between two sends of the same invitation. */
    resendCooldownSeconds: 60,
    /** Page of your frontend that reads ?token= and calls /accept. Default: APP_URL + '/invite'. */
    linkUrl: null,
    /**
     * A field of your user resource that is truthy once the account's email is verified (e.g.
     * 'emailVerifiedAt'). When set, verified users see their invitations and accept them without
     * the link. Leave null unless you verify emails: CalmAPI does not, by default.
     */
    verifiedEmailField: null,
    /** Members see each other's email addresses in GET /teams/:teamId/members. */
    showMemberEmails: true,
    /** Teams one person may own. 0: no limit. */
    maxOwnedTeams: 20,
    /** Deleting a team deletes its records in team-scoped resources. */
    deleteRecords: true,
    /** Header naming the active team. */
    header: 'x-team',
  },
  setup(calm, options) {
    const roles = createRoles(options.roles);
    if (!roles.has(options.defaultRole)) throw new Error(`teams: defaultRole "${options.defaultRole}" is not one of ${roles.list.join(', ')}`);
    if (!roles.has(options.inviteRole)) throw new Error(`teams: inviteRole "${options.inviteRole}" is not one of ${roles.list.join(', ')}`);
    const header = String(options.header).toLowerCase();
    const teams = createTeams(calm, options, roles);
    const { memberships, known } = teams;
    const scoped = new Set(); // names of team-scoped resources

    // ---- team-scoped resources ----------------------------------------------------------

    calm.onResource((def) => {
      if (!def.options.team) return def;
      if (def.options.team !== true) throw new Error(`${def.name}: use team: true (the field is always "${TEAM_FIELD}")`);
      if (def.name === 'team') throw new Error('The team resource cannot be team-scoped');
      const declared = def.fields[TEAM_FIELD];
      if (declared && (declared.type !== 'ref' || declared.opts.ref !== 'team')) throw new Error(`${def.name}: "${TEAM_FIELD}" must be f.ref('team') on a team-scoped resource`);
      if (def.ownerField === TEAM_FIELD) throw new Error(`${def.name}: "${TEAM_FIELD}" cannot be the owner field`);
      const base = declared ?? f.ref('team');
      // Not required for validation (the X-Team header may supply it; the block requires it on
      // create), always writable on create, never afterwards, so records cannot change teams.
      def.fields[TEAM_FIELD] = new Field('ref', { ...base.opts, required: false, readOnly: false, hidden: false, writeOnly: false, writableBy: undefined, immutable: true, index: true, filterable: base.opts.filterable ?? ['eq', 'in'] });
      if (def.timestamps) def.indexes = [...def.indexes, { fields: { [TEAM_FIELD]: 1, createdAt: -1 } }];
      scoped.add(def.name);
      return def;
    });

    // The rule functions behind the policy names, with the lowest role each accepts (null: any).
    const ruleRole = new Map();

    /** Lowest role the list policy accepts, when it is made of team rules only; else null (membership). */
    const listRole = (def) => {
      const tokens = def.policy.list ?? [];
      if (!tokens.length || !tokens.every((t) => ruleRole.has(t))) return null;
      const mins = tokens.map((t) => ruleRole.get(t));
      if (mins.includes(null)) return null;
      return mins.reduce((low, r) => (roles.rank(r) > roles.rank(low) ? r : low));
    };

    calm.onService(({ def, service }) => {
      if (def.name === 'team') return teamHooks(service);
      if (!scoped.has(def.name)) return;
      const join = (a, b) => (a && Object.keys(a).length ? { $and: [a, b] } : b);

      // Tenant isolation: AND-ed with the resource's own scope(), for every query of the service.
      const ownScope = service.scope.bind(service);
      service.scope = (ctx = {}) => {
        const own = ownScope(ctx);
        const team = teamScope(ctx);
        if (typeof own?.then === 'function' || typeof team?.then === 'function') return Promise.all([own, team]).then(([a, b]) => join(a, b));
        return join(own, team);
      };

      // A list policy such as 'team:admin' lists only the teams where the caller has that role,
      // so a list never shows records the same caller could not open.
      const list = service.list.bind(service);
      service.list = async (query = {}, ctx = {}) => {
        const min = ctx.system || !ctx.user ? null : listRole(def);
        if (!min) return list(query, ctx);
        const allowed = [...(await memberships(ctx.user))].filter(([, role]) => roles.atLeast(role, min)).map(([id]) => id);
        const filter = query.filter && Object.keys(query.filter).length ? { $and: [query.filter, { [TEAM_FIELD]: { $in: allowed } }] } : { [TEAM_FIELD]: { $in: allowed } };
        return list({ ...query, filter }, ctx);
      };

      const beforeCreate = service.beforeCreate.bind(service);
      service.beforeCreate = async (data, ctx = {}) => {
        let input = data;
        if (input[TEAM_FIELD] == null && ctx.team?.id) input = { ...input, [TEAM_FIELD]: ctx.team.id };
        input = await beforeCreate(input, ctx);
        const team = input[TEAM_FIELD] == null ? null : String(input[TEAM_FIELD]?._id ?? input[TEAM_FIELD]);
        if (!team) throw validationError({ [TEAM_FIELD]: `Pick a team: send "${TEAM_FIELD}" or an ${options.header} header` });
        // Whatever the create policy says, records go only to a team the caller belongs to.
        if (!ctx.system && !(ctx.user && (await memberships(ctx.user)).has(team))) throw forbidden('You are not a member of this team');
        return input;
      };

      const beforeUpdate = service.beforeUpdate.bind(service);
      service.beforeUpdate = async (data, existing, ctx = {}) => {
        const changes = await beforeUpdate(data, existing, ctx);
        // The API already refuses it (immutable field); this covers service calls from your code.
        if (!ctx.system && changes?.[TEAM_FIELD] !== undefined && String(changes[TEAM_FIELD]?._id ?? changes[TEAM_FIELD]) !== String(existing[TEAM_FIELD])) {
          throw validationError({ [TEAM_FIELD]: 'Records cannot move to another team' });
        }
        return changes;
      };
    });

    /**
     * The team filter for one caller. Synchronous when the request already loaded the caller's
     * memberships (the guard below does), otherwise a Promise: app.canRead() and inScope() await
     * it, and core refuses a pending scope where it needs a filter at once, so nothing leaks.
     */
    function teamScope(ctx) {
      if (!ctx.user) return { [TEAM_FIELD]: { $in: [] } }; // nobody outside a team sees team records
      const pick = (mine) => {
        if (ctx.team?.id) return { [TEAM_FIELD]: mine.has(ctx.team.id) ? ctx.team.id : { $in: [] } };
        return { [TEAM_FIELD]: { $in: [...mine.keys()] } };
      };
      const mine = known(ctx.user);
      return mine ? pick(mine) : memberships(ctx.user).then(pick);
    }

    // The team resource: a slug when none is given, and whoever creates a team owns it
    // (POST /api/teams, seeds, your scripts calling service.create(data, { user })).
    function teamHooks(service) {
      const beforeCreate = service.beforeCreate.bind(service);
      service.beforeCreate = async (data, ctx) => {
        const input = await beforeCreate(data, ctx);
        return input.slug ? input : { ...input, slug: await teams.freeSlug(input.name) };
      };
      const afterCreate = service.afterCreate.bind(service);
      service.afterCreate = async (doc, ctx = {}) => {
        await afterCreate(doc, ctx);
        if (!ctx.user?.id) return;
        await teams.Membership.create({ team: doc._id, user: ctx.user.id, role: OWNER });
        teams.forget();
        calm.events.emit('team.created', { team: { id: String(doc._id), name: doc.name, slug: doc.slug }, userId: String(ctx.user.id) });
      };
    }

    // ---- the active team, and memberships loaded once per request ----------------------------

    calm.guard(
      async (ctx) => {
        if (!ctx.user) return;
        const wanted = ctx.req.get(header);
        if (!wanted && !scoped.size) return; // nothing needs memberships up front
        const mine = await memberships(ctx.user);
        if (!wanted) return;
        // Same answer for teams that do not exist: no way to probe team ids.
        if (!isId(wanted) || !mine.has(wanted)) throw forbidden('You are not a member of this team');
        ctx.team = { id: wanted, role: mine.get(wanted) };
      },
      { order: -50 },
    );

    // ---- policies -------------------------------------------------------------------------

    /**
     * Which team a policy is about. undefined: none named; null: named but invalid (refused).
     */
    function targetTeam(ctx) {
      const { doc, req, action } = ctx;
      const asId = (v) => (v === undefined || v === null || v === '' ? undefined : isId(String(v?._id ?? v)) ? String(v?._id ?? v) : null);
      // With a record in hand only its own team counts: a header or body cannot redirect the check.
      if (doc) return req?.calmRoute?.resource === 'team' ? String(doc._id) : (asId(doc[TEAM_FIELD]) ?? null);
      if (req?.params?.teamId !== undefined) return asId(req.params.teamId) ?? null;
      if (action === 'create') {
        const body = ctx.body ?? req?.body;
        if (body && typeof body === 'object' && body[TEAM_FIELD] !== undefined) return typeof body[TEAM_FIELD] === 'string' ? (asId(body[TEAM_FIELD]) ?? null) : null;
      }
      const fromHeader = req?.get?.(header);
      if (fromHeader) return asId(fromHeader) ?? null;
      if (action === 'list' && req?.query?.[TEAM_FIELD] !== undefined) return typeof req.query[TEAM_FIELD] === 'string' ? (asId(req.query[TEAM_FIELD]) ?? null) : null;
      return undefined;
    }

    function rule(min) {
      const fn = async (ctx) => {
        if (!ctx.user) return false;
        const team = targetTeam(ctx);
        // No team named: lists are scoped to the caller's teams anyway, and create refuses (422) a
        // record without a team or (403) in a team the caller is not in. Anything else needs a team.
        if (team === undefined) return (ctx.action === 'list' || ctx.action === 'create') && scoped.has(ctx.req?.calmRoute?.resource);
        if (team === null) return false;
        const role = (await memberships(ctx.user)).get(team);
        return min ? roles.atLeast(role, min) : role !== undefined;
      };
      ruleRole.set(fn, min);
      return fn;
    }
    // A membership is data the exposure matrix cannot invent: signed-in personas show 'custom'.
    const simulate = ({ user }) => (user ? 'custom' : 'deny');
    calm.policy('member', rule(null), { simulate });
    for (const role of roles.list) calm.policy(`team:${role}`, rule(role), { simulate });

    // ---- accounts that go away ----------------------------------------------------------

    const gone = (userId) => userId && calm.app.background(() => teams.userGone(String(userId), { scoped: [...scoped] }));
    calm.on('user.deleted', ({ doc }) => gone(doc?._id));
    calm.on('privacy.account_deleted', ({ userId }) => gone(userId));

    // For seeds, scripts and your own routes:
    //   await app.ext.teams.addMember(teamId, userId, 'admin')
    //   (await app.ext.teams.memberships(user)).get(teamId)   // the user's role, or undefined
    calm.provide('teams', {
      roles: roles.list,
      scoped: () => [...scoped],
      Membership: teams.Membership,
      Invitation: teams.Invitation,
      memberships: teams.memberships,
      roleOf: teams.roleOf,
      create: (user, data) => teams.createTeam(user, data),
      addMember: (teamId, userId, role = options.defaultRole) => teams.addMember(teamId, userId, role),
      removeMember: (teamId, userId) => teams.removeMember(String(teamId), String(userId), null, { reason: 'script' }),
      delete: (teamId) => teams.deleteTeam(String(teamId), { scoped: [...scoped] }),
    });

    // ---- routes -------------------------------------------------------------------------------

    calm.routes(
      (r) => {
        if (!calm.app.auth) {
          calm.log.warn('teams: auth is off (or there is no user resource), so its routes are not registered');
          return;
        }
        const tags = ['teams'];
        const teamDef = () => calm.app.registry.get('team').def;
        const input = (def, body, mode) => validateInput(def, body, { mode, unknownFields: calm.config.unknownFields });
        const inviteRule = `team:${options.inviteRole}`;
        const roleField = () => f.enum(roles.list);
        const teamOf = (ctx) => teams.getTeam(ctx.params.teamId);
        const meta = (ctx) => ({ ip: ctx.req.ip });

        r.post('/', { policy: options.createPolicy, status: 201, summary: 'Create a team (you become its owner)', tags }, async (ctx) => {
          const data = await input(teamDef(), ctx.body, 'create');
          return ctx.reply(await teams.createTeam(ctx.user, data, ctx), { status: 201 });
        });
        r.get('/', { policy: 'authenticated', summary: 'Your teams, with your role in each', tags }, (ctx) => teams.listMine(ctx.user));

        // Static paths before /:teamId.
        r.post(
          '/invitations/accept',
          { policy: 'authenticated', rateLimit: 'auth', summary: 'Join a team with the token from an invitation email', input: { token: f.string().required().max(200) }, tags },
          (ctx) => teams.accept({ token: ctx.body.token }, ctx.user, meta(ctx)),
        );
        r.post(
          '/invitations/lookup',
          { policy: 'public', rateLimit: 'auth', summary: 'What an invitation link is about (team, role, address), before signing in', input: { token: f.string().required().max(200) }, tags },
          (ctx) => teams.lookup(ctx.body.token),
        );
        if (options.verifiedEmailField) {
          const verified = (user) => Boolean(user?.[options.verifiedEmailField]);
          r.get('/invitations', { policy: 'authenticated', summary: 'Invitations to your (verified) email address', tags }, (ctx) => (verified(ctx.user) ? teams.invitationsFor(ctx.user) : []));
          r.post('/invitations/:invitationId/accept', { policy: 'authenticated', summary: 'Accept an invitation to your verified email address', tags }, (ctx) => {
            // An unverified address proves nothing: anybody can sign up with someone else's email.
            if (!verified(ctx.user)) throw forbidden('Verify your email address first, or open the link from the invitation email');
            return teams.accept({ invitationId: ctx.params.invitationId }, ctx.user, meta(ctx));
          });
        }

        r.get('/:teamId', { policy: 'member', summary: 'One of your teams', tags }, async (ctx) =>
          teams.teamView(await teamOf(ctx), (await memberships(ctx.user)).get(ctx.params.teamId), ctx.user),
        );
        r.patch('/:teamId', { policy: 'team:admin', summary: 'Rename a team or change its slug (admins)', tags }, async (ctx) => {
          await teamOf(ctx);
          const data = await input(teamDef(), ctx.body, 'update');
          const doc = await calm.app.service('team').update(ctx.params.teamId, data, { ...ctx, system: true });
          calm.events.emit('team.updated', { team: { id: String(doc._id), name: doc.name, slug: doc.slug }, by: ctx.user.id, changes: Object.keys(data) });
          return teams.teamView(doc, (await memberships(ctx.user)).get(ctx.params.teamId), ctx.user);
        });
        r.delete('/:teamId', { policy: 'team:owner', summary: 'Delete a team, its memberships, invitations and records (owners)', tags }, async (ctx) => {
          await teams.deleteTeam(ctx.params.teamId, { by: ctx.user.id, scoped: [...scoped] });
        });

        r.get('/:teamId/members', { policy: 'member', summary: 'Members of a team and their roles', tags }, async (ctx) => teams.listMembers((await teamOf(ctx))._id));
        r.patch(
          '/:teamId/members/:userId',
          { policy: 'team:admin', summary: "Change a member's role (admins; only owners make owners)", input: { role: roleField().required() }, tags },
          async (ctx) => teams.changeRole((await teamOf(ctx))._id, ctx.params.userId, ctx.body.role, ctx.user),
        );
        r.delete('/:teamId/members/:userId', { policy: 'team:admin', summary: 'Remove a member (admins; only owners remove owners)', tags }, async (ctx) => {
          await teams.removeMember((await teamOf(ctx))._id, ctx.params.userId, ctx.user);
        });
        r.post('/:teamId/leave', { policy: 'member', summary: 'Leave a team (the last owner cannot)', tags }, async (ctx) => {
          await teams.removeMember((await teamOf(ctx))._id, ctx.user.id, ctx.user, { reason: 'left' });
        });
        r.post(
          '/:teamId/transfer',
          { policy: 'team:owner', summary: 'Make another member the owner; you stay as an admin', input: { userId: f.id().required() }, tags },
          async (ctx) => teams.transfer((await teamOf(ctx))._id, ctx.body.userId, ctx.user),
        );

        r.post(
          '/:teamId/invitations',
          { policy: inviteRule, status: 201, summary: 'Invite someone by email', input: { email: f.email().required(), role: roleField() }, tags },
          async (ctx) => ctx.reply(await teams.invite(ctx.params.teamId, ctx.body, ctx.user), { status: 201 }),
        );
        r.get('/:teamId/invitations', { policy: inviteRule, summary: 'Pending invitations of a team', tags }, async (ctx) => teams.listInvitations((await teamOf(ctx))._id));
        r.delete('/:teamId/invitations/:invitationId', { policy: inviteRule, summary: 'Revoke an invitation (its link stops working)', tags }, async (ctx) => {
          await teams.revoke((await teamOf(ctx))._id, ctx.params.invitationId, ctx.user);
        });
        r.post('/:teamId/invitations/:invitationId/resend', { policy: inviteRule, summary: 'Send an invitation again, with a new link', tags }, async (ctx) => {
          try {
            return await teams.resend((await teamOf(ctx))._id, ctx.params.invitationId, ctx.user);
          } catch (err) {
            if (err.retryAfter) ctx.res.setHeader('Retry-After', String(err.retryAfter));
            throw err;
          }
        });
      },
      { prefix: '/teams' },
    );

    // ---- doctor -------------------------------------------------------------------------------

    calm.doctor((app) => {
      const file = 'app/blocks/teams/index.js';
      const findings = [];
      if (!app.auth) findings.push({ level: 'error', id: 'teams-no-auth', title: 'teams needs auth', detail: 'Turn auth on and keep the user resource: teams are made of users.', file });
      if (!app.registry.has('team')) {
        findings.push({ level: 'error', id: 'teams-no-resource', title: 'teams: the team resource is missing', detail: 'Restore app/resources/team/team.resource.js (calm add teams writes it).', file });
        return findings;
      }
      findings.push({
        level: 'info',
        id: 'teams-scoped',
        title: scoped.size ? `Team-scoped resources: ${[...scoped].join(', ')}` : 'No team-scoped resources yet',
        detail: scoped.size
          ? 'Their records are visible only to members of their team, in every route and service call. The exposure matrix shows team rules as custom: cover them with tests (see the teams docs).'
          : "Add team: true to a resource to keep its records inside teams: resource('project', { team: true, fields, policy }).",
      });
      for (const { def, files } of app.registry.values()) {
        if (def.name === 'team' || scoped.has(def.name)) continue;
        const refs = Object.entries(def.fields).filter(([, field]) => field.type === 'ref' && field.opts.ref === 'team').map(([key]) => key);
        if (refs.length) {
          findings.push({
            level: 'warn',
            id: `teams-unscoped-${def.name}`,
            title: `${def.name} references a team but is not team-scoped`,
            detail: `${def.name}.${refs.join(', ')} points at a team, yet its records are not limited to that team's members. Add team: true to the resource (and name the field "${TEAM_FIELD}") if they belong to the team.`,
            file: files?.resource,
          });
        }
      }
      const roleValues = app.registry.get('user')?.def.fields.roles?.opts.of?.opts.values ?? [];
      if (roleValues.includes('member')) {
        findings.push({ level: 'warn', id: 'teams-member-role', title: "A user role is called 'member'", detail: "With the teams block, 'member' in a policy means a member of the record's team, not that user role. Rename the role.", file });
      }
      if (options.inviteRole === roles.lowest) {
        findings.push({ level: 'info', id: 'teams-anyone-invites', title: 'Every team member can invite people', detail: `inviteRole is '${options.inviteRole}'. Invitations still grant at most the inviter's own role.`, file });
      }
      return findings;
    });
  },
});
