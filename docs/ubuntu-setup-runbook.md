# Ubuntu / WSL2 development setup

Prepare Linux-native tools for `orch` and the selected project. This guide does
not install a concrete orchestration platform or change machine configuration.

## Filesystem and executable paths

Use a Linux filesystem for active repositories and worktrees. On Ubuntu 22.04+
or WSL2 Ubuntu, prefer paths under `/home`; avoid `/mnt/c` for active work because
cross-filesystem metadata and file watching are less predictable.

In WSL2, verify that Linux commands resolve to Linux executables. If Windows PATH
injection is the cause of incorrect resolution, the operator can configure:

```ini
[interop]
appendWindowsPath=false
```

That setting belongs in the distribution's `/etc/wsl.conf`, outside the repository.
Apply an intentional WSL configuration change by shutting down the distribution
from Windows and starting it again.

## Base tools and secure GitHub access

```bash
sudo apt update
sudo apt install -y git curl build-essential
```

Install GitHub CLI from its official package source and authenticate through its
normal device or browser flow. Verify access without printing credentials:

```bash
gh --version
gh auth status
```

Keep tokens out of repository files, shell history, tracked configuration, and
Issue/PR text. Use the provider's normal secure credential store.

## Declared native Node/npm runtime

When the selected project declares Node and npm versions, install matching
Linux-native tools and check them before installing dependencies:

```bash
node --version
npm --version
```

Use the project's committed runtime declaration or pin. Its package engines and
CI must agree with that declaration; do not create a second version authority.
For an npm project with a committed lockfile, install frozen dependencies from
its root with `npm ci --include=dev`, then run its documented checks.

Follow [native execution rules](../AGENTS.md#runtime-and-command-boundaries).
Do not add a second TypeScript launcher, emitted JavaScript build, `tsx`,
`ts-node`, or a fallback Node version. This documentation-only orch checkout has
no package manifest or declared Node/npm version; pack-specific install and
verification commands do not apply.

## Agent tools and project workflow

Install only the agent and reviewer CLIs selected by the
[roles table](../AGENTS.md#roles-and-runtimes). Verify each executable directly in
the shell that will run it, with credentials in its secure store. Machine-local
configuration stays outside the repository.

Use the selected repository, default branch, live Issue, and isolated worktree.
Follow its scope and verification commands. The [execution flow](flow.md) owns
handoff, CI, smoke, review, and authorized merge/adoption; setup adds no alternate
review or delivery route.

## Diagnostics and updates

On failure, preserve exact stdout/stderr, current commit SHA, affected path, and
exact native runtime identity when an operation involves one. Missing prerequisites
remain failures; do not create temporary executable wrappers or claim an unrun
check passed. Give the next allowed action under
[blocker philosophy](blocker-philosophy.md).

Before updating a checkout, record the current branch and commit and preserve
local work. Update the intended branch, install from its frozen lockfile where
applicable, and rerun its checks. Restart only processes that must load changed
files. Host cleanup is separate operator work and does not authorize fallback
behavior.
