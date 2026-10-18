# Deploying the W2W members portal and backend

Server layout this guide assumes (from the existing setup):

- Backend: `/opt/w2w/members-backend` (branch `master`), runs as the `members-backend` systemd service, user `w2w`.
- Portal: `/opt/w2w/members-portal` (branch `main`), a static build served by nginx. No restart needed.
- nginx serves `api.wheel2wheel.racing` and proxies it to the backend on `127.0.0.1:3001`.
- The public site (`frontend`) is not part of this release.

Pick a quiet moment, not during a live race. The backend restart takes a few seconds, and open planner pages show "Reconnecting…" briefly.

---

## Step 0. On your own machine: commit and push

Push both repos (backend branch `master`, portal branch `main`). The server can only pull what is on GitHub.

## Step 1. On the server: back up the database

```bash
sudo -u postgres pg_dump <dbname> > ~/w2w-backup-$(date +%F).sql
```

## Step 2. Optional settings (skip if you don't need them)

Backend, `/opt/w2w/members-backend/.env`:

```
DISCORD_INVITE_URL=https://discord.gg/xxxxxxx
```

Shows an "Ask in Discord" button on the "waiting for approval" screen. Without it the button is hidden.

Portal, `/opt/w2w/members-portal/.env` (read when the portal is built, so set it before step 7):

```
VITE_PUBLIC_SITE_URL=https://wheel2wheel.racing
```

Shows the website link and the "Get in touch" panel on shared race results. Without it they are hidden.

## Step 3. Backend: pull and build

This also installs the new `compression` package.

```bash
sudo -u w2w bash -c 'cd /opt/w2w/members-backend && git pull && npm ci && npm run build'
```

## Step 4. Database changes (new columns and indexes)

Production does not update its own database structure, so do this one-time bootstrap. It creates every new column and index, and anything else from earlier releases that production is still missing.

```bash
cd /opt/w2w/members-backend
```

```bash
sudo -u w2w env NODE_ENV=development node dist/main.js
```

Wait for "Nest application successfully started", then press Ctrl+C.

### Alternative: run the SQL yourself

Use this instead of the bootstrap if you prefer to see exactly what changes. Every statement is safe to run twice. Run it as the database owner, for example `sudo -u postgres psql <dbname>`.

```sql
ALTER TABLE events ADD COLUMN IF NOT EXISTS tyre_limit integer NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS discord_message_id varchar NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS discord_channel_id varchar NULL;
ALTER TABLE event_team_stints ADD COLUMN IF NOT EXISTS tyres_changed smallint NULL;
ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS partial_tyre_change_seconds numeric(6,2) NULL;
ALTER TABLE team_highlights ADD COLUMN IF NOT EXISTS position integer NULL;

CREATE INDEX IF NOT EXISTS idx_race_result_laps_race_result_id ON race_result_laps (race_result_id);
CREATE INDEX IF NOT EXISTS idx_race_result_laps_driver_profile_id ON race_result_laps (driver_profile_id);
CREATE INDEX IF NOT EXISTS idx_race_result_driver_stints_race_result_id ON race_result_driver_stints (race_result_id);
CREATE INDEX IF NOT EXISTS idx_race_result_driver_stints_driver_profile_id ON race_result_driver_stints (driver_profile_id);
CREATE INDEX IF NOT EXISTS idx_race_results_car_id ON race_results (car_id);
CREATE INDEX IF NOT EXISTS idx_race_results_track_id ON race_results (track_id);
CREATE INDEX IF NOT EXISTS idx_race_results_start_time ON race_results (start_time);
CREATE INDEX IF NOT EXISTS idx_event_timeslots_event_id ON event_timeslots (event_id);
CREATE INDEX IF NOT EXISTS idx_event_teams_event_id ON event_teams (event_id);
CREATE INDEX IF NOT EXISTS idx_event_team_stints_event_team_id ON event_team_stints (event_team_id);
CREATE INDEX IF NOT EXISTS idx_event_team_stints_driver_user_id ON event_team_stints (driver_user_id);
CREATE INDEX IF NOT EXISTS idx_event_team_dummy_drivers_event_team_id ON event_team_dummy_drivers (event_team_id);
CREATE INDEX IF NOT EXISTS idx_event_signups_user_id ON event_signups (user_id);
CREATE INDEX IF NOT EXISTS idx_event_signups_event_team_id ON event_signups (event_team_id);
CREATE INDEX IF NOT EXISTS idx_achievement_awards_tier_id ON achievement_awards (tier_id);
CREATE INDEX IF NOT EXISTS idx_achievement_tiers_definition_id ON achievement_tiers (definition_id);
CREATE INDEX IF NOT EXISTS idx_liveries_car_id ON liveries (car_id);
CREATE INDEX IF NOT EXISTS idx_car_track_setups_track_id ON car_track_setups (track_id);
CREATE INDEX IF NOT EXISTS idx_events_starts_at ON events (starts_at);
```

