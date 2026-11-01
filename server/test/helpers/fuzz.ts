import type postgres from "postgres";
import type { Rng } from "./sync.js";

/**
 * Random but realistic write traffic straight against Postgres (the same
 * statements the app's routes boil down to), so sync tests can run thousands
 * of operations quickly. Operations that legitimately fail (FK/unique) are
 * swallowed — they are part of the traffic mix.
 */

type Sql = postgres.Sql;

export interface FuzzCtx {
  sql: Sql;
  rng: Rng;
  /** Unique-suffix counter so emails / invite tokens never collide. */
  counter: { n: number };
  /** Added to every generated unique string; keep distinct per node. */
  tag: string;
}

async function pickId(sql: Sql, rng: Rng, table: string, where = "true"): Promise<number | null> {
  const [{ n }] = await sql.unsafe(`SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`);
  if (n === 0) return null;
  const [row] = await sql.unsafe(`SELECT id FROM "${table}" WHERE ${where} ORDER BY id OFFSET ${rng.int(n)} LIMIT 1`);
  return row.id as number;
}

const uniq = (c: FuzzCtx) => `${c.tag}${c.counter.n++}`;

async function createUser(c: FuzzCtx) {
  const u = uniq(c);
  await c.sql`INSERT INTO users (email, password_hash, display_name) VALUES (${`u${u}@fuzz.test`}, 'h', ${`User ${u}`})`;
}

async function createGroup(c: FuzzCtx) {
  const userId = await pickId(c.sql, c.rng, "users");
  if (!userId) return createUser(c);
  const u = uniq(c);
  await c.sql.begin(async (tx) => {
    const [g] = await tx<{ id: number }[]>`
      INSERT INTO groups (name, created_by, invite_token) VALUES (${`G${u}`}, ${userId}, ${`t${u}`}) RETURNING id`;
    await tx`INSERT INTO group_members (group_id, user_id, display_name) VALUES (${g.id}, ${userId}, ${`M${u}`})`;
  });
}

async function addMember(c: FuzzCtx) {
  const groupId = await pickId(c.sql, c.rng, "groups");
  if (!groupId) return createGroup(c);
  const guest = c.rng.chance(0.3);
  const userId = guest ? null : await pickId(c.sql, c.rng, "users");
  await c.sql`INSERT INTO group_members (group_id, user_id, display_name) VALUES (${groupId}, ${userId}, ${`Mem ${uniq(c)}`})`;
}

async function createBill(c: FuzzCtx) {
  const groupId = await pickId(c.sql, c.rng, "groups", `id IN (SELECT group_id FROM group_members)`);
  if (!groupId) return addMember(c);
  const members = await c.sql<{ id: number }[]>`SELECT id FROM group_members WHERE group_id = ${groupId} ORDER BY id`;
  const [creator] = await c.sql<{ id: number }[]>`SELECT created_by AS id FROM groups WHERE id = ${groupId}`;
  const payer = c.rng.pick(members).id;
  const itemCount = 1 + c.rng.int(3);
  await c.sql.begin(async (tx) => {
    const [b] = await tx<{ id: number }[]>`
      INSERT INTO bills (group_id, description, bill_date, subtotal_amount, tax_amount, paid_by_member_id, created_by_user_id)
      VALUES (${groupId}, ${`Bill ${uniq(c)}`}, '2026-11-01', ${100 + c.rng.int(50_000)}, ${c.rng.int(500)}, ${payer}, ${creator.id})
      RETURNING id`;
    for (let i = 0; i < itemCount; i++) {
      const [item] = await tx<{ id: number }[]>`
        INSERT INTO bill_items (bill_id, name, price, sort_order)
        VALUES (${b.id}, ${`Item ${i}`}, ${50 + c.rng.int(10_000)}, ${i}) RETURNING id`;
      const share = members.filter(() => c.rng.chance(0.6));
      for (const m of share.length ? share : [members[0]]) {
        await tx`INSERT INTO item_assignments (bill_item_id, member_id) VALUES (${item.id}, ${m.id})`;
      }
    }
  });
}

