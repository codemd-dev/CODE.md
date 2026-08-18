# CODEMD Marketing TODO

Working doc. Go through phases top to bottom, check items off as you complete them. Don't skip to Phase 4 — the launch channels (HN/PH/Reddit) burn their one shot per platform, and they perform much better with foundation + seed users already in place.

## Where we are today (baseline, 2026-08-14)

- VS Code Marketplace: **5 installs**, 0 ratings, 0 reviews
- GitHub (`codemd-dev/CODE.md`): **0 stars**
- Extension is marked "pre-release preview" in the README
- Product has two names in the wild: **CODEMD** (extension displayName) and **CODE.md** (GitHub repo name/description) — this split is itself an awareness tax
- Landing page (codemd.dev) and README are both reasonably clear on features, but lead CTAs point at the web dashboard ("Connect Repo") rather than the actual distribution channel (Marketplace install)

The core problem, as you said, is awareness + positioning — not product quality. Everything below is sequenced to fix positioning first, build proof (real users, testimonials) second, then spend the one-shot launch channels last, once there's something to point people at besides "0 stars."

---

## Phase 0 — Nail the positioning (do this before anything else)

- [ ] Pick **one name** and use it everywhere: extension UI, README title, GitHub repo description, Marketplace short description, landing page, all future posts. (Recommendation: **CODEMD** as the product/brand, `CODE.md` only as the name of the generated artifact file it produces — that's already how the README frames it internally.)
- [ ] Write a single canonical one-liner and reuse it verbatim across Marketplace, README, LinkedIn bio, Dev.to bio, HN/PH taglines. Candidate, refine as needed:
  > "CODEMD catches breaking changes before you commit — and gives Claude, Cursor, and Codex the same callgraph instead of letting them re-scan your repo."
- [ ] Reconcile the GitHub repo description ("a generated repository map for LLMs and coding agents") with what the extension actually leads with now (pre-commit risk + blast radius, not just a repo map). Update the repo's "About" description on GitHub to match.
- [ ] Decide how to frame "pre-release preview": either keep it but pair with a concrete number once Phase 2 lands ("used across N repos"), or drop the caveat once you have 20+ real installs and no major open bugs. Don't launch publicly (Phase 4) while the README still reads as pre-alpha.

## Phase 1 — Foundation assets (prerequisites for every channel below)

### 1a. VS Code Marketplace listing
- [ ] Add a `keywords` array to [package.json](package.json) — it currently has none, and Marketplace search indexes on it. Suggested: `callgraph`, `code review`, `blast radius`, `pre-commit`, `impact analysis`, `MCP`, `claude`, `cursor`, `codex`, `static analysis`, `AI coding agent`.
- [ ] Expand `categories` beyond `["Other"]` — add whichever of `Linters`, `Testing`, `Visualization`, `Machine Learning` genuinely fit; this is what browse/filter surfaces use.
- [ ] Add a `galleryBanner` (color + theme) to package.json for a branded Marketplace header instead of the default blank one.
- [ ] Tighten the Marketplace short `description` field to name Claude/Cursor/Codex explicitly — those are searchable terms your buyers actually type.
- [ ] Add an in-extension, non-annoying ratings nudge (e.g. after the 3rd successful "Check Uncommitted Edits" run, a one-time prompt) — 0 reviews today, and the first few reviews matter disproportionately for conversion.

### 1b. GitHub README / repo
- [ ] Record one 20-30s GIF or short screen capture of the real flow: open a repo → **Generate CODEMD** → **Check Uncommitted Edits** → blast radius report → click into a caller. This is the single highest-leverage asset — reuse it in the README hero, Marketplace, Reddit/HN/PH posts, and LinkedIn.
- [ ] Move that GIF above the fold in [README.md](README.md) (currently the two JPGs are static and appear after several paragraphs of text).
- [ ] Add badges to the README top: Marketplace version/install count, license, "Works with Claude Code / Cursor / Codex."
- [ ] Add a short "Why CODEMD" section that contrasts it with (a) grep/manual review and (b) generic AI repo-summarizer tools — the differentiator is local-first + MCP-native + pre-commit risk scoring, not just "a map file."
- [ ] Update the GitHub repo's short description/topics (see Phase 0) so search and social-card previews match the README.

### 1c. Landing page (codemd.dev)
- [ ] Align homepage copy with the Phase 0 one-liner.
- [ ] Make "Install from VS Code Marketplace" the primary CTA for the developer-facing sections — the dashboard/"Connect Repo" flow is a secondary path, but the actual distribution funnel is the extension install.

---

## Phase 2 — Get 20-50 real developers using it (before any public launch post)

Why before Phase 4: a Show HN / Product Hunt / Reddit post that links to "5 installs, 0 stars" gets buried. A handful of real testimonials and a non-zero install trend changes how those posts land, and gives you bug reports before strangers find the bugs for you.

- [ ] Build a simple tracking sheet: name, channel, installed? (Y/N), feedback given, quote usable for marketing (Y/N).
- [ ] Direct outreach — personal network and colleagues who already use Claude Code, Cursor, or Codex daily. Ask for a specific action: install, run Generate + one Check Uncommitted Edits on a real repo, then a 10-min call or short async form.
- [ ] Submit CODEMD to MCP server directories (mcp.so, Smithery, PulseMCP, Glama, awesome-mcp-servers lists) — the people browsing these are already your exact target audience and it's a durable, low-effort listing (not a one-shot post).
- [ ] Targeted community outreach (Cursor Discord, Latent Space Discord, relevant Slack/Discord dev communities) — 1:1 DMs or community "what I built" threads where allowed, not a cold public ad post.
- [ ] Check each subreddit's self-promotion rules before posting anything in Phase 2 (many require a >10:1 non-promotional history or specific flair) — use this phase for low-key mentions/replies where genuinely relevant, save the actual launch post for Phase 4.
- [ ] Milestone gate: **20+ installs and 5 usable testimonials** before starting Phase 3 content. **50+ installs** before Phase 4 (Product Hunt in particular rewards existing momentum).

---

## Phase 3 — Content trail (2ish weeks, before the launch spike)

Goal: when someone searches "CODEMD" after seeing the HN/PH post, there's already a footprint, not just the GitHub repo.

- [ ] Dev.to: 1-2 genuinely technical posts, not ads — e.g. "Detecting breaking Python signature changes before commit" or "Giving Claude Code a real callgraph via MCP instead of full-repo re-scans." Link back naturally, don't lead with the pitch.
- [ ] YouTube: one 3-5 min demo (screen recording + voiceover) showing the Blast Radius Report on a real open-source repo. Production value doesn't matter; showing the actual "aha" moment does.
- [ ] LinkedIn: 2-3 posts in a builder voice, not corporate — (1) the problem story ("agents kept breaking callers I didn't know existed, so I built this"), (2) the demo clip, (3) an MCP/agent-tooling trend take that mentions CODEMD naturally.
- [ ] Spread these over ~2 weeks leading straight into Phase 4.

---

## Phase 4 — Launch week (coordinated, spend the one-shot channels together)

- [ ] **Hacker News (Show HN):** "Show HN: CODEMD – pre-commit blast-radius analysis + MCP context for Claude/Cursor/Codex." Working demo link, genuine builder story as the first comment, post Tue-Thu ~8-10am ET.
- [ ] **Product Hunt:** prep gallery images + GIF, write the maker's first comment, line up Phase 2 seed users to check it out and comment on launch day (ask them to engage, not to vote — PH penalizes vote brigading).
- [ ] **Reddit:** r/vscode, r/ClaudeAI, r/cursor, r/ChatGPTCoding, r/programming — tailor the post per subreddit, don't cross-post identical text, re-confirm each sub's self-promo policy right before posting.
- [ ] Run all three in the same week so cross-traffic compounds (HN readers checking GitHub right as PH/Reddit traffic also lands helps the stars/installs trend look real, not staged).

---

## Phase 5 — Sustain

- [ ] Weekly: check Marketplace install/uninstall trend; respond to every GitHub issue and review within 24h.
- [ ] Monthly: one new piece of content (Dev.to or YouTube) tied to an actual shipped feature, not a generic recap.
- [ ] Once install count is meaningful, loop the number back into the Marketplace description and README badge (Phase 1) — social proof compounds.
