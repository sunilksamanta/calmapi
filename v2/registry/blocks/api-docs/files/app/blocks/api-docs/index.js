import { definePlugin } from '#calm';

// Interactive API reference at /docs, rendered by Scalar from /api/openapi.json.
// The Scalar script is pinned and loaded from jsDelivr; pin a newer version or
// self-host it if you prefer.
const SCALAR = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1';

export default definePlugin({
  name: 'api-docs',
  setup(calm) {
    const { config } = calm;
    const enabled = config.mode !== 'production' || process.env.API_DOCS === 'on';
    if (!enabled || !config.openapi.enabled) return;
    const specUrl = `${config.apiPrefix}${config.openapi.path}`;
    const csp = `default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.scalar.com; font-src 'self' data: https://cdn.jsdelivr.net https://fonts.scalar.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'`;

    calm.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      if (req.path === '/docs' || req.path === '/docs/') {
        res.setHeader('Content-Security-Policy', csp);
        return res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(config.app.name)} API</title>
</head>
<body>
  <div id="app" data-spec="${escapeHtml(specUrl)}"></div>
  <script src="${SCALAR}"></script>
  <script src="/docs/init.js"></script>
</body>
</html>`);
      }
      if (req.path === '/docs/init.js') {
        return res.type('application/javascript').send(
          "Scalar.createApiReference('#app', { url: document.getElementById('app').dataset.spec, hideClientButton: false });",
        );
      }
      next();
    });
  },
});

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
