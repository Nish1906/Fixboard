# Fixboard launch kit

A members-only board: verified industry professionals post problems, verified students send solutions, members rate solutions and climb leagues, and a staff console runs everything. No outside packages, just Node 22.13+.

## Run it on your computer (2 minutes)
    DEV_EXPOSE_CODE=1 FOUNDER_EMAIL=you@example.com node server.js
Open http://localhost:3000. Sign in with the founder email: the 6-digit code is shown on the page in development mode. You become the owner with every role.
Tests: `npm test`

## Go live (about an hour)
1. **Host.** Easiest: Render (render.yaml included) or any host that runs Docker (Railway, Fly.io). It needs a **persistent disk** mounted at /data, because members live in a SQLite file there. Run one instance only.
2. **Domain + HTTPS.** Point your domain at the host. HTTPS is required (the server refuses to start in production without an https BASE_URL).
3. **Email provider.** Sign-in codes are sent by email. Create a free account at Resend or Brevo, verify your domain (add the SPF and DKIM records they show), create an API key. Set MAIL_PROVIDER, MAIL_API_KEY, MAIL_FROM.
4. **Settings.** Set the variables from `.env.example`. FOUNDER_EMAIL must be an inbox only you control: whoever receives codes for it becomes owner.
5. **First sign-in.** Open your site, choose Sign in, enter FOUNDER_EMAIL, enter the code. Staff console appears in the top bar. Invite others under Staff & access.
6. **Legal.** Edit /terms, /privacy and /rules (public/*.html), fill the brackets, and have a lawyer review them before inviting real members.
7. **Backups.** Turn on disk snapshots at your host and also copy /data/fixboard.db somewhere safe daily.
8. **Monitoring.** Add a free uptime check on /healthz (UptimeRobot or similar).

## First week
Invite 5 to 10 industry people you know and 20 to 30 students from your network or university groups. Post 3 real problems yourself so the board is never empty. Approve company domains from the Verification tab.

## How verification works
- Students: .edu email, confirmed by emailed code. Non-.edu school emails go to your review queue.
- Industry: company email confirmed by code. Personal domains (gmail etc.) are refused. New company domains go to your review queue; tick "Trust this domain" to approve future ones automatically.

## Honest limits
- One server, one SQLite file: fine for hundreds to low thousands of members, not for huge scale.
- Rate limits reset when the server restarts.
- Email delivery depends on your provider setup; test with a few addresses (check spam).
- Legal pages are drafts, not legal advice.
- This kit is not a security audit. Before large-scale launch, have someone independent review it.
