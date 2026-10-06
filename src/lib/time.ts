/**
 * Shop-day handling. Every timestamp in the database is UTC; "today" for the shop is a
 * calendar day in India. All day boundaries come from here, so no route parses dates itself.
 *
 * India has no daylight saving, so the offset is a constant. A shop in a zone that does
 * would need a real time-zone library here instead; nothing else would have to change.
 */

const SHOP_UTC_OFFSET_MINUTES = 330; // IST, UTC+05:30
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The UTC instant at which the shop day containing `instant` began. */
export function startOfShopDay(instant: Date): Date {
  const shopClock = instant.getTime() + SHOP_UTC_OFFSET_MINUTES * MINUTE_MS;
  const shopMidnight = Math.floor(shopClock / DAY_MS) * DAY_MS;
  return new Date(shopMidnight - SHOP_UTC_OFFSET_MINUTES * MINUTE_MS);
}

/** [start, end) of the shop day containing `instant`, as UTC instants. */
export function shopDayRange(instant: Date): { start: Date; end: Date } {
  const start = startOfShopDay(instant);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** [start, end) covering shop days `fromDay` to `toDay` inclusive, each as YYYY-MM-DD. */
export function shopDateRange(
  fromDay: string | undefined,
  toDay: string | undefined
): { start?: Date; end?: Date } {
  const startOfDay = (day: string) => {
    const [year, month, date] = day.split('-').map(Number) as [number, number, number];
    return new Date(Date.UTC(year, month - 1, date) - SHOP_UTC_OFFSET_MINUTES * MINUTE_MS);
  };

  return {
    start: fromDay ? startOfDay(fromDay) : undefined,
    end: toDay ? new Date(startOfDay(toDay).getTime() + DAY_MS) : undefined,
  };
}
