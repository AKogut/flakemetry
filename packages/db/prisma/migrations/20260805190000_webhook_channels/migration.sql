-- Webhook receivers need a shared secret to verify the HMAC on each delivery. Unlike an
-- ingest token this cannot be stored hashed: signing requires the secret itself at send
-- time. It is therefore held in the clear and shown in the dashboard, the same way every
-- webhook product does it, and rotating means generating a new channel.
ALTER TABLE "notification_channel" ADD COLUMN IF NOT EXISTS "secret" TEXT;