## Step 5. Restart the backend

```bash
sudo systemctl restart members-backend
```

Check that it started cleanly (no red errors):

```bash
sudo journalctl -u members-backend -n 60 --no-pager
```

## Step 6. nginx: let the live planner through

The live stint planner keeps a connection open and sends small updates through it. nginx must not hold those updates back, and the connection should be HTTP/2 so several open tabs don't use up the browser's connection limit.

1. Find the file for the API domain:

   ```bash
   sudo grep -ln "api.wheel2wheel.racing" /etc/nginx/sites-enabled/*
   ```

2. Open it (use the path printed above):

   ```bash
   sudo nano <path from the previous command>
   ```

3. In the first `server { ... }` block, directly **above** the existing `location / {`, add:

   ```nginx
       # Live stint planner: a long-lived stream that must not be buffered.
       location ~ ^/events/[^/]+/teams/[^/]+/stream$ {
           proxy_pass http://127.0.0.1:3001;
           proxy_http_version 1.1;
           proxy_set_header Connection '';
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_buffering off;
           proxy_cache off;
           gzip off;
           proxy_read_timeout 1h;
       }
   ```

4. In the same block, change

   ```nginx
       listen 443 ssl; # managed by Certbot
   ```

   to

   ```nginx
       listen 443 ssl http2; # managed by Certbot
   ```

   (Newer nginx versions may print a harmless warning about this line. It still works.)

5. Save in nano with Ctrl+O, Enter, Ctrl+X. Then test and reload:

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

   `nginx -t` checks the file first. If it reports an error, nothing is reloaded and the old config keeps running.

Leave `client_max_body_size 10m;` and the Certbot lines as they are.

## Step 7. Members portal: pull and build

A static rebuild, no restart.

```bash
sudo -u w2w bash -c 'cd /opt/w2w/members-portal && git pull && npm ci && npm run build'
```

Anyone who already had the portal open will see "Couldn't load this page" the first time they open a new page. That is the portal noticing that its old files are gone. A reload fixes it.

Optional, in the nginx file that serves the portal's files: serve `index.html` with `Cache-Control: no-cache` so browsers always pick up new releases. The hashed files under `/assets/` can be cached for a long time.

## Step 8. Check that it worked

- Backend running:

  ```bash
  sudo systemctl status members-backend
  ```

- Compression is on (look for `content-encoding: gzip`):

  ```bash
  curl -sI -H 'Accept-Encoding: gzip' https://api.wheel2wheel.racing/stats/public-summary | grep -i content-encoding
  ```

- HTTP/2 is on (look for `HTTP/2 200`):

  ```bash
  curl -sI --http2 https://api.wheel2wheel.racing/stats/public-summary | head -1
  ```

- Live planner: open the same team plan in two browsers. Both should show a "Live" tag, and a stint change in one should appear in the other within a second. If the tag keeps saying "Reconnecting…", step 6 did not take effect.
- Click through the dashboard, an event page, a results page and the series page.
- Image uploads: the first car or track image upload creates its own upload folders. They must be writable by the `w2w` user, as the livery folder already is.

## If something goes wrong

- Backend: `git checkout <previous commit>` in `/opt/w2w/members-backend`, then `npm ci`, `npm run build`, `sudo systemctl restart members-backend`.
- Portal: the same, with `npm ci` and `npm run build`.
- Database: every database change is an added column or index. The old code ignores them, so the database never needs to be rolled back. In the worst case, restore the backup from step 1.

## Things to know after this release

- Events announced to Discord before this release are not tracked, so their signup list in the Discord post will not update. Only events published after the release are.
- A new race result can take up to 30 seconds to show in the dashboard stats (they are cached briefly).
- The admin "import car usage since" button returns an error if a scan is already running. Try again after a minute.
- If the live connection cannot be established, the planner falls back to checking for changes every 15 seconds.
