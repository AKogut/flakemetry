CREATE TABLE "plugin_signal" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "test_identity_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "plugin" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_signal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "plugin_signal_project_id_updated_at_idx" ON "plugin_signal"("project_id", "updated_at" DESC);

CREATE INDEX "plugin_signal_org_id_idx" ON "plugin_signal"("org_id");

CREATE UNIQUE INDEX "plugin_signal_test_identity_id_plugin_code_key" ON "plugin_signal"("test_identity_id", "plugin", "code");

ALTER TABLE "plugin_signal" ADD CONSTRAINT "plugin_signal_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "plugin_signal" ADD CONSTRAINT "plugin_signal_test_identity_id_fkey" FOREIGN KEY ("test_identity_id") REFERENCES "test_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
