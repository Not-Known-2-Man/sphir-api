# Sphir Local API

REST API for the Sphir web and iOS apps. Node.js + Express + PostgreSQL on port 3000.

## Prerequisites

- Node.js 18+
- PostgreSQL 18 running locally (`brew install postgresql@18 && brew services start postgresql@18`)

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Create the database and schema
createdb sphir_dev
psql -d sphir_dev -f database/schema.sql

# 3. Seed test user + sample data (needs SEED_EMAIL and SEED_PASSWORD)
npm run seed

# 4. Start the server
npm start
```

The server starts at **http://localhost:3000**.

## Test credentials

The seed creates a test user from the `SEED_EMAIL` and `SEED_PASSWORD`
environment variables. Set both (for example in `.env`) before `npm run seed`.

## Pointing the iOS app at localhost

In `NetworkService.swift`, change `baseURL` to:

```swift
let baseURL = URL(string: "http://localhost:3000")!
```

> **ATS note** — HTTP (not HTTPS) requires an App Transport Security exception.
> In Xcode, open the target's Info tab and add:
>
> ```
> NSAppTransportSecurity → NSAllowsArbitraryLoads = YES
> ```
>
> Or add to Info.plist:
> ```xml
> <key>NSAppTransportSecurity</key>
> <dict>
>   <key>NSAllowsLocalNetworking</key>
>   <true/>
> </dict>
> ```

## Auth flow

### Sign in
```
POST /api/v1/auth/sign_in
Body: { "email": "...", "password": "..." }

Response: { "token": "...", "uid": "...", "client": "...", "first_name": "...", "last_name": "..." }
```

### Sign up
```
POST /api/v1/auth
Body: { "email": "...", "password": "...", "password_confirmation": "...", "account_type": "personal", "domain": "sphir.io" }

Response: { "token": "...", "uid": "...", "client": "...", "first_name": "...", "last_name": "..." }
```

### Guest mode (no account)
```
GET /api/v1/auth/guest

Response: { "token": "guest_token", "uid": "guest", "client": "guest" }
```

### Sign out
```
DELETE /api/v1/auth/sign_out
Headers: Authorization: Bearer <token>
```

## Protected endpoints

All require `Authorization: Bearer <token>` header.

### Folders
```
GET    /api/v1/folders
POST   /api/v1/folders          Body: { name, description, privacy }
PUT    /api/v1/folders/:id      Body: { name?, description?, privacy? }
DELETE /api/v1/folders/:id
```

### Businesses (Cards)
```
GET    /api/v1/users/get_businesses?page=1&per_page=50
POST   /api/v1/businesses       Body: { title, description, website, email, tags, folder_id }
PUT    /api/v1/businesses/:id   Body: { title?, description?, website?, tags?, folder_id? }
DELETE /api/v1/businesses/:id
```

## Environment variables (optional)

`DATABASE_URL` (as provided by Render) takes precedence over the `DB_*` variables.

```
DATABASE_URL=postgres://user:password@host:5432/sphir_dev
DB_HOST=localhost
DB_USER=          # defaults to your OS user
DB_PASSWORD=
DB_NAME=sphir_dev
PORT=3000
SEED_EMAIL=
SEED_PASSWORD=
```

## Migrating legacy MySQL data

`database/migrate-from-mysql.js` copies users, folders and cards from the old MySQL
database (read from the `DB_*` variables) into an empty Postgres database, keeping ids:

```bash
TARGET_DATABASE_URL=postgres://... npm run migrate-from-mysql
```

It aborts if the target already has users.
