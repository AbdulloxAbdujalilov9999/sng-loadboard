-- Everyone is an individual (company = their own name) until they say they work with a company.
ALTER TABLE members ADD COLUMN works_with_company boolean NOT NULL DEFAULT false;
-- Existing members that already named a company keep it.
UPDATE members SET works_with_company = true WHERE role = 'member' AND company <> contact_name AND company <> '';
