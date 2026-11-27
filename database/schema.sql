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
  is_default  BOOLEAN      NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- "Unfiled Cards": every user has exactly one default collection (created at sign-up and by the
-- startup migration). It cannot be deleted or renamed; cards without a collection live in it.
ALTER TABLE folders ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS folders_one_default_per_user ON folders (user_id) WHERE is_default;

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
  price       TEXT         NOT NULL DEFAULT '',
  link_key    TEXT         NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Additive upgrades for databases created before og_image and price existed.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS og_image TEXT NOT NULL DEFAULT '';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS price TEXT NOT NULL DEFAULT '';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS link_key TEXT NOT NULL DEFAULT '';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS site TEXT NOT NULL DEFAULT '';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS published TEXT NOT NULL DEFAULT '';
-- Card privacy: a card is visible to others only when unlocked and in a public collection.
-- Every card, existing ones included, starts locked.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS businesses_link_key_idx ON businesses (link_key);

-- Extra collections of a card; the primary one stays in businesses.folder_id.
CREATE TABLE IF NOT EXISTS business_folders (
  business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  folder_id   INT NOT NULL REFERENCES folders(id)    ON DELETE CASCADE,
  position    INT NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, folder_id)
);

-- Images uploaded from the web (POST /api/v1/images); served publicly by random UUID.
CREATE TABLE IF NOT EXISTS images (
  id         UUID PRIMARY KEY,
  user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
