import { Router } from "express";
import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import {
  registerSchema,
  loginSchema,
  updateProfileSchema,
  changePasswordSchema,
  users,
} from "@splittingwisdom/shared";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { isUniqueViolation } from "../lib/pg-errors.js";
import { rateLimit } from "../middleware/rate-limit.js";

const router = Router();
const BCRYPT_ROUNDS = 12;

function toPublicUser(user: {
  id: number;
  email: string;
  displayName: string;
  phone: string | null;
  createdAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    phone: user.phone,
    createdAt: user.createdAt,
  };
}

router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0].message } });
    return;
  }
  const { email, displayName, password } = parsed.data;

  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const [user] = await db
      .insert(users)
      .values({ email, displayName, passwordHash })
      .returning();

    req.session.userId = user.id;
    res.status(201).json({ data: { user: toPublicUser(user) } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res
        .status(409)
        .json({ error: { message: "An account with that email already exists." } });
      return;
    }
    throw err;
  }
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0].message } });
    return;
  }
  const { email, password } = parsed.data;

  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  const invalidCredentialsMessage = "Incorrect email or password.";
  if (!user) {
    res.status(401).json({ error: { message: invalidCredentialsMessage } });
    return;
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    res.status(401).json({ error: { message: invalidCredentialsMessage } });
    return;
  }

  req.session.userId = user.id;
  res.json({ data: { user: toPublicUser(user) } });
});

router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      res.status(500).json({ error: { message: "Could not log out. Try again." } });
      return;
    }
    res.clearCookie("connect.sid");
    res.json({ data: { success: true } });
  });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await db.query.users.findFirst({
    where: eq(users.id, req.session.userId!),
  });

  if (!user) {
    req.session.destroy(() => {});
    res.status(401).json({ error: { message: "You need to be logged in." } });
    return;
  }

  res.json({ data: { user: toPublicUser(user) } });
});

router.patch("/me", requireAuth, async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0].message } });
    return;
  }

  try {
    const [user] = await db
      .update(users)
      .set(parsed.data)
      .where(eq(users.id, req.session.userId!))
      .returning();
    res.json({ data: { user: toPublicUser(user) } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: { message: "That phone number is already in use." } });
      return;
    }
    throw err;
  }
});

router.post(
  "/change-password",
  requireAuth,
  rateLimit({ max: 5, windowMs: 15 * 60 * 1000 }),
  async (req, res) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.issues[0].message } });
      return;
    }
    const { currentPassword, newPassword } = parsed.data;

    const user = await db.query.users.findFirst({
      where: eq(users.id, req.session.userId!),
    });
    if (!user) {
      res.status(401).json({ error: { message: "You need to be logged in." } });
      return;
    }

    const currentMatches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!currentMatches) {
      res.status(401).json({ error: { message: "Current password is incorrect." } });
      return;
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    res.json({ data: { success: true } });
  },
);

export default router;
