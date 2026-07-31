-- CreateTable
CREATE TABLE "identity_stitch" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "test_identity_id" UUID NOT NULL,
    "level" TEXT NOT NULL,
    "from_fingerprint" TEXT NOT NULL,
    "from_file_path" TEXT,
    "from_title" TEXT,
    "to_file_path" TEXT NOT NULL,
    "to_title" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_stitch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "identity_stitch_test_identity_id_created_at_idx" ON "identity_stitch"("test_identity_id", "created_at");

-- CreateIndex
CREATE INDEX "identity_stitch_project_id_created_at_idx" ON "identity_stitch"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "identity_stitch_org_id_idx" ON "identity_stitch"("org_id");

-- AddForeignKey
ALTER TABLE "identity_stitch" ADD CONSTRAINT "identity_stitch_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_stitch" ADD CONSTRAINT "identity_stitch_test_identity_id_fkey" FOREIGN KEY ("test_identity_id") REFERENCES "test_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
