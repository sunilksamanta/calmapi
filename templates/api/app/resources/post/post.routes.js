// Custom endpoints for posts. They are mounted before the CRUD routes, so a path like
// '/featured' is never mistaken for '/:id'. Return a value to respond with { data }.

export default (r) => {
  r.get('/featured', { policy: 'public', summary: 'Latest published posts' }, async (ctx) => {
    const { items } = await ctx.service.list({ filter: { status: 'published' }, sort: { publishedAt: -1 }, limit: 5 }, ctx);
    return items; // raw documents are serialized with the post visibility rules
  });

  r.post('/:id/publish', { policy: 'owner | admin', summary: 'Publish a draft' }, (ctx) => ctx.service.publish(ctx.params.id, ctx));
};
