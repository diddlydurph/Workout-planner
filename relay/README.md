# Weigh-in relay

A tiny Cloudflare Worker that reads your EufyLife scale history so the app's Progress page can pull new weigh-ins by itself, and Claude can read them through a custom connector. Free on Cloudflare's free plan.

It uses the EufyLife app's own cloud API, which Eufy doesn't document; the community worked it out ([eufylife-api-hacs](https://github.com/m4ary/eufylife-api-hacs), [eufylife-mcp](https://github.com/MatthewHallCom/eufylife-mcp)). If Eufy changes it, the relay stops finding weigh-ins and the app says so; manual entry and CSV import still work.

## Set up

1. In Cloudflare: Workers & Pages > Create > Worker, name it `weigh-in-relay`, and paste in `worker.js` (or `npx wrangler deploy` from this folder).
2. Settings > Variables and Secrets, add as **secrets**:
   - `EUFY_EMAIL`, `EUFY_PASSWORD`: your EufyLife login. If you sign in to Eufy with Google or Apple, set a Eufy password first.
   - `RELAY_KEY`: a long random string (a password manager can make one).
   Optional text variables: `EUFY_PROFILE` (the profile's name when several people share the scale), `TIMEZONE` (default Europe/London).
3. In the app: Progress > Bodyweight > "Sync weigh-ins from the scale automatically", then enter the Worker's address (`https://weigh-in-relay.<you>.workers.dev`) and the key.
4. For Claude: claude.ai > Settings > Connectors > Add custom connector, URL `https://weigh-in-relay.<you>.workers.dev/mcp/<RELAY_KEY>`. Treat that URL like a password.

A Bluetooth-only scale reaches Eufy's servers when the EufyLife app syncs, so open EufyLife after weighing if a reading doesn't show up.
