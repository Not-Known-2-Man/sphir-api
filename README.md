# Sphir Local API

Local REST API for iOS simulator testing. Node.js + Express + MySQL on port 3000.

## Prerequisites

- Node.js 18+
- MySQL 8+ running locally

## Setup

```bash
cd ~/Documents/SphirAPI

# 1. Install dependencies
npm install

# 2. Create the database schema (connect to MySQL first)
mysql -u root -p < database/schema.sql

# 3. Seed test user + sample data
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

```
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=sphir_dev
PORT=3000
SEED_EMAIL=
SEED_PASSWORD=
```
