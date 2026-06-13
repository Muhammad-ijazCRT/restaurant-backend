-- Add extended vendor profile fields
ALTER TABLE "vendors"
  ADD COLUMN IF NOT EXISTS "vendor_type" TEXT,
  ADD COLUMN IF NOT EXISTS "address" TEXT,
  ADD COLUMN IF NOT EXISTS "about_vendor" TEXT,
  ADD COLUMN IF NOT EXISTS "operating_hours" TEXT;
