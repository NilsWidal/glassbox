export function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

export const formatDate = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
