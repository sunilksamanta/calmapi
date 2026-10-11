import { resource, f } from '#calm';

// Uploaded files (metadata). Created through POST /api/files/presign, confirmed with
// POST /api/files/:id/complete once the browser has PUT the bytes to S3.
export default resource('file', {
  crud: ['list', 'read', 'delete'],
  fields: {
    originalName: f.string().readOnly().searchable().sortable(),
    mimeType: f.string().readOnly().filterable(),
    size: f.integer().readOnly().sortable(),
    status: f.enum(['pending', 'ready']).default('pending').readOnly().filterable(),
    key: f.string().hidden(),
    owner: f.ref('user').owner().filterable(),
  },
  policy: {
    list: 'owner | admin',
    read: 'owner | admin',
    create: 'authenticated',
    update: 'none',
    delete: 'owner | admin',
  },
});
