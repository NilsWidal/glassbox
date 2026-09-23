import { chargeCard, type Charge } from './stripeClient.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Retries a failed charge with exponential backoff. No idempotency key, so a
// timeout after a successful charge can bill the customer twice.
export async function retryCharge(cardNumber: string, amountCents: number, attempts = 3): Promise<Charge> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chargeCard(cardNumber, amountCents);
    } catch (err) {
      lastError = err;
      await sleep(2 ** i * 100);
    }
  }
  throw lastError;
}
