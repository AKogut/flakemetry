CREATE TABLE "team" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "handle" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "team_id_org_id_key" ON "team"("id", "org_id");
CREATE UNIQUE INDEX "team_org_id_slug_key" ON "team"("org_id", "slug");
CREATE UNIQUE INDEX "team_org_id_handle_key" ON "team"("org_id", "handle");

ALTER TABLE "team" ADD CONSTRAINT "team_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "team_member" (
    "team_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_member_pkey" PRIMARY KEY ("team_id","user_id")
);

CREATE INDEX "team_member_user_id_org_id_idx" ON "team_member"("user_id", "org_id");
CREATE INDEX "team_member_org_id_idx" ON "team_member"("org_id");

ALTER TABLE "team_member" ADD CONSTRAINT "team_member_team_id_org_id_fkey" FOREIGN KEY ("team_id", "org_id") REFERENCES "team"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_user_id_org_id_fkey" FOREIGN KEY ("user_id", "org_id") REFERENCES "membership"("user_id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_grant" ADD COLUMN "team_id" UUID,
ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "project_grant" ADD CONSTRAINT "project_grant_one_target" CHECK (("user_id" IS NULL) <> ("team_id" IS NULL));

CREATE INDEX "project_grant_team_id_idx" ON "project_grant"("team_id");
CREATE UNIQUE INDEX "project_grant_project_id_team_id_key" ON "project_grant"("project_id", "team_id");

ALTER TABLE "project_grant" ADD CONSTRAINT "project_grant_team_id_org_id_fkey" FOREIGN KEY ("team_id", "org_id") REFERENCES "team"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;
