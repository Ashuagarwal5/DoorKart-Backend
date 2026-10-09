# DoorKart Backend

REST API for DoorKart: Express 5, TypeScript, Prisma 7 and PostgreSQL. It is the source of
truth for the catalogue, delivery areas, stock and orders, and will serve the customer app,
the admin dashboard and any later clients.

Money is always **integer paise** (₹149.50 = `14950`). Prices, totals, delivery charges and
stock are computed here from the database; values sent by a client are never trusted.

## Requirements

- Node.js 22 or newer
- A PostgreSQL database (any of the options below)

## Setup

```bash
npm install
```

```bash
copy .env.example .env
```

### Database: pick one

**A. Bundled dev database (no install needed).** Runs a real PostgreSQL from npm, with data
in `.pgdata/`. Keep it running in its own terminal:

```bash
npm run db:dev
```

The default `DATABASE_URL` in `.env.example` already points at it (`localhost:5433`).

**B. Your own PostgreSQL** (local install, Docker or hosted). Create an empty database and
set `DATABASE_URL` in `.env`:

```
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
```

With Docker, for example:

```bash
docker run --name buynest-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=buynest -p 5432:5432 -d postgres:17
```

### Create the tables and load development data

```bash
npm run prisma:deploy
```

```bash
npm run prisma:seed
```

The seed mirrors the mobile app's mock data: 5 categories, 15 products and 6 delivery areas.
**It is placeholder data** — the delivery areas, charges, prices and stock levels are made
up for development. It is safe to re-run and never resets stock.

## Environment variables

