// App-wide routes, mounted under /api. Resources go in app/resources/<name>/
// (create one with: npx calm make resource product name:string! price:number).

export default (r) => {
  r.get('/hello', { policy: 'public', summary: 'Say hello' }, (ctx) => ({
    message: `Hello from ${ctx.config.app.name}`,
    time: new Date().toISOString(),
  }));
};
