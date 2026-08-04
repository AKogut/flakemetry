-- Both counters were written on every failure and read by nothing: cluster impact sums
-- the signatures instead. Keeping them would have meant two sources of truth that drift
-- the moment retention prunes an execution or a merge moves one, and they were already
-- wrong for a signature adopted into a cluster with history behind it.
ALTER TABLE "error_cluster" DROP COLUMN "signature_count";
ALTER TABLE "error_cluster" DROP COLUMN "occurrence_count";
