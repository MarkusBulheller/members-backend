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

The new `event_guest_signups` table is the one place where the hand-written SQL could differ from what the app expects (for example the `uuid_generate_v4()` default needs the `uuid-ossp` extension that your other tables already use). If in doubt, use the bootstrap above, which creates it exactly as the app defines it.

```sql
ALTER TABLE events ADD COLUMN IF NOT EXISTS tyre_limit integer NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS discord_message_id varchar NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS discord_channel_id varchar NULL;
ALTER TABLE event_team_stints ADD COLUMN IF NOT EXISTS tyres_changed smallint NULL;
ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS partial_tyre_change_seconds numeric(6,2) NULL;
ALTER TABLE team_highlights ADD COLUMN IF NOT EXISTS position integer NULL;
ALTER TABLE event_signups ADD COLUMN IF NOT EXISTS timeslot_preference uuid[] NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS min_drivers_per_team integer NULL;
ALTER TABLE discord_bot_settings ADD COLUMN IF NOT EXISTS public_key varchar NULL;
ALTER TABLE discord_bot_settings ADD COLUMN IF NOT EXISTS alert_user_id varchar NULL;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS discord_id varchar(20) NULL;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS discord_username varchar(32) NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_driver_profiles_discord_id ON driver_profiles (discord_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_driver_profiles_discord_username ON driver_profiles (discord_username);

CREATE TABLE IF NOT EXISTS event_guest_signups (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  driver_profile_id uuid NOT NULL REFERENCES driver_profiles(id) ON DELETE CASCADE,
  car_class varchar NULL,
  timeslot_ids uuid[] NOT NULL DEFAULT '{}',
  timeslot_preference uuid[] NULL,
  status varchar(20) NOT NULL DEFAULT 'CONFIRMED',
  signed_up_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_guest_signups_event_profile ON event_guest_signups (event_id, driver_profile_id);
CREATE INDEX IF NOT EXISTS idx_event_guest_signups_driver_profile_id ON event_guest_signups (driver_profile_id);

-- Auto-import of race results
ALTER TABLE iracing_teams
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_import boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_checked_at timestamptz NULL;

CREATE TABLE IF NOT EXISTS iracing_auto_import_settings (
  id integer PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  mode varchar NOT NULL DEFAULT 'NOTIFY',
  delay_minutes integer NOT NULL DEFAULT 20,
  enabled_since timestamptz NULL,
  last_run_at timestamptz NULL,
  last_run_status varchar NULL,
  last_run_message text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO iracing_auto_import_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS iracing_result_attempts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  subsession_id integer NOT NULL,
  team_id integer NOT NULL,
  series_name varchar NULL,
  track_name varchar NULL,
  car_name varchar NULL,
  start_time timestamptz NULL,
  end_time timestamptz NULL,
  finishing_position_in_class integer NULL,
  finishing_position integer NULL,
  laps_complete integer NULL,
  status varchar NOT NULL DEFAULT 'FOUND',
  tries integer NOT NULL DEFAULT 0,
  last_error text NULL,
  race_result_id uuid NULL,
  announced_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_iracing_result_attempts_subsession_team UNIQUE (subsession_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_iracing_result_attempts_status ON iracing_result_attempts (status);

ALTER TABLE race_results
  ADD COLUMN IF NOT EXISTS import_source varchar(10) NULL,
  ADD COLUMN IF NOT EXISTS imported_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS event_id uuid NULL,
  ADD COLUMN IF NOT EXISTS event_team_id uuid NULL;
ALTER TABLE race_results
  ADD CONSTRAINT fk_race_results_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_race_results_event_team FOREIGN KEY (event_team_id) REFERENCES event_teams(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_race_results_event_id ON race_results (event_id);
CREATE INDEX IF NOT EXISTS idx_race_results_event_team_id ON race_results (event_team_id);

ALTER TABLE discord_bot_settings ADD COLUMN IF NOT EXISTS results_channel_id varchar NULL;

-- Public "Follow the race" link and OBS overlay (off for every team until an admin enables it)
ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS follow_token varchar(64) NULL;
ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS follow_names varchar(10) NOT NULL DEFAULT 'FULL';
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_teams_follow_token ON event_teams (follow_token) WHERE follow_token IS NOT NULL;

-- Personal race summary (opt-in Discord message after a result is imported)
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS race_summary_dm boolean NOT NULL DEFAULT false;

-- Team leads (per event crew) and the Discord thread per event team
CREATE TABLE IF NOT EXISTS event_team_leads (
  event_team_id uuid NOT NULL REFERENCES event_teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_event_team_leads_user_id ON event_team_leads (user_id);
ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS discord_thread_id varchar NULL;
-- Discord channel per event (created from the event page inside a category)
ALTER TABLE events ADD COLUMN IF NOT EXISTS discord_event_channel_id varchar NULL;
ALTER TABLE discord_bot_settings ADD COLUMN IF NOT EXISTS event_category_id varchar NULL;

-- iRacing teams added by hand (teams we are not a member of / that no longer exist)
ALTER TABLE iracing_teams ADD COLUMN IF NOT EXISTS manual boolean NOT NULL DEFAULT false;

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

3b. In the same `server { ... }` block, right below the planner stream block, add one more rule for the public "Follow the race" live stream:

   ```nginx
       # Public "Follow the race" live stream: long-lived, must not be buffered.
       location ~ ^/public/follow/[^/]+/stream$ {
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

   Also make sure the general `location / { ... }` block contains `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` (yours already does).

   In `/opt/w2w/members-backend/.env` add `FOLLOW_TRUST_PROXY=true`. Without it, the public pages' rate limit counts every visitor as one person (the proxy's address), so a busy stream could lock out its own viewers.

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

