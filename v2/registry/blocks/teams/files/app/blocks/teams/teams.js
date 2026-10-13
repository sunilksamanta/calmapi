import { randomBytes } from 'node:crypto';
import { createToken, hashToken, currentRequest, serialize, CalmError, forbidden, notFound, conflict, validationError, tooManyRequests } from '#calm';
import { OWNER, ADMIN } from './roles.js';

// Teams, memberships and invitations: the data and the rules. index.js maps them to routes,
// policies and resource scoping. Every rule that protects a team is enforced here, so routes,
// scripts (app.ext.teams) and your own code all go through the same checks.
//
//  - Memberships are the only source of truth for access. They are read fresh for every
//    request (cached for that request only), so removing someone takes effect on their next call.
//  - A team always keeps at least one owner. Demoting, removing or leaving as the last owner is
//    refused, and a race between two owners is caught after the write and undone.
//  - Invitation tokens are random, stored as SHA-256 hashes, expire, and are claimed with one
//    atomic update, so a link works once. Accepting needs a signed-in user whose account email is
//    the invited address: a forwarded or leaked link is useless to anybody else.

const DAY_MS = 86_400_000;
const KEEP_DAYS = 30; // finished invitations stay this long (audit, "already used" answers), then MongoDB deletes them

export const isId = (s) => typeof s === 'string' && /^[a-f\d]{24}$/i.test(s);
const idOf = (user) => String(user?.id ?? user?._id ?? user);
const slugify = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');

const invalidInvitation = () => new CalmError(400, 'INVALID_INVITATION', 'This invitation is invalid or has expired');
const lastOwner = () => new CalmError(409, 'LAST_OWNER', 'A team needs at least one owner. Make someone else an owner first (or delete the team).');

