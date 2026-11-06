# orch

Local-agent development pipeline: Opus writes and edits specs in Claude Code,
GPT and the workers run in OpenCode V2, and a stateless script drives the
post-worker flow (CI, smoke, review, merge) from GitHub state. No per-Issue LLM
manager.

Status: pilot. Start with [`AGENTS.md`](AGENTS.md).
