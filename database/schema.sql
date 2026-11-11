-- PostgreSQL schema. Run against an existing database:
--   psql "$DATABASE_URL" -f database/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL       PRIMARY KEY,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  first_name    VARCHAR(100) NOT NULL DEFAULT '',
  last_name     VARCHAR(100) NOT NULL DEFAULT '',
  token         VARCHAR(255),
  uid           VARCHAR(255),
  client        VARCHAR(255),
  is_guest      BOOLEAN      NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS folders (
  id          SERIAL       PRIMARY KEY,
  user_id     INT          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  description TEXT         NOT NULL,
  privacy     VARCHAR(50)  NOT NULL DEFAULT 'private',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS businesses (
  id          SERIAL       PRIMARY KEY,
  user_id     INT          NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  folder_id   INT                   REFERENCES folders(id) ON DELETE SET NULL,
  title       VARCHAR(255) NOT NULL,
  description TEXT         NOT NULL,
  website     VARCHAR(500) NOT NULL DEFAULT '',
  email       VARCHAR(255) NOT NULL DEFAULT '',
  tags        JSONB        NOT NULL,
  og_image    TEXT         NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Additive upgrade for databases created before og_image existed.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS og_image TEXT NOT NULL DEFAULT '';
