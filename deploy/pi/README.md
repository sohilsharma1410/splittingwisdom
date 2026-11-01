# SplittingWisdom on the Pi

Runs Postgres 17 and the API plus web app in Docker. Tailscale runs on the host and
Funnel connects to `127.0.0.1:4000`. Assumes the host setup from
`PLAN-PI-PRODUCTIONIZATION.md` (P0, P1, P5.1) is done. Commands below run on the Pi.
Current status and open items are in `docs/PI-STATUS.md`.

## First start (M1)

This uses an empty database and doesn't connect to Supabase or go public.

```bash
cd ~/splittingwisdom/deploy/pi
cp .env.example .env
chmod 600 .env
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" .env
sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" .env

docker compose build      # about 10 minutes the first time
docker compose up -d
docker compose ps         # postgres and api healthy; migrate exited (0)
./smoke.sh                # QA-1
```

Then start the stack automatically at boot:

```bash
sed "s|@DEPLOY_DIR@|$PWD|" splittingwisdom.service | sudo tee /etc/systemd/system/splittingwisdom.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable splittingwisdom
sudo reboot
```

After the reboot, `docker compose ps` should show everything healthy again without
you starting anything.

## Rehearse the Supabase migration (M2)

This copies real user data to the Pi and only reads from Supabase, so nobody on the
current app is affected. It's a rehearsal: nothing on the Pi counts as the real data
until the cutover (P4.5). Keep Funnel off until the copy is wiped; the script
refuses to run while Funnel is on.

**You need:** the Supabase session pooler URL, from the dashboard under **Connect →
Session pooler** (port `5432`). Put your database password in it, percent-encoding
any special characters.

```bash
cd ~/splittingwisdom/deploy/pi
git pull
docker compose build
docker compose up -d

# Wipes the Pi's database and receipts, so only while there's no real data here.
docker compose down -v
docker compose up -d

./copy-from-supabase.sh    # asks for the URL (hidden); ends with RESULT: OK
./smoke.sh                 # the app works on the copy
```

Row differences can be a false alarm if someone used the live app between the dump
and the comparison. To retry, wipe the database and run the script again.

Then remove everything real from the Pi:

```bash
docker compose down -v
docker compose up -d
rm -rf ~/splittingwisdom-migration
```

The dump holds real user data, including password hashes, so don't leave it around
or copy it elsewhere.

## Go public with Funnel (M3)

```bash
sudo tailscale funnel --bg --https=443 localhost:4000
sudo tailscale funnel status    # shows the public URL
sudo tailscale funnel reset     # turns it off
```

Funnel stays on after a reboot until you reset it.

- **What the public can reach:** only this app on port 443, which is the web app and
  its API. SSH, Postgres and the tailnet's other devices aren't exposed.
- **Registration is open:** anyone with the URL can create an account while Funnel is on.
- **Limits:** Funnel only allows ports 443, 8443 and 10000. Its bandwidth is limited by
  an undisclosed amount, which should be fine for a friend group.
- **Failover:** stays off until the failover URLs are built in (plan D17).

## Look inside the database

Open a read-only shell, so nothing can change by accident:

```bash
cd ~/splittingwisdom/deploy/pi
docker compose exec -e PGOPTIONS='-c default_transaction_read_only=on' postgres psql -U splittingwisdom -d splittingwisdom
```

```sql
\dt
\d bills
SELECT id, display_name, email, created_at FROM users ORDER BY id;
SELECT id, name, created_at FROM groups ORDER BY id;
SELECT id, group_id, description, bill_date, subtotal_amount FROM bills ORDER BY id DESC LIMIT 20;
\q
```

Amounts are in paise, so `10000` means ₹100.00. Balances aren't stored in any table:
the app works them out when needed. Avoid `SELECT *` on `users` and `session` when
sharing output, because they hold password hashes and login sessions.

## OCR speed test

A temporary test for the local OCR plan (plan D18). Scans run with no network access, so
photos can't leave the Pi.

```bash
cd ~/splittingwisdom/deploy/pi/ocr-spike
./run.sh public    # public sample receipts, also scores accuracy
./run.sh           # your own photos from ~/ocr-test
```

Results go to `~/ocr-test-results`. Keep your own photos out of the repo, because it's public.

## Day to day

| To | Run |
|---|---|
| See status | `docker compose ps` |
| Read logs | `docker compose logs -f api` |
| Deploy new code | `git pull && docker compose build && docker compose up -d` |
| Stop or start | `sudo systemctl stop splittingwisdom` / `start` |
| Open a database shell that can write | `docker compose exec postgres psql -U splittingwisdom` |

After `build`, `up -d` recreates what changed and reruns migrations first. If a
deploy fails, check `docker compose logs migrate api`.

## Good to know

- **Ports:** keep the API on `127.0.0.1:4000` and never publish Postgres. Docker's
  published ports bypass ufw.
- **Secure cookies:** login cookies need HTTPS, so logging in through a browser
  won't work over plain `http://` or an SSH tunnel. Use the Funnel URL. `smoke.sh`
  sends the header Funnel would send, so it works locally.
- **Sync stays off until M4:** `APP_ROLE`, `SYNC_TARGET_DATABASE_URL` and the `sync`
  profile connect this node to the real Supabase database.
- **Receipts:** they live in the `receipts` volume and aren't copied to the standby
  yet (plan S2.5), so they won't show during an outage.
