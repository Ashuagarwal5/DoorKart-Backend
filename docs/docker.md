# Backend with Docker (API + PostgreSQL)

`Backend/compose.yaml` starts the database and the API on their own; the repository-root
`compose.yaml` additionally starts the admin panel. Docker with Compose is required.
Run everything below from the `Backend` folder.

## First start

```bash
cp .env.docker.example .env.docker
```

Edit `.env.docker`: set a strong `POSTGRES_PASSWORD`, a `SECRETS_KEY` (`npm run secrets:key`),
and `CORS_ORIGINS` (the admin panel's address). Then:

```bash
npm run docker:up
```

The API answers at `http://localhost:4000/health` (change the port with `API_PORT`). Pending
migrations are applied automatically before the API starts. The database and uploaded media
live in the named volumes `postgres_data` and `uploads`.

## Commands

| Command | What it does |
|---|---|
| `npm run docker:up` | Build and start the database and API in the background |
| `npm run docker:down` | Stop and remove the containers (data volumes are kept) |
| `npm run docker:logs` | Follow the API logs |
| `npm run docker:ps` | Show container status and health |
| `npm run docker:migrate` | Re-run pending migrations inside the running API container |
| `npm run docker:admin-create` | Create the first admin (see below) |

Without npm: `docker compose --env-file .env.docker <command>`.

## Create the first admin

The values come from your shell, not from a file, so the password is never stored.

```bash
ADMIN_SEED_EMAIL=owner@example.com ADMIN_SEED_NAME=Owner ADMIN_SEED_PASSWORD="a-long-passphrase" npm run docker:admin-create
```

On Windows PowerShell set `$env:ADMIN_SEED_EMAIL`, `$env:ADMIN_SEED_NAME` and
`$env:ADMIN_SEED_PASSWORD` first, then run `npm run docker:admin-create`.

## Backups and restore

```bash
docker compose --env-file .env.docker exec -T db pg_dump -U buynest buynest > backup.sql
```

(Use your `POSTGRES_USER` and `POSTGRES_DB` if you changed them.) Back up the `uploads` volume
too: the database stores only each file's name. To restore into an empty database:

```bash
docker compose --env-file .env.docker exec -T db psql -U buynest buynest < backup.sql
```

## Updating

Pull the new code, then `npm run docker:up` again. Data volumes are kept and new migrations run
on start.

## Danger

`docker compose --env-file .env.docker down -v` deletes the database and uploads permanently.
Never run it on production.

## Notes

- To reach the database from your machine, uncomment the `ports` lines under `db` in
  `compose.yaml` (bound to `127.0.0.1` only).
- `.env.docker` is ignored by Git. Never commit it, and never put the Firebase key file in the repo.
- Push notifications: see `push-notifications-v1.md`.
