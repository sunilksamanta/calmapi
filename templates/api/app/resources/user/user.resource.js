import { resource, f } from '#calm';

// Users. Sign up, sign in and password flows live in calm/auth (POST /api/auth/*).
// These CRUD routes are for admins and for users managing their own record.
export default resource('user', {
  owner: '_id', // a user owns their own record, so 'owner' below means "yourself"
  fields: {
    name: f.string().required().max(100).searchable().sortable(),
    email: f.email().required().unique().immutable().filterable().visibleTo('owner | admin'),
    password: f.password().required(),
    roles: f.array(f.enum(['user', 'admin'])).default(['user']).writableBy('admin').visibleTo('owner | admin').filterable(),
    status: f.enum(['active', 'disabled']).default('active').writableBy('admin').filterable(),
    avatarUrl: f.url(),
  },
  policy: {
    list: 'admin',
    read: 'owner | admin',
    create: 'admin', // everyone else signs up with POST /api/auth/register
    update: 'owner | admin',
    delete: 'admin',
  },
});
