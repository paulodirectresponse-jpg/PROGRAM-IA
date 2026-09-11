# Implementation status — 2026-09-11

This is a working revision, not an official production release.

## Current development rule

The current agent/reviewer implementation is intentionally frozen at commit `486ce9a87e6548591ff57158f5957d80118e5a8d`.

Product-completion work continues on branch `codex/product-completion` and must not change the programmer/reviewer loop until the rest of the product is complete.

The ordered completion plan is documented in `PRODUCT_COMPLETION_PLAN.md`.

## Corrected and verified so far

- Removed automatic authentication as `user-default`.
- Firebase login passes an ID token; backend retrieves identity from Firebase Auth. Browser-supplied email and uid are not trusted.
- Removed local password-login fallback from public backend routes.
- Enforced project ownership and CSRF checks; added client CSRF header transport.
- Scoped provider configuration, skills, projects and secrets to the authenticated user.
- Removed host credential fallback for logged-in users.
- Consolidated integration settings with service-specific fields and actual read-access tests.
- AI provider API keys belong to Modelos de IA; external-service credentials belong to Integrações.
- Removed fake Firebase/custom-key success responses and false build/preview pass results.
- Added named pre-change checkpoints and path validation before application.
- Checkpoint restoration now preserves binary files and removes files created after the selected version.
- Restoration creates a preservation checkpoint before changing the workspace.
- Preserved URLs and source text when parsing structured JSON model responses.
- Excluded runtime database and encryption material from source distribution.
- Added a bounded programmer/reviewer correction loop with cancellation and malformed-verdict rejection.

## Verification

GitHub Actions run 34623662590 passed successfully on commit `486ce9a`.

The successful CI run executed:
- dependency installation;
- TypeScript typecheck;
- foundation tests;
- HTTP authentication/isolation tests;
- reviewer-loop tests;
- original test suite;
- production build;
- Chromium installation;
- Playwright browser test;
- browser artifact upload.

## Product work still required while the agent stays frozen

1. Clean and consolidate Settings/Auth UI and remove legacy credential/login paths.
2. Complete checkpoint/version restore behavior and GitHub-safe synchronization.
3. Complete project create/import ZIP/import GitHub/duplicate/delete/export flows.
4. Finish GitHub end-to-end synchronization, binary push and conflict handling.
5. Add real Cloudflare deployment/domain actions.
6. Add supported Supabase database/storage actions.
7. Complete Firebase project integration and real product-auth verification.
8. Complete Skills CRUD/scopes without changing agent orchestration.
9. Perform security/audit/data hardening and credential-history remediation.
10. Finish UX/error states and broad Playwright coverage.
11. Merge a fully verified product-completion branch into main and publish an official release.

## Explicitly postponed

The following agent-specific work is paused until the product-completion plan is finished:
- isolated execution worker for generated projects;
- build/test/browser evidence fed back into the agent loop;
- redesign of programmer/reviewer architecture;
- multi-agent orchestration;
- cost/time/token control for autonomous loops.

## Security note

A runtime database and master key existed in older public commits. Removing them from the current tree does not erase Git history. Any real credentials that may have been stored there must be rotated, and repository-history remediation must be completed before production release.
