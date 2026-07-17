-- Add imdb column to Movies table
ALTER TABLE "Movies" ADD COLUMN IF NOT EXISTS imdb TEXT;

-- Add imdb column to Episodes table
ALTER TABLE "Episodes" ADD COLUMN IF NOT EXISTS imdb TEXT;
