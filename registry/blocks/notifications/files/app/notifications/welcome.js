// A notification type: app/notifications/<type>.js. Send it with
//   await ctx.notify(user.id, 'welcome', { name: user.name })
// Every field can be a string or a function of the data you pass.
export default {
  title: ({ name }) => `Welcome, ${name}!`,
  body: 'Your account is ready. Tap to take a quick tour.',
  url: '/welcome',
  category: 'account', // people can turn a whole category on or off
  channels: ['inbox', 'push'], // where it goes by default: inbox, push, email
  // required: true,          // security notices: preferences cannot turn it off
  // email: { subject: ..., text: ... } // when the email should differ from title and body
};
