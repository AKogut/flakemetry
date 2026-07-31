-- CreateTable
CREATE TABLE "test_health_event" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "test_identity_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_health_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "test_health_event_project_id_created_at_idx" ON "test_health_event"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "test_health_event_test_identity_id_created_at_idx" ON "test_health_event"("test_identity_id", "created_at");

-- CreateIndex
CREATE INDEX "test_health_event_org_id_idx" ON "test_health_event"("org_id");

-- AddForeignKey
ALTER TABLE "test_health_event" ADD CONSTRAINT "test_health_event_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_health_event" ADD CONSTRAINT "test_health_event_test_identity_id_fkey" FOREIGN KEY ("test_identity_id") REFERENCES "test_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
