import { resource, f } from '#calm';

// Teams (organizations, workspaces). The teams block serves every /api/teams route itself, with
// the membership rules (roles, last owner, invitations), so the generic CRUD routes are off.
// Being a resource gives the rest of the app f.ref('team'), ?include=team, devtools and seeds.
// Add your own fields here (plan, logoUrl...): they show up in the team responses.
export default resource('team', {
  fields: {
    name: f.string().required().max(100).searchable().sortable(),
    // URL-friendly and unique; generated from the name when not given.
    slug: f.string().max(60).pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lowercase letters, digits and single dashes').unique().filterable(),
  },
  crud: false,
  policy: { list: 'none', read: 'none', create: 'none', update: 'none', delete: 'none' },
});
