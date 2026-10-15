# Push notifications and customer inbox — V1

DoorKart sends order, payment, return, account and review updates to customers as Firebase Cloud Messaging (FCM) push notifications and as an in-app inbox. The inbox works even when push is off or the customer has denied permission.

## How it works

1. A business change (order placed, status changed, cash collected, return action, account verified, review moderated) writes a row to `NotificationEvent` **inside the same database transaction** as the change. If the change rolls back, so does the event.
2. A small worker inside the API process (every ~5 s, safe with several instances) turns each event into a `Notification`: it picks the enabled template for the event, renders the text from the stored snapshot, and creates the customer's inbox entry.
3. The worker sends the notification to the customer's registered devices through the FCM HTTP v1 API using the saved service account. Every attempt is recorded.
4. Customers see the notification in the app inbox; tapping a push opens the right screen after the server confirms the notification belongs to that account.

A push failure never changes an order, payment, stock level or refund.

## Events

| Event | Sent when |
|---|---|
| ORDER_PLACED | A signed-in customer places an order (not repeated for an idempotent retry) |
| ORDER_CONFIRMED / ORDER_PACKED / ORDER_OUT_FOR_DELIVERY / ORDER_DELIVERED / ORDER_DELIVERY_FAILED | The shop moves the order to that status |
| ORDER_CANCELLED | The shop or the customer cancels |
| PAYMENT_COLLECTED | Cash on delivery is recorded as collected |
| RETURN_REQUESTED | The shop opens a return/refund case (customers cannot open one themselves) |
| RETURN_APPROVED / RETURN_REJECTED | The shop decides a case |
| RETURN_COMPLETED | A case is completed |
| REFUND_COMPLETED | A case is completed **with a cash payout** (sent in addition to RETURN_COMPLETED; enable either or both) |
| ACCOUNT_REGISTERED | A new account is verified for the first time |
| REVIEW_APPROVED / REVIEW_REJECTED | The shop approves or rejects a customer's own review |

Not implemented because no workflow exists: a separate "account verified" event (verification and creation are one step) and customer-initiated return requests.

Legacy orders without an account owner never notify anyone.

## Template variables

Insert with the picker in the template form; wording is `{variable_name}`. Only variables offered for the chosen event are accepted; anything else (including `{{ }}` or `${ }`) is rejected.

| Group | Variables |
|---|---|
| Customer | `{username}` (first name), `{customer_name}`, `{customer_email}`, `{customer_mobile}` |
| Order | `{order_number}`, `{order_status}`, `{order_total}`, `{subtotal}`, `{delivery_charge}`, `{payment_method}`, `{payment_status}`, `{order_date}`, `{delivery_date}`, `{delivery_address}` |
| Product | `{product_summary}`, `{item_count}`, `{total_units}`, `{product_name}`, `{product_quantity}`, `{product_price}`, `{pack_label}` |
| Return / refund | `{return_id}`, `{return_status}`, `{refund_amount}`, `{refund_status}`, `{refund_reference}` |
| Store | `{store_name}`, `{support_email}`, `{support_phone}` |

- Money is shown as `₹1,234.50`; dates are IST calendar dates (`16 Oct 2026`).
- Orders can have several products. `{product_summary}` gives "Name" or "Name and 2 more". `{product_name}` and `{product_quantity}` follow that summary; `{product_price}` and `{pack_label}` have a value only when the order has exactly one product line.
- **Sensitive variables** (`{customer_email}`, `{customer_mobile}`, `{delivery_address}`) show their value in the app inbox but are replaced by generic words ("your delivery address") in the push text, because lock screens are visible to others.
- Missing data falls back to a neutral phrase; raw placeholders or "undefined" are never shown. Titles are cut at 65 characters and messages at 240.

## One-time setup

### 1. Server
1. Apply the migration `20261015120000_push_notifications` (`npm run prisma:deploy` in `Backend`). It only adds tables; back up first as for any migration.
2. `SECRETS_KEY` must be set (`npm run secrets:key`). Losing or changing it makes saved Firebase credentials unreadable; save them again afterwards.
3. Restart the API. The worker starts with it. For a single-process deployment nothing else is needed.

