# Deploying Market List to your iPhone

This folder is now a Progressive Web App (PWA). To install it on your iPhone you need to:

1. Host the folder on a public HTTPS URL.
2. Open that URL in **Safari** on your iPhone (it must be Safari — Chrome / Firefox on iOS cannot install PWAs).
3. Tap **Share → Add to Home Screen**.

Below is the recommended path (Cloudflare Pages, free) plus a fallback (GitHub Pages).

---

## Option A — Cloudflare Pages (recommended)

Why this one: free, no build step, no Mac tooling required, custom domain optional, deploys in ~30 seconds.

### One-time setup

1. Go to <https://dash.cloudflare.com/sign-up> and create a free account.
2. In the dashboard, click **Workers & Pages** → **Create** → **Pages** → **Upload assets**.
3. Give the project a name (e.g. `market-list`). Click **Create project**.
4. Drag the entire `Grocery App` folder onto the upload area (or zip it first if drag-drop is finicky). Make sure `index.html`, `manifest.webmanifest`, `sw.js`, and the `icons/` folder are all at the project root.
5. Click **Deploy site**.

You'll get a URL like `https://market-list.pages.dev`. That's your app.

### Updating later

When you change a file, repeat steps in **Workers & Pages → market-list → Create deployment → Upload assets**, and re-upload the folder. Cloudflare will swap to the new version automatically. (When you update `index.html` or `sw.js`, **bump `APP_VERSION` in `sw.js`** so the service worker invalidates the old cache — otherwise users may stay on the cached version.)

---

## Option B — GitHub Pages ✅ ACTIVE (deployed 2026-05-14)

**Live URL:** https://bluestonemario.github.io/grocery-app/
**Repository:** https://github.com/BluestoneMario/grocery-app
**GitHub username:** BluestoneMario

### How it was set up (one-time, already done)

```bash
# 1. Configure Git identity
git config --global user.name "BluestoneMario"
git config --global user.email "lennarthellwig@yahoo.de"

# 2. Navigate to the app folder
cd "/Users/lennart.hellwig/Documents/Claude Code Personal/Grocery App"

# 3. Initialise Git and make the first commit
git init
git add .
git commit -m "Initial commit"
git branch -M main

# 4. Connect to GitHub and push
git remote add origin https://github.com/BluestoneMario/grocery-app.git
git push -u origin main
```

Then in the repo's **Settings → Pages**, source was set to `main` branch, root. GitHub Pages went live ~60 seconds later.

**Authentication note:** GitHub does not accept your account password for `git push`. Use a Personal Access Token instead. Generate one at: GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic). Tick the `repo` scope. Paste the token when Git asks for your password.

### Updating the app (use this every time you make changes)

```bash
cd "/Users/lennart.hellwig/Documents/Claude Code Personal/Grocery App"
git add .
git commit -m "describe what you changed"
git push
```

The live site updates within ~60 seconds of a successful push. Remember to bump `APP_VERSION` in `sw.js` when you change `index.html` or `sw.js` so the service worker cache refreshes on users' devices.

---

## Installing on iPhone

Once your app is live at an HTTPS URL:

1. Open the URL in **Safari** on the iPhone.
2. Wait for the page to finish loading (this is when the service worker installs and caches everything for offline use — give it ~5 seconds the first time).
3. Tap the **Share** icon (square with an up-arrow) at the bottom of Safari.
4. Scroll and tap **Add to Home Screen**.
5. The icon name defaults to "Market" (set via `apple-mobile-web-app-title`). Tap **Add**.

You now have an app icon on your home screen. Tapping it opens Market List full-screen with no Safari chrome, like a native app.

### Verifying offline works

After the install:

1. Open the app once while online to make sure the service worker has cached everything (you'll see your list).
2. Turn on Airplane Mode.
3. Re-open the app from the home screen. It should load and let you add / check off items.
4. Turn Airplane Mode back off — your edits stay in place.

If offline doesn't work, open Settings inside the app and tap **Force update**, then re-open online once.

---

## Backing up your data

Open the app, tap the gear icon in the top-right, then **Download backup (JSON)**. Save the file somewhere safe (iCloud Drive, email it to yourself, etc.). To restore: tap **Restore from backup file…** and pick the JSON.

The app also mirrors data to IndexedDB automatically, which is more durable than localStorage on iOS — but a manual backup is still the only thing that survives a phone wipe / "Clear History and Website Data" until cloud sync ships in Phase 3.

---

## What's next (Phase 3 preview)

- Real cloud sync via Supabase (~10 min of setup on your side, then I do the rest).
- Multi-device: open on iPad/Mac and see the same list.
- Shared list with your partner — both phones edit live.

Tell me when you're ready and I'll walk through it.
