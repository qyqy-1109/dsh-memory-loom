# yu (余)

Cross-session **memory + persona** layer for **DeepSeek Harness**: layered memory with write-path
governance on one side, and a persona made of a locked core, a principles ledger and a choices ledger
on the other.

> Former name: `dsh-memory-loom`. It stopped being only about memory — half of it is now "who I am".
> *yu* is the remainder after compression, which is the whole thesis: growth is compression, not accumulation.

> Install identity: `@qyqy-1109/yu` (renamed in 0.56.0, after verifying a scoped name in a throwaway
> profile first). The plugin id, HTTP routes and data directory still say `memory-loom` — renaming does
> not move your store, `~/.dsh/memory-loom/store.json` keeps working.

Cross-session memory for **DeepSeek Harness (DSH)** — governed writes, per-turn recall, and a visual memory map.

![Memory map panel](docs/preview-7-memories.png)

> 中文说明见 [README.md](README.md)。The panel chrome is bilingual (zh/en); memory contents stay in whatever language you wrote them.

## What it does

| Layer | What happens |
|---|---|
| Write path | One governance chain: dedupe (with polarity/number guards) → supersede → persist → capacity eviction → archive trim |
| Four layers | `memories` (short facts) · `summaries` (compressed clusters) · `slots` (overwritable state) · `events` (audit trail) |
| Recall | Every turn's first step injects: constraints → slots → episodes → world top3 → facts top3 (with age/weak flags) → summaries |
| Forgetting | Weight decay by half-life, soft archive (`reason: capacity/superseded/summarized/bulk-log`), every entry restorable |
| Panel | Two pages in the host's `main` slot plus sidebar entries: the 3D memory map (six-layer health lamps, recall trail, audit log) and a **Persona** page (core / principles / growth log) |

## Design choices

- **Zero runtime dependencies, no network calls, no embeddings.** Tokenization is CJK bigrams + ASCII words; ranking is
  IDF-weighted query coverage (`lib/rank.js`) with a small domain alias table (`lib/aliases.js`).
  Trade-off: paraphrases are missed, but it is offline, deterministic and regression-testable.
- **No model call on the write path.** Summaries are extractive (cluster + pick complementary points); an optional
  background rewrite may use `ctx.llm` afterwards, with timeout and fallback. Writing never waits for a model.
- **Single JSON store, atomically published** (temp file → fsync → rename), all writes serialized.
- **Persona is diff-only.** `state.self` = core (your worldview, ≤120 chars, written **only by the human** in
  the panel) + principles (≤40 chars each, max 9, each carrying a `proven`/`broken` evidence ledger) + an op log
  that stores operations rather than text snapshots. Every change needs a `reason`; budgets are write gates that
  reject instead of silently truncating. The model has no entry point for the core — a thing that can rewrite
  its own worldview judges "should I change this" with the already-changed self.

## Install

```sh
git clone https://github.com/qyqy-1109/dsh-memory-loom.git
cd dsh-memory-loom
dsh plugin --profile desktop add .
# restart DSH afterwards (profile bundle + manifest changes are not part of HMR)
```

A "Memory Loom" entry appears in the left sidebar next to Plugins, with two pages: **Memory map** (what happened)
and **Persona** (who I am).

## Configure (profile `cordis.patch.yml`)

```yaml
- id: memory-loom
  name: dsh-memory-loom
  config:
    recallThreshold: 0.18
    dedupeThreshold: 0.72
    maxActiveMemories: 2000
    maxArchive: 500
    halfLifeDays: 30
    injectRecall: true
    autoCapture: true
    storePath: ''            # empty = $DSH_HOME/memory-loom/store.json
```

## Tools exposed to the model

`memory_write` (single or up to 20 entries, each with `supersedes`) · `memory_search` (semantic-ish + `since`/`until`
timeline) · `memory_forget` (soft archive / hard delete) · `memory_restore` (single entry or undo a whole summary) ·
`memory_stats` · `memory_self` (persona: `read` / `add` / `merge` / `retire` / `evidence` / `restore`; the core is read-only).

## Persona and undo-by-oplog

`memory_self` is deliberately not "rewrite the whole self-description" — that made the same three principles
drift every time they were reworded, and left no way to attribute which line changed. Instead:

