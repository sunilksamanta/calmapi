import { badRequest } from '#calm';
import { uploadMiddleware, verifySignature, pathOf, INLINE } from '#app/blocks/storage-local/storage.js';

export default (r) => {
  r.post(
    '/upload',
    { policy: 'authenticated', status: 201, summary: 'Upload a file (multipart/form-data, field "file")', middleware: [uploadMiddleware('file')] },
    async (ctx) => {
      const file = ctx.req.file;
      if (!file) throw badRequest('Send the file as multipart/form-data in a field named "file"');
      verifySignature(file);
      return ctx.service.create(
        { originalName: file.originalname.slice(0, 255), mimeType: file.mimetype, size: file.size, key: file.filename },
        ctx,
      );
    },
  );

  r.get('/:id/download', { policy: 'owner | admin', summary: 'Download a file' }, async (ctx) => {
    const doc = await ctx.service.model.findById(ctx.doc._id).select('+key').lean();
    const inline = INLINE.has(doc.mimeType);
    const headers = {
      'Content-Type': inline ? doc.mimeType : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.originalName)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=0',
    };
    await new Promise((resolve, reject) => ctx.res.sendFile(pathOf(doc.key), { headers }, (err) => (err ? reject(err) : resolve())));
  });
};
