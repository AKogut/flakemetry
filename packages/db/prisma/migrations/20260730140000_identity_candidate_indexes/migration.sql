-- CreateIndex
CREATE INDEX "test_identity_project_id_suite_title_idx" ON "test_identity"("project_id", "suite", "title");

-- CreateIndex
CREATE INDEX "test_identity_aliases_idx" ON "test_identity" USING GIN ("aliases");
