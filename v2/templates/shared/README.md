# {{title}}

Built with [CalmAPI](https://calmapi.dev): the framework code lives in `calm/` and is yours.
Documentation: https://docs.calmapi.dev

## Run it

```bash
npm install
npm run dev          # http://localhost:5001/api, devtools at http://localhost:5001/_calm
```

Needs MongoDB. Set `MONGODB_URI` in `.env` (defaults to a local server).

## Common tasks

```bash
npx calm make resource product title:string! price:number
npx calm add @calmapi/jobs
npx calm routes
npx calm doctor
npm test
```

## Production

```bash
NODE_ENV=production APP_URL=https://api.example.com MONGODB_URI=... CORS_ORIGINS=https://app.example.com npm start
```

`npm start` runs in production mode unless `NODE_ENV` says otherwise. Health checks:
`GET /health/live` and `GET /health/ready`.
