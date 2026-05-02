# `dev/` — local Homebridge sandbox

Files in this folder are used to run the plugin against real OnlyCat hardware during development.

- `config.example.json` — template, **safe to commit**
- `config.json` — your real config including the token. **Git-ignores everything except this README and the example.**
- `accessories/`, `persist/`, `*.log` — Homebridge runtime state. All ignored.

To start a dev session:

```sh
cp dev/config.example.json dev/config.json
# edit dev/config.json — paste your OnlyCat token
npm run dev
```

The dev bridge uses its own bridge identity (different MAC + PIN from your production Homebridge), so you can pair it with the Home app on a separate "house" or simply unpair after testing.

If you ever accidentally commit a token, **rotate it in the OnlyCat app immediately** — git history is hard to scrub.