## Step 9. Turn on Discord signups (one time, after the deploy)

Members and guest drivers can sign up straight from the event post in Discord. This needs a one-time setup. Nothing in Discord changes until you do it.

1. Discord Developer Portal → your app → **General Information** → copy the **Public Key**.
2. In the members portal, open **Admin → Discord bot**. Paste the Public Key, enter your own Discord user ID (you get a direct message there when someone who is not linked tries to sign up), and save.
3. On the same page, copy the **Interactions endpoint URL** (it is `https://api.wheel2wheel.racing/discord/interactions`) and paste it into the Developer Portal under **General Information → Interactions Endpoint URL**, then save. Discord checks it immediately. If the check fails, the Public Key is usually wrong.
4. For the direct messages to reach you, you must share a server with the bot and allow direct messages from server members.
5. Check that `FRONTEND_URL` is set in `/opt/w2w/members-backend/.env` to the portal's address. The "Set my hours" button in the Discord post links to it.
6. Test with one new event: publish it, then click **Sign up** in the Discord post. Only events published after this release get the buttons. Older posts are not tracked.

How people are recognised:

- **Members:** by their Discord account, the one they log in to the portal with. They must be approved members.
- **Guest drivers:** an admin enters the guest's **Discord username** (for example `delta2611`, no `@`) on the guest's driver form. The first time they sign up, the bot remembers their permanent Discord ID, so a later username change does not break the link.
- **Anyone else:** gets a private message to contact you, and you get a direct message with their `@username`.

## Step 10. Turn on automatic result import (one time, after the deploy)

Nothing happens until you switch it on. Start in notify-only mode.

1. Check that `FRONTEND_URL` is set in `/opt/w2w/members-backend/.env` to the portal's address. The Discord messages link to it.
2. In the portal, open **Admin → Settings → Discord bot** and enter the **Results channel ID**. Without it, no result messages are posted and the Auto-import tab shows a warning.
3. Open **Admin → Settings → Auto-import**:
   - In **Watched teams**, switch **Watch for results** on only for your own teams. Switch **Active** off for iRacing teams that are not yours, so they disappear from the team pickers.
   - Leave the mode on **Notify only** and switch **Auto-import race results** on. It only looks at results that finish after you switch it on.
   - Use **Run now** to test the check. A check also runs every 30 minutes.
4. After the first real race, new results appear in the **Results** panel as "Found" and are announced in the results channel. Click **Import** on them, or switch the mode to **Import automatically** once you trust it.

Things to know:

- It needs at least one admin with a working iRacing link (Edit profile → Link iRacing account). If none has one, the check is skipped and you get a direct message.
- A result is only picked up 20 minutes after the race has finished.
- When a result is linked to an event team, the event is marked **Completed** automatically once every team of that event that has a start time has a result. This also applies to results you import by hand.
- Turning auto-import off and on again resets "only results after you switch it on", so any gap in between is not backfilled.

## Step 11. Public "Follow the race" link and OBS overlay (optional)

Off for every team until you switch it on, per team.

1. Open a team's stint plan and click **Share live view**.
2. Switch on **Public live link**. You get two addresses to copy:
   - **Follow page** for friends and family: who is driving now, who is next, the clock and the stint list.
   - **OBS overlay** for a stream. In OBS: Sources → + → Browser, paste the address, width 1920, height 1080.
3. Choose how driver names are shown (full names, first names or initials).
4. Anyone with the address can see who drives when. Fuel, tyres, lap times and settings are never shown.
5. **Regenerate link** stops the old address immediately. Switching the link off does the same.
6. This needs the extra nginx rule from step 6 and `FOLLOW_TRUST_PROXY=true`. Without the nginx rule the live updates arrive late, and the pages fall back to checking every 15 seconds.

## Step 12. Team leads, Discord threads and the team recap (optional)

- **Team leads:** an admin picks them per event crew, on the crew's plan page under "Per-driver pace & fuel" → **Team lead** (only drivers placed on that crew can be chosen, up to 5). A lead can plan only that crew in that event (stints, planning settings, driver settings, guest drivers, availability, live link). Cars, start times, moving drivers, events and everything under Admin stay admin-only. A lead who is moved off the crew or cancels loses access immediately.
- **Discord thread per crew:** on a team's stint plan (admin), click **Discord thread** (one thread per crew, with a stint plan summary). The bot needs View Channel, Send Messages, Create Public Threads and Send Messages in Threads in the events channel. It uses the existing events channel, bot token and `FRONTEND_URL`.
- **Discord channel per event:** on the event page (admin), click **Discord channel** to create a new text channel for the whole event. First set Admin → Discord Bot → **Event category ID** (right-click the category in Discord → Copy Category ID). The bot additionally needs **Manage Channels** (on the server or on that category). The channel inherits the category permissions and starts with the event details.
- **Team recap:** the **Recap** page (under Racing, after Results) needs nothing extra. It reads imported results and is cached for 5 minutes.

## If something goes wrong

- Backend: `git checkout <previous commit>` in `/opt/w2w/members-backend`, then `npm ci`, `npm run build`, `sudo systemctl restart members-backend`.
- Portal: the same, with `npm ci` and `npm run build`.
- Database: every database change is an added column or index. The old code ignores them, so the database never needs to be rolled back. In the worst case, restore the backup from step 1.

## Things to know after this release

- Events announced to Discord before this release are not tracked, so their signup list in the Discord post will not update. Only events published after the release are.
- A new race result can take up to 30 seconds to show in the dashboard stats (they are cached briefly).
- The admin "import car usage since" button returns an error if a scan is already running. Try again after a minute.
- If the live connection cannot be established, the planner falls back to checking for changes every 15 seconds.
