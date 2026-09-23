export interface Charge {
  id: string;
  amountCents: number;
  status: 'succeeded' | 'failed';
}

export async function chargeCard(cardNumber: string, amountCents: number): Promise<Charge> {
  // Risky: logs the full card number.
  console.log(`charging card ${cardNumber} for ${amountCents}`);
  if (amountCents <= 0) throw new Error('amount must be positive');
  return { id: `ch_${Date.now()}`, amountCents, status: 'succeeded' };
}

export async function refund(chargeId: string): Promise<boolean> {
  return chargeId.startsWith('ch_');
}
