import { check, load } from '../ts.mjs';

const { InvoiceService } = await load('src/billing/invoice.ts');
const s = new InvoiceService();
check(s.applyDiscount(100, 150) === 0, `applyDiscount(100, 150) should be 0, got ${s.applyDiscount(100, 150)}`);
check(s.applyDiscount(100, -10) === 100, `applyDiscount(100, -10) should be 100, got ${s.applyDiscount(100, -10)}`);
check(s.applyDiscount(200, 25) === 150, `applyDiscount(200, 25) should be 150, got ${s.applyDiscount(200, 25)}`);
check(s.applyDiscount(80, 100) === 0, `applyDiscount(80, 100) should be 0`);
