ALTER TYPE "MembershipRole" ADD VALUE 'viewer';

ALTER TABLE "project" ADD COLUMN "restricted" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "project_grant" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "granted_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_grant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_grant_project_id_user_id_key" ON "project_grant"("project_id", "user_id");
CREATE INDEX "project_grant_user_id_idx" ON "project_grant"("user_id");
CREATE INDEX "project_grant_org_id_idx" ON "project_grant"("org_id");

ALTER TABLE "project_grant" ADD CONSTRAINT "project_grant_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_event_org_id_created_at_idx" ON "audit_event"("org_id", "created_at" DESC);
CREATE INDEX "audit_event_project_id_created_at_idx" ON "audit_event"("project_id", "created_at" DESC);
