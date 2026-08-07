-- Invariant, DB-enforced: every stored email address is lowercase (#170).
--
-- Postgres compares text case-sensitively under this database's `en_US.utf8`
-- collation, and the unique keys on Account, Teacher and Student are plain
-- btree over the raw column. Without this constraint `Foo@x.com` and
-- `foo@x.com` are two distinct keys: sign-in looks accounts up with the raw
-- string and misses (answering "if an account exists, a magic link has been
-- sent" either way), and the pre-create uniqueness gates in
-- `POST /api/auth/student-signup` and `POST /api/teachers` walk straight past
-- both the gate and the index, producing a second Account for one human.
--
-- `emailField` in `src/lib/schemas.ts` normalises everything arriving over
-- HTTP. This constraint covers what does not: `prisma/seed.ts`, the five
-- synthesized `deleted-<uuid>@deleted.invalid` addresses `gdpr.ts` writes
-- during erasure (uuid is lowercase hex, so they satisfy it), test fixtures,
-- and psql. Those are rejected rather than rewritten — a writer that skips the
-- schema layer should fail loudly.
--
-- Mirrors `20260805074500_invitation_check_constraints`, which did the same for
-- the two columns #166 added. Those two are already constrained and untouched
-- here.

-- Backfill first, because `ADD CONSTRAINT ... CHECK` validates rows that
-- already exist — measured:
--
--   ERROR:  check constraint "probe_lower" of relation "probe_check"
--           is violated by some row
--
-- so on any database holding one mixed-case row, the constraint below fails
-- without this. A measured no-op on both `ethical_yoga` (711 accounts) and
-- `ethical_yoga_test` (10,636) at authoring time, and fair.yoga has no
-- production data — this exists for a contributor's database nobody has
-- measured, where `db:reset` would be the alternative and would destroy their
-- work.
--
-- There is deliberately NO collision pre-check here. Two rows differing only
-- in case would collide on the unique key, and an earlier draft guarded that
-- with a `DO $$ ... RAISE EXCEPTION` block. Both of its justifications were
-- measured false. Prisma 6.19.3 runs each migration in a transaction, so a
-- collision rolls the whole file back having changed nothing — verified by
-- applying a deliberately-colliding migration and confirming its first
-- statement left no row behind. And Postgres's own error is *better* than the
-- one that block raised, because it names the offending address rather than
-- counting them:
--
--   ERROR: duplicate key value violates unique constraint "Account_email_key"
--   DETAIL: Key (email)=(foo@x.com) already exists.
--
-- MagicLinkToken cannot collide at all: its `email` column carries no unique
-- index.
UPDATE "Account"        SET email = lower(email) WHERE email <> lower(email);
UPDATE "Teacher"        SET email = lower(email) WHERE email <> lower(email);
UPDATE "Student"        SET email = lower(email) WHERE email <> lower(email);
UPDATE "MagicLinkToken" SET email = lower(email) WHERE email <> lower(email);

ALTER TABLE "Account" ADD CONSTRAINT "Account_email_lowercase_check"
  CHECK (email = lower(email));

ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_email_lowercase_check"
  CHECK (email = lower(email));

ALTER TABLE "Student" ADD CONSTRAINT "Student_email_lowercase_check"
  CHECK (email = lower(email));

ALTER TABLE "MagicLinkToken" ADD CONSTRAINT "MagicLinkToken_email_lowercase_check"
  CHECK (email = lower(email));
