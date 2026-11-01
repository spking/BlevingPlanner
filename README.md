# BlevingPlanner

A small, phone-friendly web app for two people to plan meals together:

- **Ingredients**: everything you cook with, grouped by supermarket section. Tap **At home?** to mark what you already have; this is shared between your phones.
- **Meals**: your recipes, each with ingredients, amounts and notes.
- **Calendar**: pick a meal for each day, see two weeks at a time, and build a **shopping list** for any date range. It splits into *To buy* and *Already at home*, and only *To buy* is copied or shared.
- **Apple Calendar feed**: subscribe once, and planned meals show up as all-day events with the ingredients in the notes.

It has no third-party dependencies. It runs on Node.js ≥ 22.13 with the built-in SQLite, and all data is kept in a single file (`data/meal-planner.db`).

## Run it locally

```bash
APP_PASSWORD=choose-something npm start
```

Then open http://localhost:3000. Run the tests with `npm test`.

Settings can also go in a `config.env` file (copy `config.example.env`); `npm start` reads it automatically.

| Variable | Purpose |
|---|---|
| `HOST` | `127.0.0.1` to accept connections only from this machine (recommended behind Tailscale Funnel). Default: all interfaces. |
| `APP_PASSWORD` | Shared password for you both. **Set this whenever the app is online.** |
| `PUBLIC_URL` | e.g. `https://meals.example.com`, used to build the calendar link. Detected automatically if not set. |
| `DATA_DIR` | Where the database lives (default `./data`). |
| `PORT` | Default `3000`. |
| `CALENDAR_NAME` | Name of the calendar in Apple Calendar (default `Meals`). |

## Hosting: it must be public and HTTPS

**Our setup: a Windows laptop + Tailscale Funnel. Follow [DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md).** (On Linux or macOS with Docker: `cp config.example.env config.env`, edit it, then `docker compose up -d --build`.)

Why a public address is needed at all:

The calendar subscription is fetched by **Apple's servers** (iCloud), not by your phone. So the app has to be reachable from the internet over HTTPS. A server that only runs on your home network won't work for the subscription. Good options:

- **A small cloud host with a persistent disk** (Fly.io, Railway, Render with a disk, a €4 VPS). Use the included `Dockerfile` and mount a volume at `/data`.
- **A Raspberry Pi or home server + Cloudflare Tunnel or Tailscale Funnel**, which gives you a public HTTPS address without opening router ports.

Back up `meal-planner.db` occasionally. It's the only thing that holds your data.

## On your phones

1. Open the site in Safari → Share → **Add to Home Screen**. It then opens full-screen like an app.
2. Calendar tab → **Export** → **Subscribe in Calendar**. Or on a Mac: Calendar → File → New Calendar Subscription, with Location set to **iCloud** so it syncs to your iPhone.
   Each of you subscribes on your own Apple ID, because subscribed calendars can't be shared like an iCloud calendar.
3. Anyone who has the calendar link can *read* your plan. If it leaks, use **Reset link** and subscribe again.

## Freezer reminders

Tick **Kept frozen** on an ingredient (meaning you keep it in your own freezer). This is separate from the shop's "Frozen" aisle category.
For every planned meal that uses a frozen ingredient, the calendar feed adds a 15-minute event **the evening before** (default 19:00), e.g. "❄ Take out: Minced beef", with an alert.
You can change the time or turn this off under Calendar → Export → Freezer reminders. The Calendar page in the app also shows the hint on that evening.

Apple Calendar **removes alerts from subscribed calendars by default**. To get the notification, untick *Remove: Alerts* when subscribing (Mac: right-click the calendar → Get Info). Without it you still see the event, just with no notification.

## Design notes

- One meal per day. The event's ID is the date, so changing a day's meal updates the event instead of creating a duplicate.
- Events are all-day and marked "free", so they don't block your availability.
- Every change returns the full fresh data set, and the app reloads when it comes back to the foreground. That way changes your partner made show up when you open the app.
- Shopping-list ticks are saved on each phone separately. They are not shared between you.
