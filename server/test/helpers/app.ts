import request from "supertest";
import type { Express } from "express";
import { createServer, type Server } from "node:http";

let cached: Express | undefined;
let server: Server | undefined;

/** One shared listening server so supertest doesn't open a new one per request. */
export function httpServer(app: Express): Server {
  if (!server) {
    server = createServer(app).listen(0, "127.0.0.1");
    server.setMaxListeners(0); // supertest agents attach listeners per request
  }
  return server;
}

/** The real Express app (all middleware + routes), not bound to any port. */
export async function getApp(): Promise<Express> {
  if (!cached) cached = (await import("../../src/index.js")).app;
  return cached;
}

export type TestUser = {
  agent: ReturnType<typeof request.agent>;
  id: number;
  email: string;
  displayName: string;
};

let counter = 0;

/** Registers a fresh user through the real endpoint; the agent keeps the session cookie. */
export async function registerUser(app: Express, displayName: string): Promise<TestUser> {
  counter += 1;
  const email = `${displayName.toLowerCase()}-${Date.now()}-${counter}@example.test`;
  const agent = request.agent(httpServer(app));
  const res = await agent
    .post("/api/auth/register")
    .send({ email, displayName, password: "correct horse battery" });
  if (res.status !== 201) {
    throw new Error(`register failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return { agent, id: res.body.data.user.id, email, displayName };
}

/** Creates a group as `owner`; returns the group and the owner's member id. */
export async function createGroup(owner: TestUser, name = "Trip") {
  const res = await owner.agent.post("/api/groups").send({ name });
  if (res.status !== 201) throw new Error(`createGroup failed: ${JSON.stringify(res.body)}`);
  const groupId: number = res.body.data.group.id;
  const detail = await owner.agent.get(`/api/groups/${groupId}`);
  const members: { id: number; userId: number | null }[] =
    detail.body.data.group?.members ?? detail.body.data.members ?? [];
  const me = members.find((m) => m.userId === owner.id);
  if (!me) throw new Error(`could not find owner member: ${JSON.stringify(detail.body)}`);
  return { groupId, memberId: me.id };
}

/** A minimal valid create-bill body: one item, split equally among `memberIds`. */
export function billBody(opts: {
  groupId: number;
  paidByMemberId: number;
  memberIds: number[];
  description?: string;
  price?: number;
}) {
  return {
    groupId: opts.groupId,
    description: opts.description ?? "Dinner",
    billDate: "2026-11-01",
    subtotalAmount: opts.price ?? 30000,
    taxAmount: 0,
    tipAmount: 0,
    serviceFeeAmount: 0,
    discountAmount: 0,
    paidByMemberId: opts.paidByMemberId,
    items: [
      {
        name: "Thali",
        price: opts.price ?? 30000,
        quantity: 1,
        assignments: opts.memberIds.map((memberId) => ({ memberId, splitType: "equal" as const })),
      },
    ],
  };
}