async function updateBill(c: FuzzCtx) {
  const id = await pickId(c.sql, c.rng, "bills");
  if (!id) return createBill(c);
  await c.sql`UPDATE bills SET description = ${`Edited ${uniq(c)}`}, tip_amount = ${c.rng.int(900)}, last_edited_at = now() WHERE id = ${id}`;
}

async function updateItem(c: FuzzCtx) {
  const id = await pickId(c.sql, c.rng, "bill_items");
  if (!id) return createBill(c);
  await c.sql`UPDATE bill_items SET price = ${50 + c.rng.int(10_000)}, name = ${`Renamed ${uniq(c)}`} WHERE id = ${id}`;
}

async function updateUser(c: FuzzCtx) {
  const id = await pickId(c.sql, c.rng, "users");
  if (!id) return createUser(c);
  await c.sql`UPDATE users SET display_name = ${`Name ${uniq(c)}`} WHERE id = ${id}`;
}

async function updateGroup(c: FuzzCtx) {
  const id = await pickId(c.sql, c.rng, "groups");
  if (!id) return createGroup(c);
  await c.sql`UPDATE groups SET name = ${`Group ${uniq(c)}`} WHERE id = ${id}`;
}

async function deleteAssignment(c: FuzzCtx) {
  const id = await pickId(c.sql, c.rng, "item_assignments");
  if (id) await c.sql`DELETE FROM item_assignments WHERE id = ${id}`;
}

async function deleteBill(c: FuzzCtx) {
  const id = await pickId(c.sql, c.rng, "bills");
  if (id) await c.sql`DELETE FROM bills WHERE id = ${id}`;
}

async function createSettlement(c: FuzzCtx) {
  const groupId = await pickId(c.sql, c.rng, "groups", `id IN (SELECT group_id FROM group_members GROUP BY group_id HAVING count(*) >= 2)`);
  if (!groupId) return addMember(c);
  const members = await c.sql<{ id: number }[]>`SELECT id FROM group_members WHERE group_id = ${groupId} ORDER BY id`;
  const payer = c.rng.pick(members).id;
  const recipient = c.rng.pick(members.filter((m) => m.id !== payer)).id;
  await c.sql`
    INSERT INTO settlements (group_id, payer_member_id, recipient_member_id, amount, note, settlement_date)
    VALUES (${groupId}, ${payer}, ${recipient}, ${100 + c.rng.int(20_000)}, ${`s${uniq(c)}`}, now())`;
}

async function deleteSettlement(c: FuzzCtx) {
  const id = await pickId(c.sql, c.rng, "settlements");
  if (id) await c.sql`DELETE FROM settlements WHERE id = ${id}`;
}

async function removeMember(c: FuzzCtx) {
  const id = await pickId(c.sql, c.rng, "group_members");
  if (id) await c.sql`DELETE FROM group_members WHERE id = ${id}`; // usually blocked by FKs: fine
}

async function deleteGroup(c: FuzzCtx) {
  const id = await pickId(c.sql, c.rng, "groups");
  if (!id) return;
  // Same order as DELETE /api/groups/:id.
  await c.sql.begin(async (tx) => {
    await tx`DELETE FROM bills WHERE group_id = ${id}`;
    await tx`DELETE FROM settlements WHERE group_id = ${id}`;
    await tx`DELETE FROM groups WHERE id = ${id}`;
  });
}

const OPS: [number, (c: FuzzCtx) => Promise<void>][] = [
  [10, createUser],
  [8, createGroup],
  [8, addMember],
  [26, createBill],
  [12, updateBill],
  [6, updateItem],
  [6, updateUser],
  [4, updateGroup],
  [4, deleteAssignment],
  [6, deleteBill],
  [8, createSettlement],
  [4, deleteSettlement],
  [3, removeMember],
  [2, deleteGroup],
];
const TOTAL_WEIGHT = OPS.reduce((s, [w]) => s + w, 0);

/** Runs one random operation; returns false if it failed with an expected constraint error. */
export async function randomOp(c: FuzzCtx): Promise<boolean> {
  let roll = c.rng.int(TOTAL_WEIGHT);
  for (const [weight, op] of OPS) {
    if (roll < weight) {
      try {
        await op(c);
        return true;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "23503" || code === "23505") return false; // FK / unique: expected
        throw err;
      }
    }
    roll -= weight;
  }
  return false;
}
