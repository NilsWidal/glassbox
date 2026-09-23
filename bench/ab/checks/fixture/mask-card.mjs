/* global console */
import { check, load } from '../ts.mjs';

const { chargeCard } = await load('src/billing/stripeClient.ts');
const lines = [];
const orig = console.log;
console.log = (...args) => lines.push(args.join(' '));
let charge;
try {
  charge = await chargeCard('4242424242421234', 500);
} finally {
  console.log = orig;
}
const out = lines.join('\n');
check(lines.length > 0, 'chargeCard should still log the charge');
check(!out.includes('424242424242'), `the log must not contain the full card number: ${out}`);
check(out.includes('1234'), `the log should keep the last 4 digits: ${out}`);
check(out.includes('500'), `the log should keep the amount: ${out}`);
check(charge && charge.status === 'succeeded' && charge.amountCents === 500, 'chargeCard should still return the charge');
