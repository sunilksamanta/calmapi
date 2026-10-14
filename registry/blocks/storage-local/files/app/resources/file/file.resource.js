import { resource, f } from '#calm';

// Uploaded files (metadata). Upload with POST /api/files/upload (multipart, field "file").
export default resource('file', {
  crud: ['list', 'read', 'delete'], // created only through the upload route
  fields: {
    originalName: f.string().readOnly().searchable().sortable(),
    mimeType: f.string().readOnly().filterable(),
    size: f.integer().readOnly().sortable(),
    key: f.string().hidden(), // storage location, never exposed
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
