# Running BlevingPlanner on a Windows 11 laptop with Tailscale Funnel

When you're done:
- The app runs in the background from boot, with nobody logged in.
- It restarts itself after crashes and Windows Update reboots, and backs itself up every night.
- It is reachable at a public HTTPS address like `https://meals.tail1a2b3c.ts.net`.

This takes about 30 minutes, once.

## 0. Prepare the laptop

- **Keep it plugged in.** In **Lenovo Vantage** → Power, turn on **Conservation mode**. It holds the battery at about 60% so it doesn't wear out from being on charge all the time.
- **Don't put the project in a OneDrive-synced folder.** Desktop and Documents are often synced on Windows 11. OneDrive syncing a live database can corrupt it. Use `C:\BlevingPlanner` as below.
- Gaming extras such as an always-on discrete GPU or RGB lighting can stay as they are. The app hardly uses anything.

## 1. Install Node.js and Git

1. Install **Node.js LTS** from https://nodejs.org (Windows Installer, default options).
2. Install **Git for Windows** from https://git-scm.com/download/win (default options).
3. Open a **new** PowerShell window and check both are installed. `node --version` must print v22.13 or newer.

```powershell
node --version
```

```powershell
git --version
```

## 2. Get the code

```powershell
git clone https://github.com/spking/BlevingPlanner.git C:\BlevingPlanner
```

If the repo is private, Git will open a browser window to sign in to GitHub. That's expected.

## 3. Install Tailscale

1. Install from https://tailscale.com/download/windows and sign in.
2. Click the Tailscale icon in the system tray → **Preferences** → turn on **Run unattended**. Without this, Tailscale stops when you log out and the app goes offline.
3. Optional but nice: in the admin console (https://login.tailscale.com/admin/machines), rename the machine to something short like `meals`. Do this **now**, because the name becomes part of your address and changing it later breaks your calendar subscriptions.
4. Find your address:
   - Run `tailscale status` and look at the first line, or check the **DNS** page in the admin console for the tailnet name.
   - Your address is `https://<machine>.<tailnet>.ts.net`, for example `https://meals.tail1a2b3c.ts.net`.

## 4. Configure

```powershell
cd C:\BlevingPlanner
```

```powershell
copy config.example.env config.env
```

```powershell
notepad config.env
```

Set:
- `APP_PASSWORD`: something long that you both use.
- `PUBLIC_URL`: your address from step 3, with no trailing slash.
- Optional: `BACKUP_DIR` set to a OneDrive folder, e.g. `C:\Users\<you>\OneDrive\BlevingPlanner-backups`. Backups are finished, closed files, so syncing them is safe, and it gives you a copy off the laptop.

## 5. Install it as a background task

Open PowerShell (an ordinary window is fine). The script asks Windows for administrator rights itself: click **Yes** on the prompt, and it carries on in a new window.

```powershell
cd C:\BlevingPlanner
```

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -KeepAwake
```

This registers two scheduled tasks and starts the app.
- **BlevingPlanner** starts at boot and restarts Node if it stops.
- **BlevingPlanner backup** runs every night at 03:30.

`-KeepAwake` stops the laptop sleeping or hibernating on mains power and makes closing the lid do nothing. You should see `OK - the app is running`.

## 6. Put it on the internet

In the administrator window the installer opened (its title starts with *Administrator:*):

```powershell
tailscale funnel --bg 3000
```

The first time, it prints a link to switch on HTTPS and Funnel for your account. Open it, approve it, and run the command again. `--bg` makes it permanent, including after reboots.

Test it from your phone **on mobile data, not Wi-Fi**, by opening your address. A brand-new address can take a few minutes to start working.

## 7. On both iPhones

1. Open the address in Safari → Share → **Add to Home Screen** → sign in.
2. Calendar → **Export** → **Subscribe in Calendar**. To get the freezer reminders as notifications, untick **Remove alerts** when subscribing.

---

## Everyday commands

Run these in PowerShell in `C:\BlevingPlanner`. The scripts ask for administrator rights themselves when they need them.

| What | Command |
|---|---|
| Update to the latest version from GitHub | `powershell -ExecutionPolicy Bypass -File deploy\windows\update.ps1` |
| Stop the app | `powershell -ExecutionPolicy Bypass -File deploy\windows\stop.ps1` |
| Start it again | `Start-ScheduledTask BlevingPlanner` (administrator window) |
| Back up right now | `npm run backup` |
| Is Funnel on? | `tailscale funnel status` |
| Remove everything (keeps your data) | `powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall.ps1` |

**Logs:**
- `logs\server.log` and `logs\server-error.log` hold the current run.
- `*.previous` files hold the run before it.

**Restore a backup:**
1. Stop the app.
2. Copy the backup file over `data\meal-planner.db`.
3. Delete `data\meal-planner.db-wal` and `data\meal-planner.db-shm` if they exist.
4. Start the app again.

## If something's wrong

- **The address doesn't load:**
  - Is the laptop on and online?
  - Does `tailscale funnel status` show your address?
  - Does http://127.0.0.1:3000 work on the laptop itself?
- **It loads on the laptop but not outside:** this is a Funnel issue. Check that Run unattended is on and run `tailscale funnel --bg 3000` again.
- **Nothing on port 3000:**
  - Check `logs\server-error.log`.
  - Check Task Scheduler → *BlevingPlanner* → History.
- **Calendar not updating:**
  - Apple only re-fetches on its own schedule. On a Mac, right-click the calendar → Get Info → Auto-refresh.
  - While the laptop is off, Apple Calendar keeps showing the last plan it fetched.
