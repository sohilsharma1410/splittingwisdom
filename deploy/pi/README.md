# SplittingWisdom on the Pi

Runs Postgres 17 and the API plus web app in Docker. Tailscale runs on the host and
Funnel connects to `127.0.0.1:4000`. Assumes the host setup from
`PLAN-PI-PRODUCTIONIZATION.md` (P0, P1, P5.1) is done. Commands below run on the Pi.

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

## Day to day

| To | Run |
|---|---|
| See status | `docker compose ps` |
| Read logs | `docker compose logs -f api` |
| Deploy new code | `git pull && docker compose build && docker compose up -d` |
| Stop or start | `sudo systemctl stop splittingwisdom` / `start` |
| Open a database shell | `docker compose exec postgres psql -U splittingwisdom` |

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
