# Product quantity packs and combos — V1

Ordinary products retain their unit MRP, selling price and physical stock. After creating an ordinary product, open Edit and use Quantity packs to add a label, SKU, units per pack, pack MRP, pack selling price and active status. Sizes are fixed after creation; edit prices/labels or deactivate a pack. The default purchase is one unit. Packs of the same size on a product cannot be duplicated.

To create a combo, choose Combo in Add product and select at least two different ordinary products. Set each physical quantity, the combo category, name, SKU, media, MRP and selling price. Multiple combos can reuse the same component stock. A combo has no independent stock. Nested combos and quantity variants on combos are outside V1.

Prices are integer paise and selling prices cannot exceed the relevant MRP. Customers select packs on product details; cart identity includes the variant ID, so different packs remain separate lines. Cart prices are estimates; checkout loads the current authoritative catalog price. Existing saved carts and unresolved order submissions remain readable, and existing v1 request fingerprints stay unchanged for purchases without variants.

Stock requirements are aggregated across all singles, packs and combos in the cart. Product definitions and physical rows are locked in a consistent order. All reservations and order records commit atomically; an unavailable component rejects the whole purchase. Placement reserves physical units; cancellation releases them once; delivery deducts the original physical units. Component quantities, names and SKUs are snapshotted on each new order line. Historical lines without components retain the old one-unit stock semantics.

Reviews for a quantity pack are reviews of its parent product. A delivered combo purchase verifies the combo itself, without granting component review eligibility automatically. Account ownership and moderation rules are unchanged.

Returns are requested in complete purchased units/packs/combos. The backend snapshots the physical return quantities from the original order components. Admins inspect each physical component and record its sellable quantity and condition. Receipt never changes stock. One explicit restock action restores only inspected sellable physical units with inventory audit records; retries cannot restock twice. A damaged pack can contain sellable components even when no complete pack is sellable. Partial manual cash refunds retain the existing collected-cash limits and approval workflow. Partial returns of individual contents of a pack/combo are outside V1.

## Migration and deployment

Prepared migration: `20261014120000_product_packs_combos`. It creates PackVariant, ComboComponent, OrderItemComponent and ReturnCaseItemComponent; adds product kind (existing products default STANDARD), nullable order variant/pack labels and a return component-inspection flag; replaces the product-only order-line unique index with separate base/variant unique indexes; and retains legacy return quantity constraints while allowing inspected component restocking. No historical order, price, stock, refund or payment data is rewritten.

Back up and obtain separate approval before applying to the local development database. Production deployment/migration is not authorized by implementation approval. Apply the migration before starting the updated backend because Prisma queries need the new schema. Generate Prisma, deploy backend/admin, then distribute the updated mobile app. Existing clients can continue ordering ordinary products through the same endpoints.

Once packs/combos have been ordered, do not roll back to a backend that lacks component fulfillment: it would interpret pack quantities as physical unit quantities. Preserve the new tables and ledger; use a compatible backend fix or disable affected offers instead. Avoid downgrading the mobile app while a new pack purchase is unresolved.

New admin routes under the existing authenticated/origin-protected product router:
- POST `/api/v1/admin/products/:id/packs`
- PATCH `/api/v1/admin/products/:id/packs/:packId`

Product create accepts kind and comboComponents; product update accepts comboComponents for combos only. Product type and pack size cannot be changed through updates. Order item input gains optional variantId; prices and contents cannot be supplied by customers. Existing response envelopes and identifiers are retained with additional offer/snapshot fields.

Regression tests use disposable PostgreSQL and the real migration. They cover mixed cart stock, concurrent overselling, snapshots, delivery/cancellation, retries, authorization, pack ownership, availability, reviews, component inspection/restocking and mobile cart compatibility. Development and production records are not used for these tests.
