# SPECTR — AI PC, Laptop & Printer Advisor

An AI-powered advisor that recommends real PC, laptop, and printer models available in India, using Groq (Llama 3.3 70B) for specs and Tavily for live current pricing.

## How it's structured

- `server.js` — Express backend, serves the site and the two recommendation APIs
- `index.html` — landing page (choose Desktop / Laptop / Printer)
- `specs.html`, `results.html` — PC/laptop spec form and results
- `printer-specs.html`, `printer-results.html` — printer spec form and results
- `package.json` — dependencies and start script

This repo does **not** include `main.js` (the Electron desktop-app wrapper). It isn't needed to run this as a website — it's only relevant if you later want a downloadable desktop app version.

## Run it locally

```bash
npm install
cp .env.example .env
# edit .env and paste in your own TAVILY_API_KEY and GROQ_API_KEY
npm start
```

Then open `http://localhost:3000`.

## Put it on GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

`.gitignore` already excludes `.env`, so your real API keys will never be pushed. Only `.env.example` (with placeholder values) goes to GitHub.

## Deploy it so anyone, on any browser, can use it

This is a Node/Express app with a real backend (not just static files), so it needs a host that runs a Node server continuously. Two easy free-tier options:

**Render** (recommended, simplest):
1. Go to render.com, sign in with GitHub, click **New > Web Service**, pick this repo.
2. Build command: `npm install` — Start command: `npm start`.
3. Under **Environment**, add `TAVILY_API_KEY` and `GROQ_API_KEY` as environment variables (paste the real values there, not in the code).
4. Deploy. Render gives you a public URL like `https://spectr-ai-advisor.onrender.com` that anyone can visit.

**Railway** (similar flow): railway.app → New Project → Deploy from GitHub repo → add the same two environment variables in the Variables tab → it gives you a public URL automatically.

Either way, the API keys live only in the host's environment variable settings — never in your GitHub repo.

## Security note

The keys that were in your original `_env` file have already been shared in this conversation, so treat them as compromised: regenerate new ones at console.groq.com and app.tavily.com before going live, and use the new ones in your `.env` / hosting dashboard.
