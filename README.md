# Workplace Services — Budget Dashboard

A Vite + React app, ready to deploy on Vercel.

## What changed from the in-chat version
- Data is saved to the browser's `localStorage` instead of Claude's artifact storage, so it works as a normal website.
- Data is currently **per-device / per-browser** — it does not sync between people yet. That comes later with the Google Sheets backend.

## Deploy on Vercel (no coding needed)

1. **Create a GitHub repo** and push this folder to it.
   - Easiest way: go to https://github.com/new, create an empty repo (e.g. `workplace-budget-dashboard`), then follow GitHub's "push an existing folder" instructions it shows you, using this folder.
2. **Go to https://vercel.com** and sign in (you can sign in with your GitHub account).
3. Click **Add New → Project**, then **Import** the GitHub repo you just created.
4. Vercel will auto-detect this as a **Vite** project. Leave all settings as default.
5. Click **Deploy**. In about a minute you'll get a live public URL like:
   `https://workplace-budget-dashboard.vercel.app`
6. Open that URL — the dashboard loads with your real Budget Headers and no sample expenses. Add a real expense to confirm it saves (refresh the page — it should still be there).

## Updating it later
Any time you (or I) change the code, push the change to the same GitHub repo — Vercel automatically redeploys within a minute or two. No manual redeploy step needed.

## Running it locally first (optional)
If you want to preview it on your own machine before deploying:

```bash
npm install
npm run dev
```

Then open the local address it prints (usually `http://localhost:5173`).

## Next step: Google Sheets sync
This version stores data locally in each browser. Once you've finished remapping your expense categories in the template I sent, let me know and I'll swap this local storage for API routes that read and write your Google Sheet live — so everyone sees the same data from any device.
