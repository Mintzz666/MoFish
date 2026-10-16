# MoFish collaboration and release policy

## User-approved version hook

The user requested this workflow: only when they accept a version, invoke the release hook to manage it on GitHub. This instruction persists across chats working in this repository.

- Routine edits, previews, and ordinary commits do not trigger a release or version tag.
- Explicit acceptance such as “这个版本可以了，发版”, “确认当前版本”, or an unambiguous “这个版本可以了” about the current build authorizes this hook. Do not ask for the same approval again.
- A question, tentative feedback, or “继续改” is not version acceptance. If the target version is genuinely ambiguous, resolve it before releasing.
- Before the hook, inspect the diff for unrelated changes or secrets, run relevant verification, and commit the reviewed application changes with a descriptive message.
- Run `npm run release -- --dry-run` for a preview of the release. This checks tests, static build and Git history, but does not create commits, tags or pushes.
- On acceptance run `npm run release -- --message "<short summary>"`. If the user specifies a version, add `--version 0.2.0` (example). Without a version the first release uses package.json's version; later releases increment the patch number.
- The hook pushes reviewed HEAD to `origin/main` and an annotated `vX.Y.Z` tag atomically. Never force-push, delete a published tag, or silently merge conflicting remote changes.
- If a push fails, preserve the pending local tag and retry the same version after resolving connectivity. Report the failure; never claim a release without verifying GitHub.
- Report the version number, GitHub tag/commit link, and validation result after success.
- GitHub versioning and Sites deployment are separate. Acceptance for versioning does not by itself require publishing a new Site. If deployment is requested, deploy the exact release commit and report it separately.

## Repository

GitHub: https://github.com/Mintzz666/MoFish

`npm start`: local preview. `npm test`: model tests. `npm run build`: static output in dist/.

Keep MoFish as the product title. Preserve local-first operation; cloud synchronization has not been implemented.

## Hermes / Codex handoff

Read `docs/HERMES-COLLABORATION.md` and `docs/HANDOFF.md` when working on a Hermes development task or reviewing its results. Hermes uses a separate `hermes/<task>` branch and updates the handoff with actual verification evidence. Ordinary development branch pushes are not releases. Do not merge main, tag a product version or deploy during a routine handoff.

When the user asks Codex to assess Hermes's current work, default to read-only review of the specified GitHub branch/commit. Fetch it without overwriting existing local changes; use an isolated checkout/worktree when needed. Report findings and recommendations; modify code only if requested. Record the exact reviewed SHA because an unpushed local Hermes workspace cannot be read here.

## Approved roadmap and role division

The user has requested email/password auth, cloud saves across devices, later shared aquariums, and then improved UI/3D/motion/aquascaping. Read `docs/ROADMAP.md` for sequence and acceptance criteria. Hermes implements the scoped milestone; Codex guides, reviews and manages accepted releases. Do not implement all milestones in a single pass. Email auth must work without a ChatGPT login gate. The recommended initial stack is independent Cloudflare static hosting plus Supabase Auth/Postgres; no home server or extra D1 database is needed for the initial milestone. No cloud features are claimed complete merely because they appear in this roadmap.
