# Teams (teams)

Organizations for your SaaS: people create teams, invite others by email, give them roles, and the
data of a team stays inside it. Mark a resource `team: true` and every route and service call keeps
its records to the members of their team: lists skip other teams, foreign ids answer 404, records
cannot be created in (or moved to) a team you are not in. New policy names, `'member'` and
`'team:admin'`, work anywhere a policy does: resources, custom routes, `visibleTo()`, `writableBy()`.

```bash
npx calm add teams
```

## Adds

| | |
| --- | --- |
| Files | `app/blocks/teams/index.js` (scoping, policies, routes, doctor), `app/blocks/teams/teams.js` (memberships, invitations and their rules), `app/blocks/teams/roles.js`, `app/resources/team/team.resource.js` |
| Environment | Nothing new. Invitation links are built from `APP_URL`. |
| Collections | `teams` (the `team` resource), `calm_team_memberships`, `calm_team_invitations` (finished invitations are removed by a TTL index after 30 days) |
| Policies | `member`, `team:owner`, `team:admin`, `team:member`, plus `team:<role>` for each role you add |
| Header | `X-Team: <teamId>`, the active team (optional) |

## Team-scoped resources

Add `team: true`. The block adds a `team` field (`f.ref('team')`, filterable, indexed, immutable):

```js
// app/resources/project/project.resource.js
import { resource, f } from '#calm';

export default resource('project', {
  team: true,
  fields: {
    name: f.string().required().max(100).sortable(),
    budget: f.number().visibleTo('team:admin'),   // admins and owners of the record's team
    author: f.ref('user').owner(),
  },
  policy: {
    list: 'member',
    read: 'member',
    create: 'member',
    update: 'team:admin | owner',                   // team admins, or the author
    delete: 'team:admin',
  },
});
```

What you get, whatever the policies say:

| | |
| --- | --- |
| `GET /api/projects` | records of the teams you belong to. Narrow it with `?team=<id>` or `X-Team: <id>` (403 if you are not in that team). With a list policy made only of team rules (`'team:admin'`), only teams where you have that role. |
| `GET /api/projects/:id` | 404 for a record of another team, guessed id or not |
| `POST /api/projects` | `{ "name": "Apollo", "team": "<teamId>" }`, or the `X-Team` header instead of `team`. 422 without a team, 403 for a team you are not in |
| `PATCH /api/projects/:id` | `team` cannot change (422), from the API or from `service.update()` in your code |
| Global admins | not members either: they see no team's records through the API. Use `{ system: true }` in your own admin tooling, with an explicit filter |

You may declare the field yourself (`team: f.ref('team').populate()`); it must be `f.ref('team')`
and named `team`. The block makes it immutable and not required for validation (the header can
supply it), and requires it on create.

### Policies

| Policy | Allows |
| --- | --- |
| `'member'` | anyone in the team, whatever their role |
| `'team:owner'` | owners |
| `'team:admin'` | admins and owners |
| `'team:<role>'` | that role or any role above it (roles are ordered) |

Combine them as usual: `'team:admin | owner'`, `'member | admin'`. Which team a rule is about:

1. the record's team, when there is a record (a header or a body can never redirect this);
2. `:teamId` in the path, for your own routes;
3. on create, `team` in the body, else the `X-Team` header;
4. the `X-Team` header, else (lists) `?team=`.

```js
// app/routes.js
export default (r) => {
  r.get('/teams/:teamId/report', { policy: 'team:admin', summary: 'Monthly report' }, async (ctx) => {
    return ctx.services.project.find({ team: ctx.params.teamId }, ctx);
  });
  // With X-Team, ctx.team is { id, role } (checked against the caller's memberships).
  r.get('/dashboard', { policy: 'member' }, (ctx) => ({ team: ctx.team }));
};
```

In your own code, `(await app.ext.teams.memberships(ctx.user)).get(teamId)` is the caller's role in
a team (or `undefined`).

## Routes

Every route is under `/api/teams`. Teams are returned as `{ id, name, slug, role, createdAt, updatedAt }`,
`role` being yours.

