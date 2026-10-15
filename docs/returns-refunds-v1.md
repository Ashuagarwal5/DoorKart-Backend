# Manual COD returns and refunds — V1

## Scope and roles

Active ADMIN and SUPER_ADMIN staff can record and manage cases through the existing authenticated, trusted-origin admin API. Customer accounts and tracking tokens do not authorize these endpoints. There is no online payment integration or customer self-service return endpoint.

Only delivered COD orders with a delivery timestamp are eligible. Original orders, item snapshots, delivery/payment history, collection timestamps and cancellation rules remain intact. `PaymentStatus.REFUNDED` remains unused: original cash collection and the separate refund ledger must not be conflated.

## Workflow

Open a delivered order's **Returns & refunds** section:

1. Record a reason and choose Return only (zero refund), Refund only (no returned items), or Return and refund. Specify requested refund in rupees and purchased-item quantities. Only one REQUESTED or APPROVED case may exist per order.
2. Review and approve an amount no greater than requested, or reject with a note. Monetary approval requires recorded cash collection. The existing collection operation represents collection of the full order total, including delivery charges. Partial cash collection is not supported by the existing order system.
3. For physical returns, receive and inspect **all listed units together**, recording condition and sellable quantity. V1 does not support split shipments or partial receipt. Record requests for the quantities actually agreed for return. Receipt itself never changes stock. An inspected case cannot be rejected because physical custody has been recorded.
4. If appropriate, separately restock the inspected sellable quantity. This adds physical stock once, leaves reserved quantity unchanged, and creates an ADJUSTMENT with order, case/item reference, staff identity and timestamp. Unsellable units remain out of available stock. Restocking may happen before or after case completion. Do not also use the generic inventory adjustment screen for the same returned units.
5. Complete the approved case after receipt, if required. For a monetary refund, hand back the exact approved cash amount and record a unique cash receipt/reference. Confirming completion only records an external payout; it cannot send cash. Return-only completion records no payout. Completed/rejected cases and event history cannot be edited or deleted through the API.

A rejected case releases its commitment and permits a new request. Completed cases permit subsequent partial refunds or returns of still-eligible units. Full refunds can include delivery charges. Return-only on an unpaid delivered order does not forgive the existing outstanding balance; debt write-offs are outside this V1 workflow.

## Cash reconciliation

Per order: cash collected, completed refunds, approved amounts awaiting payout, remaining amount available for approval, and net cash retained. Completed plus approved refunds cannot exceed collected cash. Requests can be recorded before collection, but cash refunds cannot be approved or completed until collection is recorded. Monetary values are integer paise throughout the backend.

The **Returns & refunds** page provides search, pagination, status/type filters and cash totals. Its date inputs apply inclusive IST days independently to cash collection time and payout completion time. Blank dates mean all time. Approved awaiting payout is shown across all dates. Net cash movement can be negative when a refund relates to an earlier collection. Existing dashboard revenue/collection figures remain gross historical figures; the reconciliation page provides refund-adjusted cash movement. Refunds are not a profit calculation.

## API and concurrency

All routes are below `/api/v1/admin/returns`:

- GET `/`: paginated cases, optional search/status/kind.
- GET `/order/:id`: order items, cases and reconciliation totals.
- GET `/reconciliation?from=YYYY-MM-DD&to=YYYY-MM-DD`: collection/payout period totals.
- GET `/:id`: case with item inspection and append-only action history.
- POST `/`: UUID `clientRequestId`, orderId, kind, reason, requestedAmountPaise, items `{orderItemId, quantity}`.
- POST `/:id/actions`: UUID `requestId`, action, note, and action-specific fields. APPROVE uses approvedAmountPaise; RECEIVE uses items `{itemId, receivedQuantity, sellableQuantity, conditionNote}`; RESTOCK uses itemId; COMPLETE requires payoutReference for cash refunds. REJECT needs no extra fields.

Creation/action retries reuse their original UUID and exact normalized payload. Matching retries return the existing result; conflicting payloads fail. After a timeout, refresh or retry the same recording, **never hand over cash a second time**. The UI freezes uncertain submissions for this purpose. A page reload discards the in-memory retry payload; inspect the case history before taking further action.

All case mutations lock the parent order first. Refund totals and quantity eligibility are evaluated inside that transaction. Inventory changes and case/audit records commit atomically. A partial unique index enforces one open case per order, unique payout references prevent reusing a receipt, and SQL checks enforce amount/state/quantity constraints. Staff identities are audit snapshots retained independently of later account changes.

## Migration and verification

`20261013140000_cod_returns_refunds` adds ReturnCase, ReturnCaseItem and ReturnCaseEvent, their enums, indexes and constraints. It updates no historical rows. Deploy the migration before enabling these admin screens. No live or production migrations are part of implementation/testing; obtain separate deployment approval and back up the target database. Older application code can ignore the additive tables; retain the ledger during an application rollback rather than dropping financial history.

Regression tests run against temporary PostgreSQL with the real migrations. They cover authorization/origin validation, eligibility, full/partial refunds, over-refund rejection, concurrent retries, payout reference uniqueness, inspection/restock rules, audit preservation and IST reconciliation.
