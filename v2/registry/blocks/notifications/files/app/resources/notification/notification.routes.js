// Inbox helpers next to the CRUD routes (custom routes are matched first).
export default (r) => {
  r.get('/unread-count', { policy: 'authenticated', summary: 'How many of your notifications are unread' }, async (ctx) => ({
    count: await ctx.service.model.countDocuments({ user: ctx.user._id, readAt: null }),
  }));
  r.post('/read-all', { policy: 'authenticated', summary: 'Mark all your notifications as read' }, async (ctx) => {
    const res = await ctx.service.model.updateMany({ user: ctx.user._id, readAt: null }, { $set: { readAt: new Date() } });
    return { marked: res.modifiedCount };
  });
  r.post('/:id/read', { policy: 'owner', summary: 'Mark one notification as read' }, (ctx) => ctx.service.update(ctx.doc._id, { readAt: ctx.doc.readAt ?? new Date() }, ctx));
};
