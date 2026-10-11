// Collections owned by the auth module. Both use TTL indexes, so expired sessions
// and reset tokens are cleaned up by MongoDB itself.

export function compileAuthModels(mongoose) {
  const { Schema } = mongoose;

  const session = new Schema(
    {
      tokenHash: { type: String, required: true, unique: true },
      user: { type: Schema.Types.ObjectId, ref: 'user', required: true, index: true },
      expiresAt: { type: Date, required: true },
      lastUsedAt: { type: Date },
      ip: String,
      userAgent: String,
    },
    { collection: 'calm_sessions', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
  );
  session.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  const reset = new Schema(
    {
      tokenHash: { type: String, required: true, unique: true },
      user: { type: Schema.Types.ObjectId, ref: 'user', required: true, index: true },
      expiresAt: { type: Date, required: true },
      usedAt: { type: Date, default: null },
    },
    { collection: 'calm_password_resets', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
  );
  reset.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  return {
    Session: mongoose.model('calmSession', session),
    PasswordReset: mongoose.model('calmPasswordReset', reset),
  };
}
