import { f, badRequest } from '#calm';
import { settings, newKey, presignUpload, presignDownload, head } from '#app/blocks/storage-s3/s3.js';

const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export default (r) => {
  r.post(
    '/presign',
    {
      policy: 'authenticated',
      status: 201,
      summary: 'Start an upload: returns a presigned PUT URL',
      input: { fileName: f.string().required().max(255), contentType: f.string().required().max(100), size: f.integer().required().min(1) },
    },
    async (ctx) => {
      const s = settings();
      const { fileName, contentType, size } = ctx.body;
      if (!s.allowed.includes(contentType)) throw badRequest(`File type ${contentType} is not allowed. Allowed: ${s.allowed.join(', ')}`);
      if (size > s.maxBytes) throw badRequest(`File is larger than ${Math.round(s.maxBytes / 1048576)} MB`);
      const key = newKey(ctx.user.id, contentType);
      const file = await ctx.service.create({ originalName: fileName, mimeType: contentType, size, key, status: 'pending' }, ctx);
      return { file: await ctx.serialize(file), upload: await presignUpload(key, contentType, size) };
    },
  );

  r.post('/:id/complete', { policy: 'owner', summary: 'Confirm an upload once the bytes are in S3' }, async (ctx) => {
    const doc = await ctx.service.model.findById(ctx.doc._id).select('+key').lean();
    if (doc.status === 'ready') return doc;
    const object = await head(doc.key);
    if (!object) throw badRequest('The file has not been uploaded yet');
    if (object.ContentLength !== doc.size || object.ContentType !== doc.mimeType) {
      throw badRequest('Uploaded object does not match the declared size or type');
    }
    return ctx.service.update(doc._id, { status: 'ready' }, ctx);
  });

  r.get('/:id/download', { policy: 'owner | admin', summary: 'Redirect to a short-lived download URL' }, async (ctx) => {
    const doc = await ctx.service.model.findById(ctx.doc._id).select('+key').lean();
    if (doc.status !== 'ready') throw badRequest('This file is not uploaded yet');
    ctx.res.redirect(302, await presignDownload(doc.key, doc.originalName, INLINE.has(doc.mimeType)));
  });
};
