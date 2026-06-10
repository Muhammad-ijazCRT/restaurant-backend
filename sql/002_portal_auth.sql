-- Portal login passwords for vendor and restaurant accounts
ALTER TABLE vendors
  ADD COLUMN login_password TEXT NULL AFTER email;

ALTER TABLE restaurant_organizations
  ADD COLUMN login_password TEXT NULL AFTER email;