| Route | Policy | Body | Answer |
| --- | --- | --- | --- |
| `POST /teams` | `createPolicy` (signed in) | `{ name, slug? }` | 201 team, you are its owner |
| `GET /teams` | signed in | | your teams, with your role |
| `GET /teams/:teamId` | `member` | | the team |
| `PATCH /teams/:teamId` | `team:admin` | `{ name?, slug? }` | the team |
| `DELETE /teams/:teamId` | `team:owner` | | 204; memberships, invitations and (`deleteRecords`) its records go too |
| `GET /teams/:teamId/members` | `member` | | `[{ user: { id, name, email }, role, joinedAt }]` |
| `PATCH /teams/:teamId/members/:userId` | `team:admin` | `{ role }` | `{ userId, role }` |
| `DELETE /teams/:teamId/members/:userId` | `team:admin` | | 204 |
| `POST /teams/:teamId/leave` | `member` | | 204 |
| `POST /teams/:teamId/transfer` | `team:owner` | `{ userId }` | `{ owner, previousOwner: { userId, role: 'admin' } }` |
| `POST /teams/:teamId/invitations` | `team:<inviteRole>` | `{ email, role? }` | 201 invitation |
| `GET /teams/:teamId/invitations` | `team:<inviteRole>` | | open invitations (`pending` or `expired`) |
| `DELETE /teams/:teamId/invitations/:invitationId` | `team:<inviteRole>` | | 204, the link stops working |
| `POST /teams/:teamId/invitations/:invitationId/resend` | `team:<inviteRole>` | | the invitation, with a new link and expiry (429 during the cooldown) |
| `POST /teams/invitations/lookup` | public | `{ token }` | `{ team: { id, name, slug }, email, role, invitedBy: { name }, expiresAt }` |
| `POST /teams/invitations/accept` | signed in | `{ token }` | the team you joined, with your role |
| `GET /teams/invitations` | signed in, `verifiedEmailField` only | | invitations to your verified address |
| `POST /teams/invitations/:invitationId/accept` | signed in, `verifiedEmailField` only | | the team you joined |

An invitation is `{ id, team, email, role, status, invitedBy: { id, name }, expiresAt, lastSentAt, createdAt }`.
Errors use the usual shape; the codes worth handling: `LAST_OWNER` (409), `ALREADY_MEMBER` (409),
`ALREADY_INVITED` (409, resend it instead), `TEAM_LIMIT` and `INVITATION_LIMIT` (409), `INVALID_INVITATION` (400),
`INVITATION_EMAIL` (403: signed in with another address).

### Invitations

```http
POST /api/teams/66f0.../invitations
{ "email": "grace@example.com", "role": "admin" }
```

The email links to `APP_URL/invite?token=invite_...` (option `linkUrl`). That page:

1. shows what the link is about: `POST /api/teams/invitations/lookup { token }`;
2. makes the visitor sign in or sign up **with the invited address**;
3. calls `POST /api/teams/invitations/accept { token }`.

Links expire after 7 days (`invitationTtlDays`) and work once. Accepting with another account answers
403 `INVITATION_EMAIL` and does not use the link up. Inviting an address that already has an open
invitation answers 409 `ALREADY_INVITED`: resend it (a new link, the old one stops working). An expired
invitation no longer blocks a new one.

## Roles and rules

| | Owner | Admin | Member | Your roles |
| --- | --- | --- | --- | --- |
| See the team, its members, its records (`member`) | yes | yes | yes | yes |
| Rename the team, change its slug | yes | yes | | |
| Invite (default `inviteRole: 'admin'`) | yes | yes | if `inviteRole` allows | if `inviteRole` allows |
| Give a role | any | up to admin | up to their own | up to their own |
| Change the role of, or remove, an admin or member | yes | yes | | |
| Make or unmake owners, remove owners | yes | | | |
| Transfer ownership, delete the team | yes | | | |
| Leave | unless last owner | yes | yes | yes |

- Nobody acts on someone above them (an admin cannot touch an owner).
- A team always has an owner: the last one cannot be demoted, removed, or leave. Make someone else
  owner first, transfer, or delete the team. Two owners demoting each other at the same moment are
  caught after the write and one change is undone.
- Transfer makes a member the owner and you an admin.
- When an account is deleted (`DELETE /api/users/:id`, or the privacy block), it leaves its teams. A
  team that loses its last owner gets the longest-standing admin (else member) as owner; a team left
  with nobody is deleted.

Custom roles go between the built-in ones, ordered from most to least powerful:

```js
// calm.config.js
export default defineConfig({
  blocks: {
    teams: { roles: ['owner', 'admin', 'billing', 'member', 'viewer'], defaultRole: 'member' },
  },
});
```

`'team:billing'` then allows billing, admins and owners; `'member'` allows everyone including viewers.

## Options

`calm.config.js`, `blocks: { teams: { ... } }`:

| Option | Default | |
| --- | --- | --- |
| `roles` | `['owner', 'admin', 'member']` | ordered, starts with owner and admin |
| `defaultRole` | `'member'` | role of an invitation that does not name one |
| `createPolicy` | `'authenticated'` | who may create teams (`'admin'`, a plan check...) |
| `inviteRole` | `'admin'` | lowest role that may invite and manage invitations (`'member'`: everyone) |
| `invitationTtlDays` | `7` | |
| `resendCooldownSeconds` | `60` | |
| `maxOpenInvitations` | `100` | open invitations per team (409 `INVITATION_LIMIT` beyond), `0` for no limit |
| `linkUrl` | `APP_URL + '/invite'` | page of your frontend that accepts invitations |
| `verifiedEmailField` | `null` | a user field set once the email is verified (e.g. `'emailVerifiedAt'`): verified users see and accept their invitations without the link |
| `showMemberEmails` | `true` | members see each other's addresses |
| `maxOwnedTeams` | `20` | teams one person may own, `0` for no limit |
| `deleteRecords` | `true` | deleting a team deletes its records in team-scoped resources |
| `header` | `'x-team'` | the active team header |

