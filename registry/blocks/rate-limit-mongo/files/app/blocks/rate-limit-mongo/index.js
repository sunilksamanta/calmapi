import { definePlugin } from '#calm';

// Fixed-window counters in MongoDB: one document per key and window, removed by a TTL
// index once the window is over. Replaces the in-memory store used by calm/http.
export default definePlugin({
  name: 'rate-limit-mongo',
  setup(calm) {
    const schema = new calm.mongoose.Schema(
      { _id: String, count: { type: Number, default: 0 }, expiresAt: Date },
      { collection: 'calm_rate_limits', versionKey: false },
    );
    schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    const Counter = calm.mongoose.model('calmRateLimit', schema);

    calm.app.rateStore = {
      async hit(key, windowMs) {
        const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
        const resetAt = windowStart + windowMs;
        const doc = await Counter.findOneAndUpdate(
          { _id: `${key}:${windowStart}` },
          { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(resetAt) } },
          { upsert: true, returnDocument: 'after' },
        ).lean();
        return { count: doc.count, resetAt };
      },
    };
  },
});