### 2. Firebase project
1. In the [Firebase console](https://console.firebase.google.com) create a project (or reuse one). Cloud Messaging (FCM HTTP v1) is on by default for new projects; if not, enable the "Firebase Cloud Messaging API" in Google Cloud.
2. **Add an Android app** with package name `in.doorkart.app` and download `google-services.json`.
3. **Project settings → Service accounts → Generate new private key** and download the JSON file. Treat it as a password.

### 3. Admin panel (super admin only)
1. **Notifications → Firebase settings.** Enter the project ID, paste the whole key file, choose **Verify and save**. It is checked with Google before it is stored, encrypted, and is never shown again.
2. Choose **Test connection**, then **Turn on push notifications**.
3. **Notifications → Templates → New template.** Pick an event, write the title and message with the variable picker, check the preview, tick **Enabled**. Only one template per event can be enabled; enabling a second one switches the first off.
4. **Notifications → Events** shows which events are on and which have a template. Events with no enabled template send nothing.
5. **Send test** (super admin) on a template sends a "[Test]" notification with sample data to one customer account's inbox and devices. Use an account that is signed in on the Android build.

### 4. Android app
1. Put `google-services.json` in `App/BuyNest/` and add `"googleServicesFile": "./google-services.json"` under `expo.android` in `app.json`. (Do not commit it if your repository is public.)
2. Make a **development or production build** (`npx expo run:android` or `eas build`). Remote push does **not** work in Expo Go.
3. Optional: add a white 96×96 notification icon through the `expo-notifications` plugin `icon` option so the status-bar icon is not a grey square.
4. Sign in on the phone and place an order (or open Account → Notifications and turn notifications on). Android 13+ asks for permission at that moment.

## Operating it

- **History** lists every notification with its status, attempts, error category and FCM message id. Open one for the delivery attempts; **Retry** re-queues FAILED or SKIPPED ones (devices that already accepted it are not sent again).
- **Statuses:** PENDING (waiting or retrying), PROCESSING, SENT, FAILED, SKIPPED.
  - **SENT means FCM accepted the message.** It does not prove the phone displayed it.
  - SKIPPED: no device, push turned off, Firebase not configured, or all devices had expired registrations. The inbox entry still exists.
  - FAILED: credentials rejected, message rejected, or temporary errors exhausted all attempts.
- **Retries:** up to 5 attempts with exponential backoff (about 30 s, 2 min, 10 min, 1 h, 6 h). Expired device tokens are deactivated automatically.
- **Retention:** processed outbox events are removed after 30 days, notifications after 180 days, dead device registrations after 30 days.
- **Devices** (read-only) lists registrations by account and platform; tokens are shown only as a short suffix.
- **Replacing credentials:** paste the new file and tick "Replace". The old key stays in use unless Google accepts the new one.
- **Rotating `SECRETS_KEY`:** re-enter the Firebase key afterwards.

## Security notes

- Credentials are encrypted at rest (AES-256-GCM, key derived from `SECRETS_KEY`), only returned as project, service-account email and a key-id suffix, never logged and never sent to the app.
- Firebase settings, credential changes, connection tests and test sends require `SUPER_ADMIN`; templates, events and history are open to any staff role.
- Customer APIs use the signed-in account only; there is no way to name another account. Devices move to the new account when someone else signs in on the same install, and sign-out removes the registration.
- A push carries only the notification id, the screen key and an order number or product id. Tapping re-checks ownership with the server and maps the screen key through a fixed allowlist.
- Test sends are rate-limited (10 per 10 minutes).

## API summary

Customer (bearer token): `PUT /api/v1/account/devices`, `DELETE /api/v1/account/devices/:installationId`, `GET /api/v1/account/notifications`, `GET …/unread-count`, `POST …/:id/read`, `POST …/read-all`.

Admin (`/api/v1/admin/notifications`): `GET /overview`, `/events`, `PATCH /events/:key`, `/variables`, `/targets`, templates `GET|POST /templates`, `POST /templates/preview`, `GET|PUT|DELETE /templates/:id`, `POST /templates/:id/{duplicate,enabled,test}`, `GET /history`, `GET /history/:id`, `POST /history/:id/retry`, `GET /devices`, and (super admin) `GET|PATCH /provider`, `PUT /provider/credentials`, `POST /provider/test`.

## Platform credential requirements

| Item | Needed for | Where it lives |
|---|---|---|
| Firebase service account key (JSON) | The server to send via FCM | Admin panel → Firebase settings (stored encrypted) |
| `google-services.json` | The Android app to obtain an FCM token | Android build (`app.json` → `android.googleServicesFile`) |
| `SECRETS_KEY` | Encrypting the key above | Backend environment |
| Development/production Android build | Receiving remote push | EAS or local `expo run:android` |
| APNs authentication key + Firebase iOS SDK (`@react-native-firebase/messaging`) | **iOS only — not built** | Not available in V1 |

Saving the service account in the admin panel alone does not make push work: the Android build must also be built with the matching `google-services.json`.

## Limitations

- **Android only.** iOS tokens from `expo-notifications` are APNs tokens, which FCM HTTP v1 does not accept; supporting iOS needs the Firebase iOS SDK and an APNs key.
- **Provider acceptance, not delivery.** FCM gives no delivery receipt through this API; "Sent" cannot show that a device displayed the message. Messages may rarely be duplicated if a worker stops mid-send.
- **First-time accounts:** a brand-new account has no registered device yet, so its welcome notification is normally inbox-only.
- **Partial device failure:** if at least one device accepts a notification it is marked SENT; other devices that failed temporarily are not retried.
- **Session expiry:** when a customer's session expires (rather than signing out), the phone stays registered to that account until someone signs in on it again or notifications are revoked.
- **One enabled template per event** and one language; there are no per-customer notification preferences, quiet hours or marketing broadcasts. Promotional messaging is deliberately not built.
- **Orders from guests** (pre-account) and **returns opened by customers** do not exist, so no notifications are sent for them.
- **Worker model:** the worker runs inside the API process. If the API is stopped, queued notifications wait and are processed after restart. There is no separate worker deployment or dead-letter alerting beyond the History page.
- **Unverified in this environment:** nothing was sent through real Firebase or to a physical device during development; tests use a fake transport. Run the setup steps and a test send before relying on it.
- The `NotificationTemplate` "one enabled per event" rule is a partial unique index that Prisma's schema cannot express; `prisma migrate dev` may report it as drift. Keep it in the SQL migration.
