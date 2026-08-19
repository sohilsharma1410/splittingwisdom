# Deploying SplittingWisdom (Phase 1)

Exact click-by-click steps for the three free-tier services this app uses:
**Supabase** (Postgres), **Render** (Express API), **Vercel** (React client).

Do these in order — each later step needs a value produced by an earlier one.

---

## 1. Supabase — database

1. Go to [supabase.com](https://supabase.com) and sign in (GitHub login is easiest).
2. **New project** → pick an organization → name it `splittingwisdom` → set a
   database password (save it somewhere, you'll need it in the connection
   string) → pick the region closest to your friend group → **Create new
   project**. Wait ~2 minutes for provisioning.
3. Once it's ready, go to **Project Settings** (gear icon, bottom left) →
   **Database**.
4. Under **Connection string**, select the **URI** tab, and copy the
   **Transaction pooler** connection string (port `6543`) — this is the one
   the running app should use, since Supabase's free tier direct connection
   has a very low connection limit and Render will otherwise exhaust it.
   It looks like:
   ```
   postgresql://postgres.xxxxxxxxxxxx:[YOUR-PASSWORD]@aws-0-xxxxx.pooler.supabase.com:6543/postgres
   ```
5. Replace `[YOUR-PASSWORD]` with the database password from step 2. This
   full string is your `DATABASE_URL`.
6. Also copy the **Project URL** and the **service_role** key from
   **Project Settings → API** — you won't need these until Phase 3 (receipt
   storage), but grab them now while you're here. Do **not** put the
   service_role key anywhere client-side, ever.

### Run the migration

On your own machine, from the repo root:

```bash
cd server
cp .env.example .env
# edit .env: paste DATABASE_URL (step 5), and set SESSION_SECRET to any long random string
npm run db:migrate
```

This creates all 7 tables (`users`, `groups`, `group_members`, `bills`,
`bill_items`, `item_assignments`, `settlements`) plus the `session` table
(created automatically by `connect-pg-simple` the first time the server
starts). Check the **Table Editor** in Supabase to confirm the tables exist.

---

## 2. Render — API server

1. Go to [render.com](https://render.com) and sign in with GitHub.
2. Push this repo to GitHub if you haven't already (`git remote add origin
   git@github.com:<you>/splittingwisdom.git` then `git push -u origin main`
   — you already have the remote configured, so likely just `git push -u
   origin main`).
3. **New +** → **Web Service** → connect your GitHub account if prompted →
   select the `splittingwisdom` repo.
4. Fill in the form:
   - **Name**: `splittingwisdom-api` (or anything)
   - **Region**: same region you picked for Supabase
   - **Branch**: `main`
   - **Root Directory**: leave **blank** (this is an npm-workspaces
     monorepo — installing from the repo root is what links `/shared`
     correctly)
   - **Runtime**: `Node`
   - **Build Command**:
     ```
     npm install --include=dev && npm run build --workspace=shared && npm run build --workspace=server
     ```
     (`--include=dev` matters: Render sets `NODE_ENV=production` for the
     whole build, and plain `npm install` silently skips devDependencies
     — including `typescript`, `drizzle-kit`, and `tsx` — under that env
     var, which breaks the build in a confusing way. This flag forces them
     in regardless.)
   - **Start Command**:
     ```
     npm run start --workspace=server
     ```
   - **Instance Type**: `Free`
5. Scroll to **Environment Variables** and add:
   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Supabase pooled connection string from step 1.5 |
   | `SESSION_SECRET` | a long random string (e.g. run `openssl rand -hex 32`) |
   | `CLIENT_ORIGIN` | `http://localhost:5173` for now — **you'll update this in step 4** once you have the real Vercel URL |
   | `NODE_ENV` | `production` |
6. **Create Web Service**. Wait for the first deploy to finish (watch the
   logs — you should see `SplittingWisdom API listening on port ...`).
7. Copy the service URL Render gives you, e.g.
   `https://splittingwisdom-api.onrender.com`. Visit
   `https://splittingwisdom-api.onrender.com/api/health` in your browser —
   you should see `{"data":{"status":"ok"}}`.

Render's free tier spins the service down after ~15 minutes of no traffic;
the first request after that takes 30-60 seconds to wake back up. The
client shows a "Waking the server…" message during this, so it's not
broken — just slow the first time. Daily use from you and your friends
naturally keeps it warm.

---

## 3. Vercel — client

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub.
2. **Add New** → **Project** → import the `splittingwisdom` repo.
3. In the import screen:
   - **Root Directory**: click **Edit** → select `client`
   - **Framework Preset**: Vercel should auto-detect **Vite**
   - **Install Command**: override to
     ```
     cd .. && npm install --include=dev
     ```
     (Vercel installs from the `client` directory by default when Root
     Directory is set; this override runs the install from the monorepo
     root instead, so `@splittingwisdom/shared` and every workspace's
     deps are actually present. `--include=dev` matters here too — Vercel
     also sets `NODE_ENV=production` during builds, which silently skips
     devDependencies like `typescript` on plain `npm install`.)
   - **Build Command**: override to
     ```
     cd .. && npm run build --workspace=shared && npm run build --workspace=client
     ```
     (builds `/shared` first — the client imports its compiled output —
     then builds the client itself.)
   - **Output Directory**: leave as `dist` (resolved relative to the
     `client` root directory, i.e. `client/dist`, which is exactly where
     `vite build` writes)
4. Add an **Environment Variable**:
   | Key | Value |
   |---|---|
   | `VITE_API_URL` | the Render URL from step 2.7, e.g. `https://splittingwisdom-api.onrender.com` (no trailing slash) |
5. **Deploy**. Wait for it to finish, then open the URL Vercel gives you,
   e.g. `https://splittingwisdom.vercel.app`.

---

## 4. Connect the two — fix CORS

The API currently only trusts `http://localhost:5173` as an origin. Update it:

1. Back in Render, open your web service → **Environment**.
2. Edit `CLIENT_ORIGIN` to your real Vercel URL from step 3.5, e.g.
   `https://splittingwisdom.vercel.app` (no trailing slash).
3. Save — Render redeploys automatically.

---

## 5. Verify

- Open the Vercel URL. Register an account, create a group, add a bill.
- Open it again in a different browser (or incognito), register a second
  account, join the group via the invite link.
- Confirm balances update live and match the numbers you expect.
- Check the mobile layout on your phone at the Vercel URL — no horizontal
  scroll, bottom nav doesn't cover content.
- Toggle dark mode and reload — it should persist.

If something's wrong, check both **Render → Logs** (server errors) and your
browser's console/network tab (client-side errors, failed API calls).

---

## Redeploying

Both Render and Vercel auto-deploy on every push to `main`. To ship a
schema change: run `npm run db:generate` locally to create a new migration
file, commit it, then run `npm run db:migrate` **against the production
DATABASE_URL** (from a `.env` pointed at Supabase, same as step 1) before
or right after pushing the code that depends on it.
