import { resource, f } from '#calm';

export default resource('post', {
  fields: {
    title: f.string().required().max(200).searchable().sortable(),
    slug: f.string().readOnly().unique().filterable(),
    body: f.text().required().max(50_000),
    status: f.enum(['draft', 'published']).default('draft').filterable(),
    tags: f.array(f.string().max(30)).max(10).default([]).filterable(),
    author: f.ref('user').owner(), // set from the session; powers the 'owner' policy
    publishedAt: f.date().readOnly().sortable(),
  },
  policy: {
    list: 'public', // drafts are filtered out in post.service.js scope()
    read: 'public',
    create: 'authenticated',
    update: 'owner | admin',
    delete: 'owner | admin',
  },
});
