/**
 * The immutable facts captured when a business event commits. Everything a notification may
 * say is rendered from this snapshot, so a later price, name or status change cannot alter
 * what an older notification says. Values are JSON-safe primitives only: money is integer
 * paise and instants are ISO-8601 strings.
 */
export type NotificationContext = {
  customer?: { name: string | null; email: string | null; mobile: string | null };
  order?: {
    number: string;
    status: string;
    paymentMethod: string;
    paymentStatus: string;
    subtotalPaise: number;
    deliveryChargePaise: number;
    totalPaise: number;
    createdAt: string;
    deliveredAt: string | null;
    address: string;
  };
  /** Order lines (or the reviewed product), sorted by name, capped by the context builder. */
  items?: { name: string; quantity: number; unitPricePaise: number | null; packLabel: string | null }[];
  return?: {
    id: string;
    status: string;
    refundAmountPaise: number | null;
    reference: string | null;
  };
  productId?: string;
};

export const MAX_CONTEXT_ITEMS = 20;
