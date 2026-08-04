# Security Policy

## Supported Versions

infinite-canvas is in active development. Security fixes are accepted for the
`main` branch and the latest tagged release. Older versions may be handled on a
best-effort basis.

## Reporting a Vulnerability

Please do not open a public issue with exploit details, credentials, private
API keys, proof-of-concept code, or screenshots that reveal sensitive data.

Preferred reporting channels:

1. Use GitHub private vulnerability reporting or a GitHub Security Advisory for
   this repository, if available.
2. If a private GitHub report is not available, email `AR2000@VIP.163.com` with
   the subject `[infinite-canvas security]`.
3. If neither private channel is available, open a public issue that asks for a
   private contact channel and does not include technical exploit details.

Please include:

- Affected version, commit, branch, or deployment mode.
- Clear reproduction steps.
- Impact and attack scenario.
- Any relevant logs, screenshots, or proof of concept, with secrets removed.
- Whether the issue affects local-only usage, hosted deployments, browser
  storage, WebDAV sync, AI provider configuration, or API proxy behavior.

## Scope

### Canvas node plugins

The canvas supports third-party node plugins loaded from a remote URL. By
design, an installed plugin's code runs directly inside the web app with full
access to the page. It cannot read HttpOnly cookies directly, but it can read
browser-managed data and issue same-origin requests as the signed-in user.
Managed AI channel keys remain on the server. This is an intentional trade-off
for extensibility, and the installer requires an explicit trust confirmation.
Therefore:

- Only install plugins from sources you trust.
- Reports that a *malicious plugin* can access page data or API keys are **out
  of scope** — that is the documented behavior of the trust model.
- Reports **in scope** include: the app loading/executing plugin code without
  the install confirmation, a plugin escaping its declared node type to break
  core app integrity in ways not implied by "runs in the page", or the plugin
  source cache being writable by an unrelated origin.

Examples of in-scope reports:

- Cross-site scripting or token exfiltration in the web app.
- Exposure of locally stored API keys or synced canvas data caused by project
  code.
- Unsafe file handling, import/export behavior, or WebDAV proxy behavior.
- Authentication, authorization, or access-control flaws in project-managed
  features.
- Supply-chain issues that are exploitable through this repository's shipped
  code or default configuration.

Examples that are usually out of scope:

- Vulnerabilities in third-party AI providers, model APIs, hosting platforms,
  or browser extensions outside this repository.
- Compromise of a user's own API key outside the app.
- Denial-of-service reports that require unrealistic traffic volume or physical
  access to the user's device.
- Missing security headers without a demonstrated exploit path.
- Social engineering, phishing, spam, or account recovery requests.
- Dependency reports without a practical impact on this project.

## Deployment Baseline

- Public registration is disabled by default. Set `ALLOW_REGISTRATION=true`
  only when open account creation is intentional.
- Production deployments must use a unique `AUTH_SECRET` of at least 32
  characters and a strong `ADMIN_PASSWORD` for first startup.
- Terminate TLS in front of the gateway, then set `COOKIE_SECURE=true`. Do not
  send credentials, session cookies, or AI traffic over public plain HTTP.
- Keep `CORS_ORIGINS` empty for same-origin deployment or list only trusted
  HTTPS origins.
- Upload and AI request/response limits are configurable through the variables
  documented in `server/.env.example`; increasing them also increases memory
  and storage denial-of-service exposure.
- Back up the persistent server data directory before upgrades. User file
  directories from older releases are migrated to account-ID namespaces at
  startup when the mapping is unambiguous.

## Disclosure

The maintainers aim to acknowledge valid reports within 7 days and coordinate a
fix before public disclosure. Response and fix timelines are best effort for
this community project.

Please allow time for investigation and remediation before publishing details.
Credit will be given on request unless you prefer to remain anonymous.

