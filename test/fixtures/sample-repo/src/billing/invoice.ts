import { insert } from '../db.js';
import { retryCharge } from './retry.js';

export interface LineItem {
  description: string;
  unitPrice: number;
  quantity: number;
}

export interface Invoice {
  id: string;
  customerId: string;
  items: LineItem[];
  discountPercent: number;
}

export class InvoiceService {
  // Risky: money as floating point dollars.
  computeTotal(invoice: Invoice): number {
    const subtotal = invoice.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    return this.applyDiscount(subtotal, invoice.discountPercent);
  }

  applyDiscount(amount: number, percent: number): number {
    // No bounds check: a percent above 100 gives a negative total.
    return amount - (amount * percent) / 100;
  }

  createInvoice(customerId: string, items: LineItem[]): Invoice {
    const invoice = { id: `inv_${Date.now()}`, customerId, items, discountPercent: 0 };
    insert('invoices', { ...invoice });
    return invoice;
  }

  async pay(invoice: Invoice, cardNumber: string): Promise<boolean> {
    const total = this.computeTotal(invoice);
    const charge = await retryCharge(cardNumber, Math.round(total * 100));
    return charge.status === 'succeeded';
  }
}
