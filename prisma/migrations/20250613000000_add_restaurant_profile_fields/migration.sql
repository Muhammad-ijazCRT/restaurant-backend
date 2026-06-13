-- Add extended restaurant profile fields
ALTER TABLE "restaurant_organizations"
  ADD COLUMN IF NOT EXISTS "restaurant_type" TEXT,
  ADD COLUMN IF NOT EXISTS "address" TEXT,
  ADD COLUMN IF NOT EXISTS "about_restaurant" TEXT,
  ADD COLUMN IF NOT EXISTS "opening_hours" TEXT;