Scripts and seeds: `app.ext.teams.create(user, { name })`, `addMember(teamId, userId, role)`,
`removeMember(teamId, userId)`, `delete(teamId)`, `memberships(user)`, `roleOf(teamId, userId)`.

## Events

| Event | Payload |
| --- | --- |
| `team.created` | `{ team: { id, name, slug }, userId }` |
| `team.updated` | `{ team, by, changes }` |
| `team.deleted` | `{ team, by, records: { project: 12 } }` |
| `team.member_added` | `{ team, userId, role, by, via: 'invitation' \| 'script' }` |
| `team.member_removed` | `{ team, userId, role, by, reason: 'removed' \| 'left' \| 'account_deleted' \| 'script' }` |
| `team.role_changed` | `{ team, userId, from, to, by, via? }` |
| `team.invitation_sent` | `{ team, invitationId, email, role, by, resend }` |
| `team.invitation_accepted`, `team.invitation_revoked` | `{ team, invitationId, ... }` |
| `security.invalid_team_invitation` | `{ reason, userId, ip, invitationId?, team? }`, reason `unknown`, `wrong_email`, `used`, `expired`, `revoked`, `team_deleted` |

## Security notes

- **Isolation is not a policy.** It lives in the service `scope()` of each team-scoped resource, which
  every query goes through (CRUD, custom routes using the service, realtime, webhooks, MCP). A policy
  mistake (`'authenticated'` instead of `'member'`) cannot expose another team's records.
- **Memberships are read for every request**, once, never cached across requests: removing a member
  takes effect on their next call, including live streams (`app.canRead()` reads them fresh).
- **The team named by a client is always checked** against the caller's memberships: body, header,
  path or query. With a record in hand, only the record's own team counts.
- **Records never move** between teams (immutable field, and refused in `service.update()` too).
- **Invitation tokens** are 256 random bits, stored as SHA-256 hashes, expire, and are claimed with one
  atomic update. They are bound to the invited address: a forwarded or leaked link is useless to
  another account, and a wrong account does not burn it. Accepting is rate limited like sign-in.
- **No email verification is assumed.** CalmAPI does not verify addresses, so anybody could sign up
  with someone else's address; that is why accepting needs the token unless you set
  `verifiedEmailField` to a field that your own verification flow sets.
- **Unknown and foreign teams look the same** (403), so team ids cannot be probed.
- Global `admin` gets no access to team data through the API. Support tooling should use
  `{ system: true }` service calls with an explicit `team` filter, behind its own policy.
- In your own service code, a call for another user than the request's (`service.list(q, { user: someoneElse })`)
  is refused with an error, not run unscoped: use `app.canRead()` or `{ system: true }`.
- `calm audit` and the exposure matrix show team rules as `custom` (a membership is data they
  cannot invent) and skip those checks: cover team-scoped resources with tests (two teams, a
  non-member, a removed member). `calm doctor` lists team-scoped resources and warns about resources
  that reference a team without being team-scoped.

## Frontend: a team switcher

```js
// Keep the active team in the client and send it with every request.
let activeTeam = localStorage.getItem('team');

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${session.token}`,
      ...(activeTeam ? { 'x-team': activeTeam } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 403 && activeTeam) {
    // Removed from the team meanwhile: forget it and let the user pick another one.
    localStorage.removeItem('team');
    activeTeam = null;
  }
  return res.status === 204 ? null : (await res.json());
}

async function renderSwitcher(select) {
  const { data: teams } = await api('/teams');
  select.innerHTML = teams.map((t) => `<option value="${t.id}">${t.name} (${t.role})</option>`).join('');
  if (!teams.some((t) => t.id === activeTeam)) activeTeam = teams[0]?.id ?? null;
  select.value = activeTeam ?? '';
  select.onchange = () => {
    activeTeam = select.value;
    localStorage.setItem('team', activeTeam);
    location.reload(); // or refetch your views
  };
}

// The invitation page (APP_URL/invite?token=...)
const token = new URLSearchParams(location.search).get('token');
const { data: invite } = await (await fetch('/api/teams/invitations/lookup', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
})).json();
// "Join invite.team.name as invite.role": sign in or sign up as invite.email, then:
await api('/teams/invitations/accept', { method: 'POST', body: { token } });
```
