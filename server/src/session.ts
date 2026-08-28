import session from "express-session";
import connectPgSimple from "connect-pg-simple";

const PgSession = connectPgSimple(session);

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  throw new Error("SESSION_SECRET is not set. Copy server/.env.example to server/.env and fill it in.");
}

const isProduction = process.env.NODE_ENV === "production";

export const sessionMiddleware = session({
  store: new PgSession({
    // connect-pg-simple builds its own `pg` Pool from this and does not
    // parse sslmode out of a bare connection string the way some other
    // clients do — without an explicit ssl option here, connecting to
    // Supabase's pooler is unreliable (works sometimes, fails silently
    // other times depending on how pg negotiates the connection).
    conObject: {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    },
    tableName: "session",
    createTableIfMissing: true,
  }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
});

declare module "express-session" {
  interface SessionData {
    userId: number;
  }
}
