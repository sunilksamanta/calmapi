import { definePlugin } from '#calm';

// Sends app.mailer messages through Postmark (https://postmarkapp.com/developer/api/email-api).
// Without POSTMARK_SERVER_TOKEN in development, the built-in dev transport (devtools Mail
// panel) keeps working.
//
// Message fields it understands, next to to/from/subject/text/html:
//   cc, bcc, replyTo, headers: { 'X-Thing': 'v' }, tag, metadata: { orderId: '42' },
//   attachments: [{ filename, content: Buffer | base64 string, contentType, cid }]

const MAX_TAG = 1000; // Postmark's limit for Tag

/** "a@x.com" | ["a@x.com", "b@x.com"] -> "a@x.com, b@x.com" (Postmark takes a comma separated string). */
const addresses = (value) => (value === undefined || value === null || value === '' ? undefined : [value].flat().filter(Boolean).join(', '));

function toAttachment(a, i) {
  if (!a || typeof a !== 'object' || !a.filename) throw new Error(`mail-postmark: attachments[${i}] needs a filename`);
  if (a.content === undefined || a.content === null) throw new Error(`mail-postmark: attachments[${i}] (${a.filename}) has no content`);
  const content = Buffer.isBuffer(a.content) || a.content instanceof Uint8Array ? Buffer.from(a.content).toString('base64') : String(a.content);
  return {
    Name: String(a.filename),
    Content: content,
    ContentType: a.contentType || 'application/octet-stream',
    ...(a.cid ? { ContentID: `cid:${String(a.cid).replace(/^cid:/, '')}` } : {}),
  };
}

/** Postmark Metadata values must be strings. */
function toMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(metadata)) if (v !== undefined && v !== null) out[String(k).slice(0, 20)] = String(v).slice(0, 80);
  return Object.keys(out).length ? out : undefined;
}

export class PostmarkError extends Error {
  constructor(status, body) {
    const code = body?.ErrorCode;
    super(`Postmark refused the email (HTTP ${status}${code !== undefined ? `, ErrorCode ${code}` : ''}): ${body?.Message ?? 'no message'}`);
    this.name = 'PostmarkError';
    this.status = status;
    this.errorCode = code ?? null;
    // 406: the recipient is on the suppression list (hard bounce, spam complaint, unsubscribe).
    this.inactiveRecipient = code === 406;
  }
}

export default definePlugin({
  name: 'mail-postmark',
  env: {
    POSTMARK_SERVER_TOKEN: { secret: true, description: 'Server API token from Postmark (Servers, API Tokens): without it, mail stays in devtools' },
    POSTMARK_MESSAGE_STREAM: 'Message stream ID (default "outbound", the transactional stream)',
    MAIL_FROM: 'Sender address on a verified domain or sender signature, for example "Acme <hello@acme.com>"',
  },
  // Override in calm.config.js: blocks: { 'mail-postmark': { messageStream: 'password-resets' } }
  options: {
    apiBase: 'https://api.postmarkapp.com',
    messageStream: null, // default: POSTMARK_MESSAGE_STREAM, then 'outbound'
    trackOpens: null, // null: what the server settings in Postmark say
    trackLinks: null, // 'None' | 'HtmlAndText' | 'HtmlOnly' | 'TextOnly'
    timeoutMs: 15_000,
  },
  setup(calm, options) {
    const token = calm.env('POSTMARK_SERVER_TOKEN');
    if (!token) {
      calm.doctor(() =>
        calm.config.mode === 'production'
          ? [{ level: 'error', id: 'postmark-token', title: 'POSTMARK_SERVER_TOKEN is not set', detail: 'Emails cannot be delivered in production.' }]
          : [],
      );
      return;
    }
    calm.doctor(() =>
      calm.config.mode === 'production' && !calm.env('MAIL_FROM')
        ? [{ level: 'warn', id: 'postmark-from', title: 'MAIL_FROM is not set (mail-postmark)', detail: 'Postmark only accepts senders on a verified domain or sender signature.' }]
        : [],
    );
    const api = String(options.apiBase).replace(/\/$/, '');
    const stream = options.messageStream || calm.env('POSTMARK_MESSAGE_STREAM') || 'outbound';

    calm.mailer.use({
      name: 'postmark',
      async send(message, { meta = {} } = {}) {
        const { to, from, subject, text, html, cc, bcc, replyTo, headers, attachments, tag, metadata } = message;
        // The tag comes from the message, or from meta.tag / meta.kind ('password-reset',
        // 'magic-link'...). Never the whole meta: it can hold tokens.
        const tagValue = tag ?? meta.tag ?? meta.kind;
        const body = {
          From: calm.env('MAIL_FROM') || from,
          To: addresses(to),
          Cc: addresses(cc),
          Bcc: addresses(bcc),
          ReplyTo: addresses(replyTo),
          Subject: subject,
          TextBody: text,
          HtmlBody: html,
          MessageStream: message.messageStream || stream,
          Tag: typeof tagValue === 'string' && tagValue ? tagValue.slice(0, MAX_TAG) : undefined,
          Metadata: toMetadata(metadata),
          Headers: headers && typeof headers === 'object' ? Object.entries(headers).map(([Name, Value]) => ({ Name, Value: String(Value) })) : undefined,
          Attachments: Array.isArray(attachments) && attachments.length ? attachments.map(toAttachment) : undefined,
          TrackOpens: options.trackOpens ?? undefined,
          TrackLinks: options.trackLinks ?? undefined,
        };
        if (!body.To) throw new Error('mail-postmark: the message has no recipient (to)');
        if (!body.TextBody && !body.HtmlBody) throw new Error('mail-postmark: the message needs text or html');

        let res;
        try {
          res = await fetch(`${api}/email`, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json', 'x-postmark-server-token': token },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(options.timeoutMs),
          });
        } catch (err) {
          throw new Error(`Postmark could not be reached: ${err.message}`, { cause: err });
        }
        const answer = await res.json().catch(() => null);
        // Postmark answers 200 with ErrorCode 0 on success, 422 with an ErrorCode otherwise.
        if (!res.ok || (answer && answer.ErrorCode)) throw new PostmarkError(res.status, answer);
        return { id: answer?.MessageID ?? null, to: answer?.To ?? body.To, submittedAt: answer?.SubmittedAt ?? null };
      },
    });
  },
});
