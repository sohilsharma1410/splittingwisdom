import type postgres from "postgres";

/** Plain-SQL seed helpers (no app code), usable against any node. */

type Sql = postgres.Sql | postgres.TransactionSql;

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export async function insertUser(sql: Sql, name = "User") {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO users (email, password_hash, display_name)
    VALUES (${`${name.toLowerCase()}-${uniq()}@example.test`}, 'x', ${name})
    RETURNING id`;
  return row.id;
}

export interface SeededTree {
  userId: number;
  groupId: number;
  memberId: number;
  member2Id: number;
  billId: number;
  itemId: number;
  assignmentId: number;
  settlementId: number;
}

/** user -> group -> 2 members -> bill -> item -> assignment -> settlement. */
export async function seedTree(sql: Sql, label = "T"): Promise<SeededTree> {
  const userId = await insertUser(sql, label);
  const [g] = await sql<{ id: number }[]>`
    INSERT INTO groups (name, created_by, invite_token)
    VALUES (${`${label} group`}, ${userId}, ${`tok-${uniq()}`}) RETURNING id`;
  const [m1] = await sql<{ id: number }[]>`
    INSERT INTO group_members (group_id, user_id, display_name)
    VALUES (${g.id}, ${userId}, ${label}) RETURNING id`;
  const [m2] = await sql<{ id: number }[]>`
    INSERT INTO group_members (group_id, user_id, display_name)
    VALUES (${g.id}, NULL, ${`${label} guest`}) RETURNING id`;
  const [b] = await sql<{ id: number }[]>`
    INSERT INTO bills (group_id, description, bill_date, subtotal_amount, paid_by_member_id, created_by_user_id)
    VALUES (${g.id}, 'Dinner', '2026-11-01', 10000, ${m1.id}, ${userId}) RETURNING id`;
  const [i] = await sql<{ id: number }[]>`
    INSERT INTO bill_items (bill_id, name, price) VALUES (${b.id}, 'Thali', 10000) RETURNING id`;
  const [a] = await sql<{ id: number }[]>`
    INSERT INTO item_assignments (bill_item_id, member_id) VALUES (${i.id}, ${m2.id}) RETURNING id`;
  const [s] = await sql<{ id: number }[]>`
    INSERT INTO settlements (group_id, payer_member_id, recipient_member_id, amount, settlement_date)
    VALUES (${g.id}, ${m2.id}, ${m1.id}, 2500, now()) RETURNING id`;
  return {
    userId,
    groupId: g.id,
    memberId: m1.id,
    member2Id: m2.id,
    billId: b.id,
    itemId: i.id,
    assignmentId: a.id,
    settlementId: s.id,
  };
}
