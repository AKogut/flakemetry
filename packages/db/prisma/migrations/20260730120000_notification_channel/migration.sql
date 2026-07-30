-- CreateTable
CREATE TABLE "notification_channel" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "events" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_channel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_channel_project_id_idx" ON "notification_channel"("project_id");

-- CreateIndex
CREATE INDEX "notification_channel_org_id_idx" ON "notification_channel"("org_id");

-- AddForeignKey
ALTER TABLE "notification_channel" ADD CONSTRAINT "notification_channel_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
