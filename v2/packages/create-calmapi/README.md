# create-calmapi

Create a [CalmAPI](https://calmapi.dev) project: a Node.js and MongoDB backend whose framework code lives in your repo.

```bash
npm create calmapi@latest my-api
cd my-api
npm run dev
```

The API answers on `http://localhost:5001/api` and devtools on `http://localhost:5001/_calm`.

Options are passed to `calm create`:

```bash
npm create calmapi@latest my-api -- --template minimal   # api (default) or minimal
npm create calmapi@latest my-api -- --yes                # accept the defaults
```

Needs Node.js 22.12 or newer and a MongoDB server. Read the [getting started guide](https://calmapi.dev/docs/getting-started).

MIT licensed.