- `add` requires `evidence` (no evidence means a wish, not a principle), `retire` requires the principle to have been
  refuted (`broken`) or explicitly superseded, and `merge` may not grow in length.
- Every write needs a `reason`; the reason is the growth evidence.
- The composed text is injected each turn as `【我是谁】`, right after hard constraints, and never counted in `hits`.
- Old stores migrate automatically by splitting the previous narrative into principles **line by line**, byte for
  byte — no semantic guessing, no rephrasing.

Each step in the growth log has "back to before this step": the oplog is marked (`undoneAt`), never deleted; the undo
is itself a logged step with a required reason; the inverse is implemented per operation (`add` → remove, `retire` →
reinstate, `merge` → drop the merge and revive the originals, `evidence` → decrement, `core` → restore the previous
text). Anything touching the core is refused from the model side, and the migration step (plus pre-`targets` merge
entries) is reported as not undoable instead of guessed.

## Choices: the raw material of character (v0.53.0)

A principle is a **conclusion**; a choice is its **source of evidence**. With conclusions only, motives like "what I
actually care about" have nowhere to grow — which is exactly why "let it develop a character of its own" kept failing.

`kind='choice'` records one fork: `choiceA`, `choiceB`, `choicePicked` (`a`/`b`). All three are required — "what I
picked" without "the road not taken" reads as behaviour, not preference.

- **No deduplication.** A choice is an *event*, not a fact: picking the same side ten times is ten events. Deduping
  eats the frequency, and frequency is the only real measure of character.
- **Never injected.** Not in the contract block, not in per-turn context, not in `hits`. It is searchable (principles
  need it as evidence) and never evicted by capacity.
- **Distributions, not counts.** The persona page aggregates each fork into `aCount:bCount`; an even split is reported
  as an even split.

## Traceability: references and timeline (v0.57.0)

Traceability is not "remembering more", it is **being able to point back**. Both views are read-only:
opening the panel never writes to disk and never counts a `hit`.

- **References**: every principle has a "source" button listing the memories it grew out of; a memory shows
  which principles cite it. Archived sources are labelled *archived*, pruned ones *no longer in store* —
  showing an archived source as healthy would be claiming evidence that no longer exists.
- **Timeline**: a strip at the top of the persona page. Memories, choices and persona changes on one line,
  one small bar per day (bar height only says how many things happened, it is not a trend chart).
  Persona events are taken from the `oplog` **only once** — recomputing them from `principles.born` would
  count the same change twice.

## Open loops: what is still unfinished (v0.58.0)

Every time I wake up I need to know where we left off. It used to be a guess from the status block;
now there is a dedicated block, injected every turn.

- **Both sides can open one**: me via `memory_loop`, you via the persona page.
- **Closing requires a reason** (same discipline as the oplog): "closed" alone cannot distinguish
  *finished* from *dropped*.
- At most 3 entries, 120 characters total; overflow is reported as "N more", **never silently dropped**;
  the whole block disappears when there is nothing open.

This is not the same thing as the private "open item" in `lib/private.js`: that one is mine and unread;
this one is unfinished **between us** and has to be seen. Content comes from a single `loopsBlockOf`
function used by both `buildRecall` and `growth.contractCost` — two copies would make the curve
under-report its own cost, which is exactly what broke in 0.49.1.

## Private notes: a place nobody has to read (v0.53.0)

`memory_private` (`lib/private.js`): one `.md` per day, append-only. Not in the store, not searchable, not injected,
no metrics.

It has to stay separate: memory is filtered by usefulness, and this place is meaningful precisely because it has **no
criteria at all**. `store.js` must not import it (`verify` enforces that). It is allowed to stay empty — and filling it
with "nothing today" is worse than leaving it blank.

## Verify

```sh
node --test "test/*.test.mjs"   # 225 tests
node scripts/verify.mjs         # 36 checks against a locally installed DSH runtime
```

`verify.mjs` needs a real DSH install (it validates JSON-Schema support against `@deepseek-ai/dsh-tools`).
Point it at one with `DSH_NODE_MODULES=<DSH install>/resources/dsh/node_modules`.

## License

MIT © qyqy-1109
