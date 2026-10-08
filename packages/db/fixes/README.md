# Production data fixes

Changes to production **data** (not schema) go here as reviewed SQL files. An agent writes the fix and the
owner approves it by merging the PR. A GitHub Action then applies it as the limited `data_fixer` role. No
agent holds a production write credential, and the owner never pastes SQL into a console.

Schema changes stay in `packages/db/drizzle/` migrations. A fix can't run DDL.

## How it works

- Each fix is one file, `NNNN-<kebab-slug>.sql`, numbered from `0001` with no gaps. Fixes apply in number
  order, each **once**.
- On every push to `main` that touches a fix file (or a manual run from the Actions tab),
  `.github/workflows/data-fixes.yml` runs `pnpm --filter @opusfinder/db run fixes:apply`
  (`scripts/apply-fixes.ts`). For each fix not yet recorded in the `data_fixes` table, it runs the file and
  inserts the record in **one transaction**, so a fix is applied and recorded together, or not at all. It
  stops at the first failure.
- The job runs in the `data-fixes` GitHub Environment. Only `main` can deploy to it, and only it holds
  `DATA_FIX_DATABASE_URL`. No pull-request job can see that secret.
- `data_fixer` can SELECT/INSERT/UPDATE/DELETE only `companies`, `jobs` and `source_runs`, plus SELECT/INSERT
  on `data_fixes`. It has nothing on user, auth, CV, profile, preference, digest or health tables, and it
  can't run DDL. The grants are in `src/fixer-role.ts`. To widen them, change that list in a reviewed PR,
  then the owner re-runs the setup command.
- The PR check `pnpm guard:fixes` (in `ci.yml`, no secrets) enforces the file rules below. It also fails if
  a PR edits, renames or deletes a fix that is already on `main`. The runner adds a backstop: it refuses to
  run if an applied fix's file no longer matches the sha256 recorded when it ran.

## Writing a fix (agents)

Copy the shape of `0001-merge-case-variant-boards.sql`:

1. **Header comment.** Say why the fix is needed, what it changes (tables, columns, which rows), the
   expected effect, and any deploy-order dependency.
2. **Preview block.** Put read-only `SELECT`s in one block comment that starts with `/* preview`. They show
   the rows the fix will touch and the numbers its guards assume. The runner never executes them; they are
   a comment.
3. **Apply SQL.** Plain statements and/or `DO $$ ... $$` blocks. Each fix must:
   - **Guard** with `RAISE EXCEPTION` whenever the database no longer matches the preview: row identity
     (id + the key columns you expect), state (e.g. still active), and sane count bounds on what it changes.
     An exception rolls the whole fix back, and nothing is recorded.
   - **Report** with `RAISE NOTICE` how many rows each step changed (`GET DIAGNOSTICS n = ROW_COUNT`).
   - **Be safe to re-run**: idempotent (`WHERE active` before setting `active = false`) or guarded.
   - **Not contain** `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT` (the runner owns the transaction),
     `CREATE`/`ALTER`/`DROP`/`TRUNCATE`/`GRANT`/`REVOKE`, or `EXECUTE` (dynamic SQL hides the real statement
     from review). These words are allowed in comments and string literals.
4. Run `pnpm guard:fixes` locally, then open a PR containing only the fix (plus anything it depends on).

Never edit a fix that has been applied. Write a new fix instead. A merged fix that **failed** is different:
it was rolled back and never recorded, and it blocks every later fix until it applies. Correct it in place
in a new PR. The immutability check flags that edit, and the owner merges over it after confirming in the
Actions summary that the fix failed.

## Previewing (orchestrator)

Run the `/* preview` queries through the read-only `neon-ops` agent and paste the results into the PR. The
owner reviews the fix against what they show.

## Approving (owner)

Review the PR (header, preview results, guards) and merge it. That merge is the approval. The Action applies
the fix within a minute or two.

## Seeing the result

Open the **data-fixes** run in the repo's Actions tab. Its job summary lists each fix applied, with its
`NOTICE` lines, or the failure and its error. A failed fix was rolled back completely. `SELECT * FROM
data_fixes ORDER BY id` shows what has been applied, from which commit, and when.

## Undoing a fix

Write a **reverse fix**: a new numbered file that puts the rows back, with its own preview and guards (the
original's NOTICE lines and the preview results say what changed). As a last resort, Neon's point-in-time
restore can roll the whole database back to before the fix. It also discards every other write since then,
so the owner does this in the Neon Console.

## One-time setup (owner)

In a normal terminal (outside the agent sandbox), with `gh` logged in and `packages/db/.env` holding your
`DATABASE_URL`:

```sh
pnpm db:migrate                                         # creates the data_fixes table (migration 0024)
pnpm --filter @opusfinder/db run data-fixer:setup       # role + grants, Environment, secret
```

The setup command does the following:

- Creates or updates the `data-fixes` Environment so only `main` may deploy to it.
- Creates `data_fixer` with plain SQL, or rotates its password if it exists. It does not use the Neon
  Console, because Console/API roles join `neon_superuser`. It then resets the role's grants.
- Pipes the new connection string into `gh secret set DATA_FIX_DATABASE_URL --env data-fixes` on stdin.

It never prints the password or the connection string. Re-run it any time to rotate the password. Add
`-- --dry-run` to print the SQL (password redacted) without touching anything.
