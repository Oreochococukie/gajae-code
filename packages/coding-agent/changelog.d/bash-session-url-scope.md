### Fixed

- Bash `rule://` expansion stays in the session directory, the repository root, the agent directory, a non-Git ancestor `.agent` or `.agents` rules directory under the trusted home, or a discovered user rule under `.agent/rules`, `.agents/rules`, or the agent directory, and `memory://` stays in the folded memory root for that cwd and agent directory.
