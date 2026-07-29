-- AlterTable
ALTER TABLE "test_execution" ADD COLUMN "ordinal" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "test_execution_run_id_ordinal_key" ON "test_execution"("run_id", "ordinal");
