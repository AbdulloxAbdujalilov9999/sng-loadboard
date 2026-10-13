-- "My truck": the vehicle a driver describes once (type, capacity, plates, driver ...) so searching for loads and
-- posting a truck can start from it instead of from an empty form. One optional JSON object per member.
ALTER TABLE members ADD COLUMN my_truck jsonb;
ALTER TABLE members ADD CONSTRAINT members_my_truck_object CHECK (my_truck IS NULL OR jsonb_typeof(my_truck) = 'object');
