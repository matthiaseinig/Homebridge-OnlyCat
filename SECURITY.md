# Security policy

## Reporting a vulnerability

If you find a security issue in `homebridge-onlycat`, **do not open a public GitHub issue**. Instead, email the maintainer or use GitHub's [private security advisory](https://github.com/matthiaseinig/OnlyCatHomebridge/security/advisories) feature. We aim to respond within 7 days.

When reporting, please include:

- A description of the issue and its impact
- Reproduction steps (Homebridge version, Node version, plugin version, config without the token)
- Suggested mitigation if you have one

## Supported versions

Only the latest minor release receives security fixes. While the plugin is below `1.0.0` it is considered alpha — backports are best-effort.

## Threat model

The plugin sits between three trust boundaries:

```
[ HomeKit / Home app ]  <—HAP—>  [ this plugin ]  <—WSS/HTTPS—>  [ OnlyCat gateway ]
```

| Boundary | Trusted? | Notes |
|---|---|---|
| HomeKit / Home app | Trusted | Apple's HAP layer authenticates every controller |
| OnlyCat gateway | Trusted, with caveats | We trust the operator, but treat all incoming Socket.IO payloads as untrusted input |
| Local Homebridge process | Trusted | Anyone with shell access to your Homebridge host can read the token |
| `dev/` directory contents | **Sensitive** | Contains real tokens during development; git-ignored |

## What the plugin does to protect you

- **TLS only.** All gateway traffic uses `wss://` and `https://`. The plugin refuses to downgrade.
- **Token confidentiality.**
  - The token is never logged at INFO level.
  - At DEBUG level it is partially redacted (first 4 chars + `***`).
  - The token is sent only in the Socket.IO handshake `auth` field — never in URLs or HTTP headers.
- **Strict input validation.** Every payload received from the gateway is validated against a typed schema before being used. Unknown fields are ignored, malformed payloads are dropped with a warning.
- **No dynamic code execution.** No `eval`, no `Function()`, no dynamic `require()`.
- **Bounded subprocesses.** ffmpeg (used for live streaming and HKSV recording) is spawned with arrays — never a shell — and with explicit argument lists. Output streams are size-limited to prevent memory exhaustion.
- **Minimal dependencies.** Each direct runtime dep is justified in `package.json` and audited (`npm audit`). We avoid transitive bloat.
- **Graceful failure.** Auth errors fail fast with a clear log message — they do not retry-loop forever.

## What you can do to protect yourself

- Keep your OnlyCat token out of version control. The plugin's `.gitignore` excludes the `dev/` sandbox by default.
- Rotate your token if you suspect it has leaked (OnlyCat app → Settings → Developer).
- Run Homebridge under a non-privileged user account.
- Keep Homebridge, Node.js, and this plugin up to date.
- Restrict access to your Homebridge host (it stores HomeKit pairing keys for everything in your home).

## Out of scope

The following are explicitly out of scope for this plugin's threat model:

- Compromise of the OnlyCat gateway itself
- Compromise of your local network or Homebridge host
- Bugs in HomeKit / HAP-NodeJS
- Bugs in third-party plugins running in the same Homebridge instance

## Acknowledgements

Security researchers who responsibly disclose vulnerabilities will be credited in release notes (with permission).
