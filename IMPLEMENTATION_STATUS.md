# Implementation status — 2026-09-11

This is a working revision undergoing release validation.

## Corrected in this revision

- Removed automatic authentication as `user-default`.
- Firebase login passes an ID token; backend retrieves the identity from Firebase Auth. Client email and uid are not trusted.
- Removed local password-login fallback from public routes.
- Enforced project ownership and CSRF checks; added client CSRF header transport.
- Scoped provider configuration, skills, and secrets to the authenticated user; migrated legacy global provider/skill uniqueness.
- Removed host credential fallback for logged-in users.
- Consolidated integration settings with service-specific fields and actual read-access tests.
- Removed fake Firebase/custom-key success responses and false build/preview pass results.
- Added named pre-change checkpoints and path validation before application.
- Preserved URLs and source text when parsing structured JSON model responses.
- Excluded runtime database and encryption material from source distribution.
- Completed create, edit, and delete flows for user-owned Skills.
- Added an explicit explanation for Firebase authorized-domain failures in temporary previews.

## Verification

The release workflow runs typecheck, foundation and HTTP security tests, the original test suite, production build, and mandatory-login browser verification. Merge is allowed only after this workflow succeeds.

## Still required for the requested complete product

- Isolated execution worker for generated projects, actual build/test/browser evidence, and stop/cost/time limits.
- Multi-agent programmer/reviewer orchestration is intentionally paused for product redesign. It is excluded from this release.
- Full deployment actions and domain management for Cloudflare, DB/storage actions for Supabase, and project setup actions for Firebase. Current new integration tests verify read access only.
- Validate ZIP/binary/checkpoint recovery, conflicting remote Git changes, and persisted proposals end-to-end.
- Test Firebase account signup and Google login against the configured product project; enable providers and authorized domains there.
- Production hosting and a desktop packaging/update pipeline for this web codebase; the old Forge-Agent installer is a separate application.
- Rotate any real credentials that were stored in the previously committed database. Removing files from the latest commit does not erase Git history.

Sources used for protocols: https://firebase.google.com/docs/reference/rest/auth and https://supabase.com/docs/reference/api/v1-list-all-projects .

