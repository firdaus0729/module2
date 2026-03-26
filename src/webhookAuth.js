import crypto from 'crypto';

const MODULE2_WEBHOOK_SECRET = process.env.MODULE2_WEBHOOK_SECRET || '';

export function verifyWebhookSignature(rawBody, signature) {
  if (!MODULE2_WEBHOOK_SECRET) return false;
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', MODULE2_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
