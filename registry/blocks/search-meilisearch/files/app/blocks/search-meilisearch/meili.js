// The few Meilisearch endpoints this block uses (https://www.meilisearch.com/docs/reference/api),
// with fetch. Writes are asynchronous tasks in Meilisearch: a 202 means "queued".

export class MeiliError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'MeiliError';
    this.status = status;
    this.code = code;
    // 4xx other than 408/429 will fail the same way again (bad key, invalid document...).
    this.permanent = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
  }
}

export function createClient({ host, adminKey, searchKey, timeoutMs }) {
  const base = String(host ?? '').replace(/\/$/, '');

  async function call(method, path, body, key = adminKey) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new MeiliError(`Meilisearch could not be reached: ${err.message}`);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new MeiliError(`Meilisearch answered HTTP ${res.status}${json?.code ? ` (${json.code})` : ''}: ${json?.message ?? 'no message'}`, { status: res.status, code: json?.code ?? null });
    return json;
  }

  const index = (uid) => `/indexes/${encodeURIComponent(uid)}`;
  return {
    /** Add or replace documents (the index is created on first use). */
    upsert: (uid, docs) => call('POST', `${index(uid)}/documents?primaryKey=id`, docs),
    remove: (uid, id) => call('DELETE', `${index(uid)}/documents/${encodeURIComponent(id)}`),
    clear: (uid) => call('DELETE', `${index(uid)}/documents`),
    settings: (uid, settings) => call('PATCH', `${index(uid)}/settings`, settings),
    search: (uid, body) => call('POST', `${index(uid)}/search`, body, searchKey || adminKey),
    health: () => call('GET', '/health', undefined, null),
  };
}
