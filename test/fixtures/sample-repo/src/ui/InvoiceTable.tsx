import { formatCurrency, formatDate } from './format';
import type { Invoice } from '../billing/invoice';

interface Props {
  invoices: Invoice[];
  total: (invoice: Invoice) => number;
}

export function InvoiceTable({ invoices, total }: Props) {
  return (
    <table>
      <tbody>
        {invoices.map((inv) => (
          <tr key={inv.id}>
            <td>{inv.id}</td>
            <td>{formatDate(Number(inv.id.slice(4)))}</td>
            <td>{formatCurrency(total(inv))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
