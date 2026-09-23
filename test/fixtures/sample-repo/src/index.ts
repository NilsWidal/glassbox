import { handleLogin, handleCreateInvoice } from './api/routes.js';

export async function main(): Promise<void> {
  const res = await handleLogin({ email: 'a@example.com', password: 'secret' });
  console.log(res.status, handleCreateInvoice({ headers: {} }, { customerId: 'c1' }).status);
}

main();
