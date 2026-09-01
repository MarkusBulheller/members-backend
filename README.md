# W2W Racing — Members Backend

NestJS + TypeORM + PostgreSQL API for the W2W Racing members portal (driver profiles/achievements, event creation/signup, car & livery management). Login-gated, invite-only, authenticated entirely via **Discord OAuth**.

## Prerequisites

1. **PostgreSQL** running locally — or point `DATABASE_URL` at any Postgres instance you already have. `docker-compose.yml` is included for anyone who *can* run Docker, but on machines without virtualization support, a native PostgreSQL for Windows install (postgresql.org, or `winget install PostgreSQL.PostgreSQL.17`) works just as well.
2. **A Discord Application** — go to [discord.com/developers/applications](https://discord.com/developers/applications):
   - Create a New Application.
   - Under **OAuth2 → General**, add a redirect: `http://localhost:3001/auth/discord/callback`.
   - Copy the **Client ID** and **Client Secret** (Reset Secret if needed).
   - Get your team's Discord **Guild ID**: in Discord, enable Developer Mode (User Settings → Advanced), then right-click your server icon → **Copy Server ID**.

## Setup

```bash
cp .env.example .env
# then fill in DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_GUILD_ID, and a real JWT_SECRET

# Postgres via Docker:
docker compose up -d

# — or, with a native Postgres install, create the app's user/database once:
#   psql -U postgres -c "CREATE USER w2w WITH PASSWORD 'w2w_dev';"
#   psql -U postgres -c "CREATE DATABASE w2w_members OWNER w2w;"

npm install
npm run start:dev         # http://localhost:3001, schema auto-synced in dev
```

## Bootstrapping the first admin

There's no admin to approve the very first account, so:

1. Start the `members-portal` frontend and sign in with Discord once (you'll land on `/pending-approval` — that's expected, the account now exists as `PENDING`).
2. Run:
   ```bash
   npm run seed:admin -- --discordId=<your discord user id>
   ```
   (Find your Discord user ID the same way as the Guild ID — Developer Mode → right-click your own name → Copy User ID.)
3. Sign in again — you're now an approved admin.

Every subsequent member registers the same way (sign in with Discord) and gets approved from `/admin/members` in the portal.

## Notes

- `synchronize: true` is enabled outside of `NODE_ENV=production` — the schema auto-updates from the entities in dev. Replace with real TypeORM migrations before ever pointing this at a production database.
- Uploaded livery images are written to `./uploads/liveries` on local disk and served at `/uploads/liveries/...`. This is fine for local dev; a real deployment (Railway/Render/etc.) needs a persistent volume mounted there, since the local filesystem is ephemeral on redeploy.
