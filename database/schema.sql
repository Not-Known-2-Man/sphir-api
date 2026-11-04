CREATE DATABASE IF NOT EXISTS sphir_dev;
USE sphir_dev;

CREATE TABLE IF NOT EXISTS users (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  email        VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  first_name   VARCHAR(100) NOT NULL DEFAULT '',
  last_name    VARCHAR(100) NOT NULL DEFAULT '',
  token        VARCHAR(255),
  uid          VARCHAR(255),
  client       VARCHAR(255),
  is_guest     TINYINT(1)  NOT NULL DEFAULT 0,
  created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS folders (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT          NOT NULL,
  name        VARCHAR(255) NOT NULL,
  description TEXT         NOT NULL,
  privacy     VARCHAR(50)  NOT NULL DEFAULT 'private',
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS businesses (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT          NOT NULL,
  folder_id   INT,
  title       VARCHAR(255) NOT NULL,
  description TEXT         NOT NULL,
  website     VARCHAR(500) NOT NULL DEFAULT '',
  email       VARCHAR(255) NOT NULL DEFAULT '',
  tags        JSON         NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
  FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL
);
