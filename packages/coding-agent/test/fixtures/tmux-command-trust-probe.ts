// Prints the tmux command the public reader resolves.
// Spawned with a controlled cwd so Bun loads that directory's `.env` before
// the reader consults `projectEnvSnapshot`.
import { resolveGjcTmuxCommand } from "../../src/gjc-runtime/tmux-common";

console.log(
	JSON.stringify({
		command: resolveGjcTmuxCommand(),
		envCommand: process.env.GJC_TMUX_COMMAND ?? null,
	}),
);
