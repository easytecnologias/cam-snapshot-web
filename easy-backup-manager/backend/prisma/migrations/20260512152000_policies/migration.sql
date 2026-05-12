CREATE TABLE "BackupPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fileBackupMode" TEXT NOT NULL DEFAULT 'all_without_system',
    "imageBackupMode" TEXT NOT NULL DEFAULT 'all_internal',
    "fileBackupSchedule" TEXT NOT NULL DEFAULT 'daily',
    "imageBackupSchedule" TEXT NOT NULL DEFAULT 'weekly',
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupPolicy_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Machine" ADD COLUMN "backupPolicyId" TEXT;

CREATE INDEX "BackupPolicy_tenantId_active_idx" ON "BackupPolicy"("tenantId", "active");
CREATE INDEX "Machine_backupPolicyId_idx" ON "Machine"("backupPolicyId");

ALTER TABLE "BackupPolicy" ADD CONSTRAINT "BackupPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_backupPolicyId_fkey" FOREIGN KEY ("backupPolicyId") REFERENCES "BackupPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
