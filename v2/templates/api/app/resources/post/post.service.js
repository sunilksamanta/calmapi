import { ResourceService, hasRole } from '#calm';

export default class PostService extends ResourceService {
  // Every query goes through scope(): visitors see published posts, authors also see
  // their own drafts, admins see everything.
  scope({ user } = {}) {
    if (hasRole(user, 'admin')) return {};
    if (user) return { $or: [{ status: 'published' }, { author: user.id }] };
    return { status: 'published' };
  }

  async beforeCreate(data) {
    return {
      ...data,
      slug: await this.uniqueSlug(data.title),
      publishedAt: data.status === 'published' ? new Date() : undefined,
    };
  }

  async beforeUpdate(data, existing) {
    if (data.status === 'published' && existing.status !== 'published') data.publishedAt = new Date();
    return data;
  }

  /** Used by POST /api/posts/:id/publish (post.routes.js). */
  async publish(id, ctx) {
    return this.update(id, { status: 'published' }, ctx);
  }

  async uniqueSlug(title) {
    const base = title.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 80) || 'post';
    let slug = base;
    for (let i = 2; await this.model.exists({ slug }); i++) slug = `${base}-${i}`;
    return slug;
  }
}
