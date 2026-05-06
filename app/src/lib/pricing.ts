const LEGACY_USD_PRICE_LIMIT = 1000;
const LEGACY_USD_TO_NGN_RATE = 1150;

export function resolveStoredPlanPriceNGN(value: number | string | null | undefined): number {
  const storedPrice = Math.max(0, Number(value) || 0);

  // Existing plan rows used to store USD-style values. New edits store the Naira amount directly.
  if (storedPrice > 0 && storedPrice < LEGACY_USD_PRICE_LIMIT) {
    return Math.round(storedPrice * LEGACY_USD_TO_NGN_RATE);
  }

  return Math.round(storedPrice);
}

export function formatNaira(amount: number): string {
  return `₦${Math.round(Number(amount || 0)).toLocaleString()}`;
}
