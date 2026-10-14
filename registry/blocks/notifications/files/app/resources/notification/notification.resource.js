import { resource, f } from '#calm';

// In-app notifications, written by ctx.notify() (the notifications block). People read, mark
// as read and delete their own; nobody creates them through the API. Being a resource, they
// show up in devtools, realtime-sse streams them and privacy exports include them.
export default resource('notification', {
  fields: {
    user: f.ref('user').owner(),
    type: f.string().max(100).readOnly().filterable(),
    category: f.string().max(100).readOnly().filterable(),
    title: f.string().max(250).readOnly(),
    body: f.text().max(2000).readOnly(),
    url: f.string().max(2048).readOnly(),
    data: f.json().readOnly(),
    channels: f.array(f.string().max(20)).readOnly(), // where it went: inbox, push, email
    readAt: f.date().filterable().sortable(), // GET /notifications?readAt[exists]=false lists unread ones
  },
  policy: { list: 'owner', read: 'owner', create: 'none', update: 'owner', delete: 'owner' },
  indexes: [
    { fields: { user: 1, readAt: 1, createdAt: -1 } },
    { fields: { createdAt: 1 }, options: { expireAfterSeconds: 180 * 86_400 } }, // kept for 180 days
  ],
});
