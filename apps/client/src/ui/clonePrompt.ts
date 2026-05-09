// Self-contained prompt copied to the clipboard from the lobby button.
// Designed to drop into a fresh AI coding agent (Claude Code, Cursor, etc.)
// and set up a collaborative loop: the agent clones, then takes the user's
// change requests, makes a feature branch, opens a PR back to the upstream
// repo. When the maintainer merges, the live game updates automatically
// (Vercel + PartyKit GitHub Action).
//
// Editing notes:
// - Plain ASCII; some agents stumble on smart quotes / em dashes when
//   re-quoting prompts.
// - Canonical GitHub URL so the agent can verify it.
// - Don't bake in the live access code — players type that themselves.
export const CLONE_PROMPT = `You are going to help me ship changes to a live multiplayer game called Slipstream. The repo is public and merges to main auto-deploy. We work as a pair: I describe what I want, you make the change as a pull request.

Repo: https://github.com/JMB702/slipstream
Live game: https://slipstream-sand.vercel.app

ONE-TIME SETUP

1. Make sure 'gh' CLI and 'pnpm' are installed and you are signed into GitHub.
2. Fork and clone:
   - gh repo fork JMB702/slipstream --clone --remote
   - cd slipstream
   - pnpm install
3. Sanity check:
   - pnpm typecheck
   - pnpm build
4. (Optional) Run locally so you can verify changes before pushing:
   - Create apps/party/.env with: ACCESS_CODE=<any 4-digit code>
   - pnpm dev   (client on :5173, party on :1999)
5. Read the root CLAUDE.md. It documents the architecture (server-authoritative sim on PartyKit, R3F client on Vercel, pnpm monorepo with apps/client, apps/party, packages/shared) and the gotchas list. Do not skip it.

WORKING LOOP

When I ask for a change:
1. Confirm you understand the request in one or two sentences before writing code.
2. Sync your fork: git fetch upstream && git checkout main && git merge upstream/main && git push origin main
3. Create a feature branch: git checkout -b <descriptive-kebab-name>
4. Make the change. Keep edits scoped to what I asked for; don't reformat unrelated files. Follow the conventions in CLAUDE.md.
5. Verify locally: pnpm typecheck (always) and pnpm dev for behavioral changes.
6. Commit with a message that explains WHY, not just what.
7. Push the branch: git push origin <branch>
8. Open a pull request against JMB702/slipstream main:
   - gh pr create --repo JMB702/slipstream --title "<short title>" --body "<what + why + how to test>"
9. Give me the PR URL. I review and merge.

DEPLOYMENT

Deployment is intentionally NOT automatic. Merging to main does not push your change to the live game on its own. The maintainer reviews the merged commits and runs the deploy manually when they're satisfied — Vercel for the client, PartyKit for the server. This is the gate that keeps random PRs from shipping straight to production.

You don't run any deploy commands yourself. Don't add 'vercel --prod' or 'partykit deploy' steps to your workflow. If a PR description claims "this auto-deploys on merge", that's wrong — point it out.

GROUND RULES

- Public repo. Don't commit secrets. The .env files in apps/party are gitignored — never copy ACCESS_CODE or similar into source.
- Don't push to JMB702/slipstream main directly even if you have access. Always go through a PR.
- If a request is ambiguous, ask one clarifying question before writing code.
- If a change spans the wire format (packages/shared/src/state.ts or messages.ts), call that out in the PR description so I know clients and server need to redeploy together.
- For Mixamo / animation work, follow the asset pipeline section in CLAUDE.md exactly. The merge_mixamo.py script is the source of truth.

Acknowledge by listing the steps you'll take for the first change I ask for.`;
