# HowCanvas Public Deployment Plan

## 1. Deployment Target

The public repository is the source of truth. A release is deployable only when the same Git commit is present in these three places:

1. local `main` in `S:\H_canvas\howcanvas`;
2. GitHub `manhoolee/howcanvas` `main`;
3. the production source files under `/opt/infinite-canvas`, recorded in `/opt/infinite-canvas/.deployed-commit`.

Secrets, runtime data, image layers, caches, and server-only backups are not part of source alignment.

## 2. Public Docker Topology

The default `docker-compose.yml` provides a portable, same-origin stack:

- `app`: builds the Vite frontend and serves it with Nginx on container port 3000;
- `backend`: runs the Node server on container port 8787 and owns authentication, persistence, billing, and AI proxying;
- `gateway`: exposes `${HOWCANVAS_PORT:-3000}` and routes `/api` to `backend` and all other requests to `app`;
- `server-data`: a named volume mounted at `/app/data` in `backend`.

The gateway starts only after `app` and `backend` pass health checks. Frontend and API remain same-origin, so public deployments do not need browser-side API URLs or API keys.

## 3. Configuration And Security

The root `.env.example` is copied to `.env` for Docker deployment. Before first start:

- `AUTH_SECRET` must be replaced with a random value of at least 32 characters;
- `ADMIN_PASSWORD` must be replaced with a strong password;
- `COOKIE_SECURE` remains `false` for local HTTP and becomes `true` only after HTTPS is active;
- `ALLOW_REGISTRATION` remains `false` unless public registration is explicitly required;
- `CORS_ORIGINS` remains empty for the default same-origin topology.

`.env`, `server/.env`, and all runtime data stay ignored by Git and Docker build contexts. Real credentials must never be copied into source archives, logs, or validation output.

## 4. Data, Upgrade, And Rollback

For the public Compose stack, `docker compose down` preserves `howcanvas_server-data`; `docker compose down -v` is destructive and requires a backup first.

The production server keeps its existing bind-mounted `/opt/infinite-canvas/server-data` and `.env.deploy`. Before an update:

1. back up the SQLite database with SQLite's backup API or a stopped-container file copy;
2. archive `.env.deploy`, Compose files, Nginx configuration, and the current deployed commit;
3. upload a Git archive of the exact GitHub commit to a staging directory;
4. verify the staged tracked-file manifest before overlaying source files;
5. run `docker compose -f docker-compose.deploy.yml config`;
6. rebuild and recreate only the services affected by the release;
7. verify container health, `/api/health`, frontend HTML, and authenticated login.

Rollback restores the previous tracked-file archive and configuration, rebuilds the affected services, and restores data only when the new version changed or damaged persistent state.

## 5. Production-Specific Topology

The public default Compose is the portable installation path. The production server continues to use `docker-compose.deploy.yml` because it also serves the Hoosland landing site and domain-specific gateway routes. Production-specific routing must not replace the portable default Compose.

The production deployment directory is not converted into a Git worktree. Alignment is proven by:

- local `HEAD` equals GitHub `main`;
- `.deployed-commit` equals that commit;
- SHA-256 values for every Git-tracked path match between the local commit archive and the server deployment;
- extra server-only files are explicitly excluded from the source manifest.

## 6. Validation Gates

Each release passes these gates in order:

1. **Design gate**: topology, ports, secrets, persistence, upgrade, rollback, and three-end invariants are complete and non-conflicting.
2. **Package gate**: Compose parses; environment examples contain every required setting; frontend and backend source checks pass; an isolated Docker stack builds and passes health, login, restart, and persistence checks.
3. **Documentation gate**: README and detailed docs use only commands exercised by the package gate; referenced files exist; obsolete SSH-only clone and frontend-only Docker instructions are absent.
4. **Alignment gate**: changes are committed and pushed, GitHub checks pass, the exact commit is deployed, all production services are healthy, and local/GitHub/server commit and tracked-file manifests match.

Failure at any gate returns work to that same gate. No later gate may be reported complete until the current gate passes.
