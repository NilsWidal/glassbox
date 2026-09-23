import { requireAuth, requireAdmin, type Request } from '../auth/middleware.js';
import { login } from '../auth/session.js';
import { InvoiceService } from '../billing/invoice.js';
import { query } from '../db.js';

const invoices = new InvoiceService();

export async function handleLogin(body: { email: string; password: string }) {
  const session = await login(body.email, body.password);
  return session ? { status: 200, token: session.token } : { status: 401 };
}

export function handleCreateInvoice(req: Request, body: { customerId: string }) {
  let result = { status: 401 } as { status: number; id?: string };
  requireAuth(req, () => {
    const invoice = invoices.createInvoice(body.customerId, []);
    result = { status: 201, id: invoice.id };
  });
  return result;
}

// Risky: admin search passes the raw search term into SQL.
export function handleAdminSearch(req: Request, term: string) {
  let rows: unknown[] = [];
  requireAdmin(req, () => {
    rows = query(`SELECT * FROM invoices WHERE customer LIKE '%${term}%'`);
  });
  return rows;
}
