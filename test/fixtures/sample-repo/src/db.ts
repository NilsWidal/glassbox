export interface Row {
  [column: string]: unknown;
}

const rows = new Map<string, Row[]>();

// Risky: the SQL text is built by string concatenation from caller input.
export function query(sql: string): Row[] {
  const table = sql.split(' FROM ')[1]?.split(' ')[0] ?? '';
  return rows.get(table) ?? [];
}

export function findUserByEmail(email: string): Row | undefined {
  return query("SELECT * FROM users WHERE email = '" + email + "'")[0];
}

export function insert(table: string, row: Row): void {
  const list = rows.get(table) ?? [];
  list.push(row);
  rows.set(table, list);
}