export function createTeams(calm, options, roles) {
  const { Schema } = calm.mongoose;
  const teams = () => calm.app.service('team');
  const users = () => calm.app.model('user');
  const emit = (name, payload) => calm.events.emit(`team.${name}`, payload);
  const security = (name, data) => calm.events.emit(`security.${name}`, data);

  const membershipSchema = new Schema(
    {
      team: { type: Schema.Types.ObjectId, ref: 'team', required: true },
      user: { type: Schema.Types.ObjectId, ref: 'user', required: true },
      role: { type: String, required: true },
      invitedBy: { type: Schema.Types.ObjectId, default: null },
    },
    { collection: 'calm_team_memberships', timestamps: true, versionKey: false },
  );
  membershipSchema.index({ team: 1, user: 1 }, { unique: true }); // one membership per person and team
  membershipSchema.index({ user: 1 });
  membershipSchema.index({ team: 1, role: 1 });
  const Membership = calm.mongoose.model('calmTeamMembership', membershipSchema);

  const invitationSchema = new Schema(
    {
      team: { type: Schema.Types.ObjectId, ref: 'team', required: true, index: true },
      email: { type: String, required: true, lowercase: true, trim: true },
      role: { type: String, required: true },
      tokenHash: { type: String, required: true, unique: true },
      invitedBy: { type: Schema.Types.ObjectId, required: true },
      expiresAt: { type: Date, required: true },
      lastSentAt: { type: Date, required: true },
      sends: { type: Number, default: 1 },
      // `${team}:${email}` while the invitation is open, unset once accepted or revoked: the
      // sparse unique index allows one open invitation per address and team, even across instances.
      openKey: { type: String, default: undefined },
      acceptedAt: { type: Date, default: null },
      acceptedBy: { type: Schema.Types.ObjectId, default: null },
      revokedAt: { type: Date, default: null },
      revokedBy: { type: Schema.Types.ObjectId, default: null },
      purgeAt: { type: Date, required: true },
    },
    { collection: 'calm_team_invitations', timestamps: true, versionKey: false },
  );
  invitationSchema.index({ openKey: 1 }, { unique: true, sparse: true });
  invitationSchema.index({ email: 1, acceptedAt: 1, revokedAt: 1 });
  invitationSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
  const Invitation = calm.mongoose.model('calmTeamInvitation', invitationSchema);

  // ---- memberships, cached per request ------------------------------------------------

  // request store -> Map(userId -> Map(teamId -> role)). Keyed by the request, never by the user
  // object: long-lived holders of a user (realtime streams) must not keep stale memberships.
  const cache = new WeakMap();

  /** Memberships already loaded in this request, or undefined (scope() needs them synchronously). */
  function known(user) {
    const store = currentRequest();
    return store ? cache.get(store)?.get(idOf(user)) : undefined;
  }

  /** Map(teamId -> role) for a user. One query per user and request. */
  async function memberships(user) {
    const id = idOf(user);
    if (!isId(id)) return new Map();
    const hit = known(user);
    if (hit) return hit;
    const rows = await Membership.find({ user: id }).select('team role').lean();
    const map = new Map(rows.map((m) => [String(m.team), m.role]));
    const store = currentRequest();
    if (store) {
      if (!cache.has(store)) cache.set(store, new Map());
      cache.get(store).set(id, map);
    }
    return map;
  }

  /** After a membership change: whatever this request cached is stale. */
  const forget = () => {
    const store = currentRequest();
    if (store) cache.delete(store);
  };

  /** A role read from the database, never from a cache: used by the rules that change memberships. */
  async function roleOf(teamId, userId) {
    if (!isId(String(teamId)) || !isId(String(userId))) return null;
    return (await Membership.findOne({ team: teamId, user: userId }).select('role').lean())?.role ?? null;
  }

  // ---- teams ----------------------------------------------------------------------------

  /** A team as the API returns it (the team resource's visibility rules) plus your role in it. */
  const teamView = async (team, role, user = null) => ({ ...(await serialize(teams().def, team, { user, registry: calm.app.registry })), role });

  async function getTeam(teamId) {
    const team = isId(teamId) ? await teams().model.findById(teamId).lean() : null;
    if (!team) throw notFound('Team not found');
    return team;
  }

  async function freeSlug(name) {
    const base = slugify(name) || 'team';
    if (!(await teams().model.exists({ slug: base }))) return base;
    for (let i = 0; i < 5; i++) {
      const slug = `${base}-${randomBytes(3).toString('hex')}`;
      if (!(await teams().model.exists({ slug }))) return slug;
    }
    throw conflict('Could not find a free slug, pick one', { slug: 'Already taken' });
  }

  /** The team service's create, with the slug filled in. afterCreate (index.js) makes ctx.user the owner. */
  async function createTeam(user, data, ctx = {}) {
    if (options.maxOwnedTeams) {
      const owned = await Membership.countDocuments({ user: idOf(user), role: OWNER });
      if (owned >= options.maxOwnedTeams) throw new CalmError(409, 'TEAM_LIMIT', `You already own ${owned} teams (the limit is ${options.maxOwnedTeams})`);
    }
    const owner = { ...user, id: idOf(user) };
    const doc = await teams().create(data, { ...ctx, user: owner });
    return teamView(doc, OWNER, owner);
  }

  async function listMine(user) {
    const mine = await memberships(user);
    if (!mine.size) return [];
    const docs = await teams().model.find({ _id: { $in: [...mine.keys()] } }).sort({ name: 1 }).lean();
    return Promise.all(docs.map((t) => teamView(t, mine.get(String(t._id)), user)));
  }

  /**
   * Delete a team: memberships first (access ends at once), then invitations, the records of
   * team-scoped resources (options.deleteRecords) and the team itself.
   */
  async function deleteTeam(teamId, { by = null, scoped = [] } = {}) {
    const team = await getTeam(teamId);
    await Membership.deleteMany({ team: team._id });
    forget();
    await Invitation.deleteMany({ team: team._id });
    const records = {};
    if (options.deleteRecords) {
      for (const name of scoped) records[name] = (await calm.app.model(name).deleteMany({ team: team._id })).deletedCount;
    }
    await teams().model.deleteOne({ _id: team._id });
    emit('deleted', { team: { id: String(team._id), name: team.name, slug: team.slug }, by, records });
  }

  // ---- members -----------------------------------------------------------------------------

  async function listMembers(teamId) {
    const rows = await Membership.find({ team: teamId }).sort({ createdAt: 1 }).lean();
    const people = await users()
      .find({ _id: { $in: rows.map((m) => m.user) } })
      .select(options.showMemberEmails ? 'name email' : 'name')
      .lean();
    const byId = new Map(people.map((u) => [String(u._id), u]));
    return rows.map((m) => {
      const u = byId.get(String(m.user));
      return {
        user: { id: String(m.user), name: u?.name ?? null, ...(options.showMemberEmails ? { email: u?.email ?? null } : {}) },
        role: m.role,
        joinedAt: m.createdAt,
      };
    });
  }

  async function addMember(teamId, userId, role, { invitedBy = null, via = 'script' } = {}) {
    if (!roles.has(role)) throw validationError({ role: `Unknown role. Roles: ${roles.list.join(', ')}` });
    const team = await getTeam(String(teamId));
    try {
      await Membership.create({ team: team._id, user: userId, role, invitedBy });
    } catch (err) {
      if (err?.code === 11000) throw new CalmError(409, 'ALREADY_MEMBER', 'This person is already in the team');
      throw err;
    }
    forget();
    emit('member_added', { team: { id: String(team._id), name: team.name }, userId: String(userId), role, by: invitedBy ? String(invitedBy) : null, via });
    return { teamId: String(team._id), userId: String(userId), role };
  }

  /** Refuse when the change would leave no owner; after the write, undo if a race did. */
  async function keepAnOwner(teamId, change, undo) {
    if ((await Membership.countDocuments({ team: teamId, role: OWNER })) <= 1) throw lastOwner();
    await change();
    if ((await Membership.countDocuments({ team: teamId, role: OWNER })) === 0) {
      await undo();
      throw lastOwner();
    }
  }

  /**
   * Change someone's role. Admins and owners only (the route policy), you grant up to your own
   * role, only owners touch owners, and the last owner cannot be demoted.
   */
  async function changeRole(teamId, userId, role, actor) {
    if (!roles.has(role)) throw validationError({ role: `Unknown role. Roles: ${roles.list.join(', ')}` });
    const actorRole = await roleOf(teamId, idOf(actor));
    const member = isId(userId) ? await Membership.findOne({ team: teamId, user: userId }).lean() : null;
    if (!member) throw notFound('Member not found');
    if (!roles.atLeast(actorRole, ADMIN)) throw forbidden('Only team admins and owners change roles');
    if ((member.role === OWNER || role === OWNER) && actorRole !== OWNER) throw forbidden('Only owners can make or unmake owners');
    if (!roles.canGrant(actorRole, role)) throw forbidden(`You cannot give the ${role} role`);
    if (roles.rank(member.role) < roles.rank(actorRole)) throw forbidden('You cannot change the role of someone above you');
    if (member.role === role) return { userId, role };

    const set = (r) => Membership.updateOne({ _id: member._id }, { $set: { role: r } });
    if (member.role === OWNER) await keepAnOwner(member.team, () => set(role), () => set(OWNER));
    else await set(role);
    forget();
    emit('role_changed', { team: { id: String(teamId) }, userId: String(userId), from: member.role, to: role, by: idOf(actor) });
    return { userId: String(userId), role };
  }

  /**
   * Remove a member (or yourself: reason 'left'). The last owner can neither leave nor be removed.
   * actor null: a trusted call from your code (app.ext.teams.removeMember), no role checks.
   */
  async function removeMember(teamId, userId, actor, { reason = 'removed' } = {}) {
    const member = isId(String(userId)) ? await Membership.findOne({ team: teamId, user: userId }).lean() : null;
    if (!member) throw notFound('Member not found');
    const self = Boolean(actor) && String(userId) === idOf(actor);
    if (actor && !self) {
      const actorRole = await roleOf(teamId, idOf(actor));
      if (!roles.atLeast(actorRole, ADMIN)) throw forbidden('Only team admins and owners remove members');
      if (member.role === OWNER && actorRole !== OWNER) throw forbidden('Only owners can remove owners');
      if (roles.rank(member.role) < roles.rank(actorRole)) throw forbidden('You cannot remove someone above you');
    }
    const remove = () => Membership.deleteOne({ _id: member._id });
    if (member.role === OWNER) await keepAnOwner(member.team, remove, () => Membership.create(member));
    else await remove();
    forget();
    emit('member_removed', { team: { id: String(teamId) }, userId: String(userId), role: member.role, by: actor ? idOf(actor) : null, reason: self ? 'left' : reason });
  }

  /** Make another member an owner; the current owner stays as an admin. Owners only (route policy). */
  async function transfer(teamId, toUserId, actor) {
    const actorId = idOf(actor);
    if ((await roleOf(teamId, actorId)) !== OWNER) throw forbidden('Only owners can transfer ownership');
    if (String(toUserId) === actorId) throw validationError({ userId: 'You already own this team' });
    const target = isId(toUserId) ? await Membership.findOne({ team: teamId, user: toUserId }).lean() : null;
    if (!target) throw validationError({ userId: 'Only members of the team can receive it' });
    // The new owner first, so the team is never without one.
    await Membership.updateOne({ _id: target._id }, { $set: { role: OWNER } });
    await Membership.updateOne({ team: teamId, user: actorId }, { $set: { role: ADMIN } });
    forget();
    const team = { id: String(teamId) };
    if (target.role !== OWNER) emit('role_changed', { team, userId: String(toUserId), from: target.role, to: OWNER, by: actorId, via: 'transfer' });
    emit('role_changed', { team, userId: actorId, from: OWNER, to: ADMIN, by: actorId, via: 'transfer' });
    return { owner: String(toUserId), previousOwner: { userId: actorId, role: ADMIN } };
  }

  // ---- invitations -----------------------------------------------------------------------

  const linkBase = options.linkUrl ?? `${String(calm.config.app.url).replace(/\/$/, '')}/invite`;
  const linkFor = (token) => `${linkBase}${linkBase.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  const statusOf = (inv, now = new Date()) =>
    inv.acceptedAt ? 'accepted' : inv.revokedAt ? 'revoked' : inv.expiresAt <= now ? 'expired' : 'pending';
  const openFilter = (extra = {}) => ({ ...extra, acceptedAt: null, revokedAt: null });

  async function invitationView(inv) {
    const by = await users().findById(inv.invitedBy).select('name').lean();
    return {
      id: String(inv._id),
      team: String(inv.team),
      email: inv.email,
      role: inv.role,
      status: statusOf(inv),
      invitedBy: { id: String(inv.invitedBy), name: by?.name ?? null },
      expiresAt: inv.expiresAt,
      lastSentAt: inv.lastSentAt,
      createdAt: inv.createdAt,
    };
  }

  async function sendInvitation(inv, token, inviter) {
    const team = await teams().model.findById(inv.team).select('name').lean();
    if (!team) return;
    const app = calm.config.app.name;
    const who = inviter?.name || 'A teammate';
    const days = options.invitationTtlDays;
    await calm.mailer.send({
      to: inv.email,
      subject: `${who} invited you to ${team.name} on ${app}`,
      text:
        `${who} invited you to join the team ${team.name} on ${app} as ${inv.role}.\n\n` +
        `Open this link to accept (valid for ${days} day${days === 1 ? '' : 's'}, works once). Sign in or create an account with this email address first:\n${linkFor(token)}\n\n` +
        'If you do not want to join, ignore this email.',
      meta: { kind: 'team-invitation', team: String(inv.team), invitationId: String(inv._id), token },
    });
  }

  /** Invite an address. The route policy decides who may invite; here: which role they may give. */
  async function invite(teamId, { email, role = options.defaultRole }, actor) {
    const team = await getTeam(String(teamId));
    const actorRole = await roleOf(team._id, idOf(actor));
    if (!roles.atLeast(actorRole, options.inviteRole)) throw forbidden('You cannot invite people to this team');
    if (!roles.has(role)) throw validationError({ role: `Unknown role. Roles: ${roles.list.join(', ')}` });
    // Inviting is granting: the same rule as changing a role.
    if (!roles.canGrant(actorRole, role)) throw forbidden(`You cannot invite someone as ${role}`);
    const address = String(email).trim().toLowerCase();
    const existing = await users().findOne({ email: address }).select('_id').lean();
    if (existing && (await roleOf(team._id, existing._id))) throw new CalmError(409, 'ALREADY_MEMBER', 'This person is already in the team');

    // A cap on open invitations per team, so a compromised admin account cannot mail-bomb strangers.
    if (options.maxOpenInvitations && (await Invitation.countDocuments(openFilter({ team: team._id }))) >= options.maxOpenInvitations) {
      throw new CalmError(409, 'INVITATION_LIMIT', `This team has ${options.maxOpenInvitations} open invitations. Revoke some first.`);
    }
    const now = new Date();
    const openKey = `${team._id}:${address}`;
    // An expired invitation no longer blocks a new one: it is closed (and cannot be resent).
    await Invitation.updateMany({ openKey, expiresAt: { $lte: now } }, { $set: { revokedAt: now, purgeAt: new Date(now.getTime() + KEEP_DAYS * DAY_MS) }, $unset: { openKey: 1 } });
    const token = createToken('invite');
    const expiresAt = new Date(now.getTime() + options.invitationTtlDays * DAY_MS);
    let inv;
    try {
      inv = await Invitation.create({
        team: team._id,
        email: address,
        role,
        tokenHash: hashToken(token),
        invitedBy: idOf(actor),
        expiresAt,
        lastSentAt: now,
        openKey,
        purgeAt: new Date(expiresAt.getTime() + KEEP_DAYS * DAY_MS),
      });
    } catch (err) {
      if (err?.code === 11000) throw new CalmError(409, 'ALREADY_INVITED', 'This address already has a pending invitation. Resend it instead.');
      throw err;
    }
    const doc = inv.toObject();
    calm.app.background(() => sendInvitation(doc, token, actor));
    emit('invitation_sent', { team: { id: String(team._id), name: team.name }, invitationId: String(doc._id), email: address, role, by: idOf(actor), resend: false });
    return invitationView(doc);
  }

  async function listInvitations(teamId) {
    const list = await Invitation.find(openFilter({ team: teamId })).sort({ createdAt: -1 }).lean();
    return Promise.all(list.map(invitationView));
  }

  async function revoke(teamId, invitationId, actor) {
    if (!isId(invitationId)) throw notFound('Invitation not found');
    const now = new Date();
    const inv = await Invitation.findOneAndUpdate(
      openFilter({ _id: invitationId, team: teamId }),
      { $set: { revokedAt: now, revokedBy: idOf(actor), purgeAt: new Date(now.getTime() + KEEP_DAYS * DAY_MS) }, $unset: { openKey: 1 } },
    ).lean();
    if (!inv) throw notFound('Invitation not found');
    emit('invitation_revoked', { team: { id: String(teamId) }, invitationId: String(inv._id), email: inv.email, by: idOf(actor) });
  }

  /** Send again with a new token (the old link stops working) and a new expiry, once per cooldown. */
  async function resend(teamId, invitationId, actor) {
    if (!isId(invitationId)) throw notFound('Invitation not found');
    const now = new Date();
    const token = createToken('invite');
    const expiresAt = new Date(now.getTime() + options.invitationTtlDays * DAY_MS);
    const cooldown = new Date(now.getTime() - options.resendCooldownSeconds * 1000);
    // One conditional update: concurrent resends cannot both pass the cooldown.
    const inv = await Invitation.findOneAndUpdate(
      // openKey: an expired invitation replaced by a newer one cannot be revived.
      openFilter({ _id: invitationId, team: teamId, openKey: { $exists: true }, lastSentAt: { $lte: cooldown } }),
      { $set: { tokenHash: hashToken(token), expiresAt, lastSentAt: now, purgeAt: new Date(expiresAt.getTime() + KEEP_DAYS * DAY_MS) }, $inc: { sends: 1 } },
      { returnDocument: 'after' },
    ).lean();
    if (!inv) {
      const open = await Invitation.findOne(openFilter({ _id: invitationId, team: teamId, openKey: { $exists: true } })).lean();
      if (!open) throw notFound('Invitation not found');
      const wait = Math.max(1, Math.ceil((open.lastSentAt.getTime() + options.resendCooldownSeconds * 1000 - now.getTime()) / 1000));
      const err = tooManyRequests(`This invitation was sent moments ago. Try again in ${wait} second${wait === 1 ? '' : 's'}.`);
      err.retryAfter = wait;
      throw err;
    }
    calm.app.background(() => sendInvitation(inv, token, actor));
    emit('invitation_sent', { team: { id: String(teamId) }, invitationId: String(inv._id), email: inv.email, role: inv.role, by: idOf(actor), resend: true });
    return invitationView(inv);
  }

  /** What an invitation link is about, for the page that shows it. Open invitations only. */
  async function lookup(token) {
    const inv = await Invitation.findOne({ tokenHash: hashToken(token) }).lean();
    if (!inv || statusOf(inv) !== 'pending') throw invalidInvitation();
    const team = await teams().model.findById(inv.team).select('name slug').lean();
    if (!team) throw invalidInvitation();
    const view = await invitationView(inv);
    return { team: { id: String(team._id), name: team.name, slug: team.slug }, email: inv.email, role: inv.role, invitedBy: { name: view.invitedBy.name }, expiresAt: inv.expiresAt };
  }

  /**
   * Accept an invitation as `user`: by token (anybody holding the link, if their account email is
   * the invited one), or by id (verifiedEmailField: the account's email is verified, no link needed).
   */
  async function accept({ token, invitationId }, user, { ip } = {}) {
    const inv = token ? await Invitation.findOne({ tokenHash: hashToken(token) }).lean() : isId(invitationId) ? await Invitation.findById(invitationId).lean() : null;
    const refuse = (reason, err = invalidInvitation()) => {
      security('invalid_team_invitation', { reason, userId: idOf(user), ip, ...(inv ? { invitationId: String(inv._id), team: String(inv.team) } : {}) });
      return err;
    };
    if (!inv) throw refuse('unknown', token ? invalidInvitation() : notFound('Invitation not found'));
    const email = String(user.email ?? '').toLowerCase();
    // Checked before the claim: the wrong account does not burn the link.
    if (inv.email !== email) {
      throw refuse('wrong_email', token ? new CalmError(403, 'INVITATION_EMAIL', 'This invitation was sent to another email address. Sign in with that address to accept it.') : notFound('Invitation not found'));
    }
    const status = statusOf(inv);
    if (status !== 'pending') throw refuse(status);
    const team = await teams().model.findById(inv.team).lean();
    if (!team) throw refuse('team_deleted');

    // The claim: one atomic update, so an invitation is used once.
    const now = new Date();
    const claimed = await Invitation.findOneAndUpdate(
      openFilter({ _id: inv._id, tokenHash: inv.tokenHash, expiresAt: { $gt: now } }),
      { $set: { acceptedAt: now, acceptedBy: idOf(user), purgeAt: new Date(now.getTime() + KEEP_DAYS * DAY_MS) }, $unset: { openKey: 1 } },
    ).lean();
    if (!claimed) throw refuse('used');

    const current = await roleOf(team._id, idOf(user));
    if (!current) {
      try {
        await addMember(team._id, idOf(user), inv.role, { invitedBy: inv.invitedBy, via: 'invitation' });
      } catch (err) {
        if (err?.code !== 'ALREADY_MEMBER') throw err; // joined meanwhile: keep the role they have
      }
    }
    emit('invitation_accepted', { team: { id: String(team._id), name: team.name }, invitationId: String(inv._id), userId: idOf(user) });
    return teamView(team, current ?? (await roleOf(team._id, idOf(user))), user);
  }

  /** Open invitations for a user's (verified) email address. */
  async function invitationsFor(user) {
    const list = await Invitation.find(openFilter({ email: String(user.email ?? '').toLowerCase(), expiresAt: { $gt: new Date() } })).sort({ createdAt: -1 }).lean();
    const names = new Map((await teams().model.find({ _id: { $in: list.map((i) => i.team) } }).select('name').lean()).map((t) => [String(t._id), t.name]));
    return Promise.all(list.filter((i) => names.has(String(i.team))).map(async (i) => ({ ...(await invitationView(i)), teamName: names.get(String(i.team)) })));
  }

  // ---- accounts that go away -------------------------------------------------------------

  /**
   * A deleted account leaves its teams. Where it was the last owner, the longest-standing admin
   * (else member) becomes owner; a team left with nobody is deleted.
   */
  async function userGone(userId, { scoped = [] } = {}) {
    const rows = await Membership.find({ user: userId }).lean();
    for (const m of rows) {
      await Membership.deleteOne({ _id: m._id });
      emit('member_removed', { team: { id: String(m.team) }, userId: String(userId), role: m.role, by: null, reason: 'account_deleted' });
      if (m.role !== OWNER || (await Membership.exists({ team: m.team, role: OWNER }))) continue;
      const heir =
        (await Membership.findOne({ team: m.team, role: ADMIN }).sort({ createdAt: 1 }).lean()) ??
        (await Membership.findOne({ team: m.team }).sort({ createdAt: 1 }).lean());
      if (heir) {
        await Membership.updateOne({ _id: heir._id }, { $set: { role: OWNER } });
        emit('role_changed', { team: { id: String(m.team) }, userId: String(heir.user), from: heir.role, to: OWNER, by: null, via: 'account_deleted' });
      } else if (await teams().model.exists({ _id: m.team })) {
        await deleteTeam(String(m.team), { scoped });
      }
    }
    await Invitation.updateMany({ invitedBy: userId, ...openFilter() }, { $set: { revokedAt: new Date() }, $unset: { openKey: 1 } });
    forget();
  }

  return {
    Membership,
    Invitation,
    known,
    memberships,
    forget,
    roleOf,
    teamView,
    getTeam,
    freeSlug,
    createTeam,
    listMine,
    deleteTeam,
    listMembers,
    addMember,
    changeRole,
    removeMember,
    transfer,
    invite,
    listInvitations,
    revoke,
    resend,
    lookup,
    accept,
    invitationsFor,
    userGone,
  };
}