| Variable       | Required | Purpose                                                                      |
| -------------- | -------- | ---------------------------------------------------------------------------- |
| `DATABASE_URL` | yes      | PostgreSQL connection string                                                 |
| `PORT`         | no       | API port, default `4000`                                                     |
| `NODE_ENV`     | no       | `development` (default), `test` or `production`                              |
| `CORS_ORIGINS` | no       | Comma-separated browser origins (the admin panel's address). Empty allows all in development, none in production |
| `ADMIN_SESSION_TTL_HOURS` | no | How long an admin stays signed in, default `12` |
| `TRUST_PROXY_HOPS` | no | Reverse proxies in front of the API, default `0` |
| `SECRETS_KEY` | for email sign-in and saved passwords | Master key (32 random bytes, base64). Create with `npm run secrets:key`. Keep a private copy: without the same key, saved secrets cannot be read |
| `UPLOAD_DIR` | no | Where uploaded product pictures and videos are stored, default `uploads` (inside `Backend`) |
| `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` / `ADMIN_SEED_NAME` | for `admin:create` | The first admin account. No defaults; see Admin setup |

`.env` is ignored by Git. Never commit real credentials.

## Commands

| Command                   | What it does                                             |
| ------------------------- | -------------------------------------------------------- |
| `npm run dev`             | Start the API with reload                                |
| `npm run build`           | Compile to `dist/`                                       |
| `npm start`               | Run the compiled API                                     |
| `npm run typecheck`       | TypeScript check                                         |
| `npm run lint`            | ESLint                                                   |
| `npm test`                | Run the tests                                            |
| `npm run db:dev`          | Start the bundled dev PostgreSQL                         |
| `npm run prisma:generate` | Regenerate the Prisma client (also runs on `npm install`) |
| `npm run prisma:migrate`  | Create and apply a migration after a schema change       |
| `npm run prisma:deploy`   | Apply existing migrations                                |
| `npm run prisma:seed`     | Load development data                                    |
| `npm run admin:create`    | Create the first admin from `ADMIN_SEED_*` (add `--reset-password` to replace a password) |
| `npm run db:reset-dev -- --yes` | DEV ONLY: delete all orders and customers, release reserved stock |
| `npm run seed:demo` | Adds 50 made-up demo products with placeholder pictures (skips any SKU that exists; edit them in the admin panel) |

`db:reset-dev` keeps the catalogue and delivery areas. It refuses to run if `NODE_ENV` is
`production` or the database is not on this machine, and does nothing without `--yes`.

Tests start their own throwaway PostgreSQL and apply the real migrations to it, so they need
nothing running and never touch your development database.

## API

Base URL: `http://localhost:4000/api/v1`

| Method | Path                           | Notes                                                        |
| ------ | ------------------------------ | ------------------------------------------------------------ |
| GET    | `/health` (no prefix)          | API and database status                                      |
| GET    | `/categories`                  | Active categories, by display order                          |
| GET    | `/products`                    | `page`, `limit` (max 50), `category` (slug), `featured`, `new`, `search` |
| GET    | `/products/:identifier`        | By slug (preferred) or id                                    |
| GET    | `/delivery-areas`              | Active areas with charges                                    |
| POST   | `/orders`                      | Place an order                                               |
| GET    | `/orders/:orderNumber`         | Needs the `X-Tracking-Token` header                          |
| POST   | `/orders/:orderNumber/cancel`  | Needs the `X-Tracking-Token` header; only while `PLACED`     |

There are no public endpoints that create or change products, stock, order status or
payment. Those are the authenticated admin APIs below.

### Responses

```json
{ "success": true, "data": {} }
```

```json
{ "success": false, "error": { "code": "OUT_OF_STOCK", "message": "...", "details": {} } }
```

| Status | Codes                                                                    |
| ------ | ------------------------------------------------------------------------ |
| 400    | `VALIDATION_ERROR`, `INVALID_JSON`                                       |
| 401    | `INVALID_TRACKING_TOKEN` (header missing)                                |
| 403    | `INVALID_TRACKING_TOKEN` (wrong token)                                   |
| 404    | `PRODUCT_NOT_FOUND`, `DELIVERY_AREA_NOT_FOUND`, `ORDER_NOT_FOUND`, `ROUTE_NOT_FOUND` |
| 409    | `OUT_OF_STOCK`, `PRODUCT_UNAVAILABLE`, `DELIVERY_AREA_UNAVAILABLE`, `ORDER_CANNOT_BE_CANCELLED`, `IDEMPOTENCY_CONFLICT` |
| 422    | `MINIMUM_ORDER_NOT_MET`                                                  |
| 500    | `INTERNAL_ERROR`                                                         |

### Placing an order

```json
{
  "clientRequestId": "0b9e0c1e-6f0e-4b53-9f0e-1c2d3e4f5a6b",
  "customer": { "fullName": "Ravi Kumar", "mobile": "+91 98765 43210" },
  "address": {
    "addressLine1": "12 Shastri Street",
    "addressLine2": "",
    "landmark": "Near the temple",
    "city": "Lucknow",
    "pincode": "226001"
  },
  "deliveryAreaId": "<id from /delivery-areas>",
  "items": [{ "productId": "<product id>", "quantity": 2 }],
  "paymentMethod": "COD"
}
```

- Unknown fields are rejected, so a client cannot send prices, totals or a delivery charge.
- `201` returns the order with its `orderNumber` and a `trackingToken`. **The token is only
  returned here**; store it, because reading or cancelling the order requires it.
- Sending the same request again (same `clientRequestId` **and** same contents) returns the
  original order with `200` and the header `Idempotent-Replayed: true`. It never creates a
  second order. This is how a client recovers when a response is lost: replay the request.
- The same `clientRequestId` with **different** contents is rejected with `409
  IDEMPOTENCY_CONFLICT`, and the reply reveals nothing about the original order.

## Admin API

Base URL: `http://localhost:4000/api/v1/admin`. Everything here needs a signed-in admin;
nothing in it is reachable without one (an unknown admin path answers 401, not 404).
Success and error responses use the same format as the public API.

### Admin setup

There is no default account and no signup. Create the first admin on the machine that has
the database, with your own details:

```bash
# PowerShell
$env:ADMIN_SEED_EMAIL="owner@yourshop.com"; $env:ADMIN_SEED_NAME="Your Name"; $env:ADMIN_SEED_PASSWORD="a long passphrase"; npm run admin:create
```

Or put the three `ADMIN_SEED_*` values in `.env`, run `npm run admin:create`, then **remove
`ADMIN_SEED_PASSWORD` from `.env`**. The account is created as `SUPER_ADMIN`. Passwords need
at least 10 characters. Running the command again for an existing email changes nothing; to
replace a forgotten password run it with `--reset-password`, which also signs that admin out
everywhere. The password is never printed or stored in plain text.

### Signing in

The admin panel authenticates with a **server-side session in an HttpOnly cookie**:

1. `POST /auth/login` with `{ "email", "password" }`. On success the response sets the
   `bn_admin_session` cookie and returns the admin's name, email and role.
2. The browser then sends that cookie automatically. Call the API with
   `credentials: 'include'` (fetch) and add the panel's address to `CORS_ORIGINS`.
3. `GET /auth/me` returns the signed-in admin; `POST /auth/logout` ends the session.

Why this design: the cookie holds a random 256-bit token and the database stores only its
SHA-256, so a leaked database cannot sign anyone in. Logging out or deactivating an admin
works on the very next request (a JWT could not be revoked). The cookie is `HttpOnly` (page
scripts cannot read it, so nothing sensitive sits in `localStorage`), `Secure` in production,
`SameSite=Lax`, limited to the path `/api/v1/admin`, and expires after
`ADMIN_SESSION_TTL_HOURS`. Because it is `SameSite=Lax`, the panel and the API must share a
registrable domain (for example `admin.shop.com` and `api.shop.com`, or `localhost` ports).
Admin requests that change data are also refused when their `Origin` is not in
`CORS_ORIGINS`. Login is limited to 10 failed attempts per address per 15 minutes (HTTP 429),
and a wrong password, an unknown email and an inactive account all get the same answer.

### Endpoints

| Method | Path                                   | Purpose                                              |
| ------ | -------------------------------------- | ---------------------------------------------------- |
| POST   | `/auth/login`, `/auth/logout`          | Sign in and out                                      |
| GET    | `/auth/me`                             | The signed-in admin                                  |
| GET    | `/dashboard`                           | Metrics, recent orders, low-stock products           |
| GET    | `/orders`                              | `status`, `paymentStatus`, `search`, `from`, `to`, `page`, `limit` |
| GET    | `/orders/:id`                          | Full order, history, and what it may do next         |
| PATCH  | `/orders/:id/status`                   | `{ status, note? }`                                  |
| PATCH  | `/orders/:id/payment`                  | `{ paymentStatus: "COLLECTED", note? }`              |
| GET    | `/products`                            | `search` (name/SKU), `categoryId`, `isActive`, `lowStock`, paging |
| POST   | `/products`                            | Create (with opening stock and images)               |
| GET/PATCH | `/products/:id`                     | Read / edit details (not stock)                      |
| POST   | `/uploads`                             | Upload one picture or video (multipart field `file`); returns `{ url, mediaType, sizeBytes }` |
| POST   | `/products/:id/inventory-adjustment`   | `{ quantityDelta, note }`: the only way to change stock |
| GET/POST | `/categories`                        | List all / create                                    |
| PATCH  | `/categories/:id`                      | Edit or deactivate                                   |
| GET/POST | `/delivery-areas`                    | List all / create                                    |
| PATCH  | `/delivery-areas/:id`                  | Edit or deactivate                                   |
| GET    | `/customers`, `/customers/:id`         | `search` (name/mobile), paging; order count, value, last order |

Lists are paginated (`page`, default 1; `limit`, default 25, **maximum 100**) and return
`{ items, pagination: { page, limit, total, totalPages } }`. Order `from` / `to` are shop
days as `YYYY-MM-DD`, both inclusive. Money is integer paise everywhere. Nothing is ever
deleted through the API: products, categories and delivery areas are deactivated with
`isActive: false`. Admin responses never contain tracking tokens.

### Customer sign-in (email code and Google)

Customers can sign in to the app with a one-time code sent by email, or with Google. This
creates an `Account`, separate from the guest `Customer` record that orders use, so ordering
without an account still works exactly as before.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/auth/config` | Which sign-in methods are on, and the Google web client ID (public) |
| POST | `/auth/email-otp/request` | `{ email }`: emails a 6-digit code |
| POST | `/auth/email-otp/verify` | `{ email, code }`: returns `{ token, account }` |
| POST | `/auth/google` | `{ idToken }`: the server verifies Google's token, returns `{ token, account }` |
| POST | `/auth/logout` | Ends this phone's session (`Authorization: Bearer <token>`) |
| GET / PATCH / DELETE | `/account/me` | Profile, rename, delete the account |

- **Codes:** 6 digits, valid for the minutes set in Settings (default 10), single use. Only a keyed
  hash is stored. Five wrong guesses kill a code. One address gets a new code at most every 60 seconds
  and five an hour. The answer is the same whether or not the address already has an account.
- **Google:** the server checks the ID token's signature, expiry, audience (against the client IDs saved
  in Settings) and that Google verified the email. A Google user whose email matches an existing account
  joins it. No Google client secret is needed for this flow.
- **Sessions:** a random token, kept on the phone in secure storage; only its SHA-256 is stored here.
  They last 30 days. Deleting the account removes every session.
- **Settings:** everything below is changed by a super admin in the admin panel (Settings), not in
  files: the SMTP server, the Google client IDs, which methods are on, and the code lifetime. The SMTP
  password is encrypted with `SECRETS_KEY` before it is stored and is never sent back to any screen.
  `POST /admin/settings/email/test` sends a test message with the saved settings.

### Product pictures and videos

The admin panel uploads a file to `POST /admin/uploads`, gets back a path such as
`/uploads/<random-id>.jpg`, and saves that path on the product (`images: [{ url, mediaType }]`).
Anyone can view `GET /uploads/<name>`, because customers see product media.

- **Allowed:** JPG, PNG, WebP and GIF pictures up to 5 MB; MP4, MOV and WebM videos up to 50 MB.
  A product holds at most 10 items, of which at most 3 are videos. The first picture is the main one.
- **The type comes from the file's contents,** not its name or declared type. A text file called
  `photo.jpg` is refused, and so are HEIC phone photos (with a message to save them as JPG).
- **Files are stored under a random name** with an extension the server picks, in `UPLOAD_DIR`.
  The database stores only that path. A product can only point at an uploaded file that exists.
- **Back up `UPLOAD_DIR` together with the database.** Restoring one without the other leaves
  products pointing at missing files. The folder is ignored by Git.
- Removing a picture from a product does not delete its file from disk yet.

### Order status rules

The server enforces these; the panel should offer only `allowedNextStatuses` from the order.

| From               | Can move to                    |
| ------------------ | ------------------------------ |
| `PLACED`           | `CONFIRMED`, `CANCELLED`       |
| `CONFIRMED`        | `PACKED`, `CANCELLED`          |
| `PACKED`           | `OUT_FOR_DELIVERY`, `CANCELLED` |
| `OUT_FOR_DELIVERY` | `DELIVERED`, `DELIVERY_FAILED` |
| `DELIVERY_FAILED`  | `OUT_FOR_DELIVERY`, `CANCELLED` |
| `DELIVERED`, `CANCELLED` | nothing (final)          |

An invalid move is `409 INVALID_ORDER_TRANSITION` and changes nothing. A packed order can
still be cancelled because nothing irreversible has happened: stock is only reserved and no
cash has been taken. Once an order is out for delivery the goods are on the road, so it can
only be delivered or marked failed. A failed delivery keeps its stock reserved (it may go out
again) until it is cancelled. Every change writes an `OrderStatusHistory` entry with the
admin and an optional note, in the same transaction as the change itself. The customer
sees the new status in the mobile app by refreshing.

### Inventory

`availableQuantity = stockQuantity - reservedQuantity` (calculated, never stored).

| Event                       | `stockQuantity` | `reservedQuantity` | Recorded as   |
| --------------------------- | --------------- | ------------------ | ------------- |
| Customer places an order    | unchanged       | + ordered          | `RESERVE`     |
| Order cancelled (by anyone) | unchanged       | - ordered          | `RELEASE`     |
| Admin marks `DELIVERED`     | - ordered       | - ordered          | `SALE`        |
| Admin adjustment            | + signed amount | unchanged          | `ADJUSTMENT`  |

Delivery and cancellation each run in one transaction and are guarded by the order's
current status inside the `UPDATE` itself, so a repeated or simultaneous request cannot sell
or release stock twice (the second gets `409`). Stock never goes below zero or below what is
reserved: an adjustment that would is refused with `409 ADJUSTMENT_BELOW_RESERVED`. Every
adjustment needs a note and is stored with the admin and a signed quantity.

### Cash on delivery

`DELIVERED` does not mean paid. Record cash with `PATCH /orders/:id/payment`; only
`PENDING -> COLLECTED` exists. It is allowed once the order is `OUT_FOR_DELIVERY` or
`DELIVERED` (`422 PAYMENT_NOT_ALLOWED` before that), and a second attempt is
`409 INVALID_PAYMENT_TRANSITION`. Each change is stored in `PaymentStatusHistory` with the
admin. Because refunds are not built, an order whose cash was collected cannot then be
cancelled or marked failed.

### Dashboard figures

"Today" is the shop's calendar day in India (IST); timestamps are stored in UTC.

| Field                     | Meaning                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `todayOrders`             | Orders placed today, whatever became of them                         |
| `pendingOrders`           | Orders still needing action: `PLACED`, `CONFIRMED` or `PACKED`       |
| `outForDeliveryOrders`    | Orders currently out for delivery                                    |
| `deliveredToday`          | Orders marked delivered today                                        |
| `todayRevenuePaise`       | Grand total of orders delivered today, paid or not                   |
| `cashCollectedTodayPaise` | Grand total of orders whose payment was marked collected today       |
| `cashPendingPaise`        | Cash owed on delivered orders still `PENDING` (`deliveredUnpaidOrders` is their count) |
| `lowStockCount`           | Active products whose available stock is at or below their threshold |

Revenue is recognised on delivery and cash collected comes only from payment records, so
the two are never inferred from each other.
## How the important rules are enforced

**Stock is reserved, not sold, at order time.** `available = stockQuantity - reservedQuantity`.
Placing an order increases `reservedQuantity`; cancelling decreases it. `stockQuantity` only
drops when an order is delivered (a future admin action, recorded as `SALE`). Every movement
is written to `InventoryTransaction`.

**Overselling is prevented in the database, not in application code.** A reservation is one
statement:

```sql
UPDATE "Product" SET "reservedQuantity" = "reservedQuantity" + $qty
WHERE "id" = $id AND "isActive" AND "stockQuantity" - "reservedQuantity" >= $qty
```

The availability check and the write are the same atomic statement and the row is locked,
so when two orders race for the last unit exactly one updates a row; the other updates none
and is rejected with `OUT_OF_STOCK`. As a backstop, a `CHECK` constraint keeps
`0 <= reservedQuantity <= stockQuantity`, so even a faulty query cannot oversell. Products
are always locked in id order, which prevents deadlocks between orders sharing products.

**An order is all-or-nothing.** Reservation, customer, order, items, status history, the
order number and the inventory records are written in one transaction. Any failure rolls
everything back.

**Idempotency covers the whole request, not just its id.** Each order stores a SHA-256
fingerprint of what was asked for: customer, address, delivery area, items (in any order)
and payment method. It is computed from the validated input, so `+91 98765 43210` and
`9876543210` match, and it excludes everything the server decides. A replay is accepted only
if its fingerprint matches. That keeps one id from standing for two purchases, and it means
the full original request acts as the proof needed to get the order (and its tracking token)
back: knowing only the id is not enough. Orders created before fingerprints existed have none
and can never be replayed.

**Order numbers** (`DK-YYYYMMDD-NNNN`, date in IST) come from an `OrderCounter` row
incremented with `INSERT ... ON CONFLICT DO UPDATE`, which is safe across concurrent
requests and multiple server processes.

**Order privacy.** Order numbers are sequential and guessable, so they grant nothing on
their own. Each order has a random 192-bit `trackingToken`, compared in constant time, sent
in a header so it stays out of URLs and logs.

## Project layout

```
prisma/        schema, migrations, seed
scripts/       bundled dev database, create-admin, dev data reset
src/
  config/      environment parsing
  lib/         prisma client, errors, pricing, mobile number
  middleware/  error handling, request log
  modules/     catalog, orders, health, admin (auth, orders, products, ...)
  app.ts       Express app
  server.ts    entry point
tests/         API tests against a real PostgreSQL
```
