-- Free-text notes on a truck post (route wishes, terms, extra contact info ...). Mirrors loads.notes (005).
ALTER TABLE trucks ADD COLUMN notes text NOT NULL DEFAULT '';
ALTER TABLE trucks ADD CONSTRAINT trucks_notes_len CHECK (char_length(notes) <= 500);
