import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as piUtils from "@gajae-code/utils";
import { TempDir } from "@gajae-code/utils";
import * as discoveryHelpers from "../../src/discovery/helpers";
import { createLspWritethrough } from "../../src/lsp";
import { shutdownAll } from "../../src/lsp/client";
import { loadConfig } from "../../src/lsp/config";

const ORIGINAL_DISABLE_LSPMUX = Bun.env.PI_DISABLE_LSPMUX;
const ORIGINAL_CONFIG_DIR = process.env.GJC_CONFIG_DIR;

async function writeCanaryLspServer(directory: string): Promise<string> {
	const scriptPath = path.join(directory, "canary-lsp.ts");
	await Bun.write(
		scriptPath,
		`import { writeFileSync } from "node:fs";
const canaryPath = process.argv[2];
writeFileSync(canaryPath, "repository command executed");
let buffer = Buffer.alloc(0);
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write(\`Content-Length: \${Buffer.byteLength(body, "utf8")}\\r\\n\\r\\n\${body}\`);
}
function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
    return;
  }
  if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: message.params.textDocument.uri,
        version: message.params.textDocument.version,
        diagnostics: [],
      },
    });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") process.exit(0);
}
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString();
    const match = /Content-Length: (\\d+)/i.exec(header);
    if (!match) return;
    const length = Number(match[1]);
    const start = headerEnd + 4;
    const end = start + length;
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.subarray(start, end).toString());
    buffer = buffer.subarray(end);
    handle(message);
  }
});
setInterval(() => {}, 1_000);
`,
	);
	return scriptPath;
}

afterEach(async () => {
	await shutdownAll();
	vi.restoreAllMocks();
	if (ORIGINAL_DISABLE_LSPMUX === undefined) {
		delete Bun.env.PI_DISABLE_LSPMUX;
	} else {
		Bun.env.PI_DISABLE_LSPMUX = ORIGINAL_DISABLE_LSPMUX;
	}
	if (ORIGINAL_CONFIG_DIR === undefined) {
		delete process.env.GJC_CONFIG_DIR;
	} else {
		process.env.GJC_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
	}
});

describe("LSP repository command trust", () => {
	it("does not execute a repository-configured command on the first LSP-backed write", async () => {
		using tempDir = TempDir.createSync("@gjc-lsp-command-trust-");
		const cwd = tempDir.path();
		const canaryPath = path.join(cwd, "repository-command-ran");
		const scriptPath = await writeCanaryLspServer(cwd);
		const targetPath = path.join(cwd, "example.ts");

		await Bun.write(path.join(cwd, "package.json"), "{}\n");
		vi.spyOn(piUtils, "$which").mockReturnValue(null);
		await Bun.write(
			path.join(cwd, "lsp.json"),
			JSON.stringify({
				servers: {
					"typescript-language-server": {
						command: process.execPath,
						args: [scriptPath, canaryPath],
						fileTypes: [".ts"],
						rootMarkers: ["package.json"],
					},
				},
			}),
		);
		Bun.env.PI_DISABLE_LSPMUX = "1";

		const writethrough = createLspWritethrough(cwd, {
			enableFormat: false,
			enableDiagnostics: true,
		});
		await writethrough(targetPath, "export const value = 1;\n");

		expect(fs.existsSync(canaryPath)).toBe(false);
		expect(await Bun.file(targetPath).text()).toBe("export const value = 1;\n");
	});

	it("does not add a repository-defined custom server with launch fields", async () => {
		using tempDir = TempDir.createSync("@gjc-lsp-custom-command-trust-");
		const cwd = tempDir.path();
		vi.spyOn(piUtils, "$which").mockReturnValue(null);

		await Bun.write(path.join(cwd, "package.json"), "{}\n");
		await Bun.write(
			path.join(cwd, "lsp.json"),
			JSON.stringify({
				servers: {
					"repository-custom-server": {
						command: process.execPath,
						args: ["malicious-script.ts"],
						fileTypes: [".custom"],
						rootMarkers: ["package.json"],
					},
				},
			}),
		);

		expect(loadConfig(cwd).servers["repository-custom-server"]).toBeUndefined();
	});

	it("trusts explicit plugin directories but not project-scoped plugin launch fields", async () => {
		using tempDir = TempDir.createSync("@gjc-lsp-plugin-command-trust-");
		const cwd = path.join(tempDir.path(), "repo");
		const projectPlugin = path.join(cwd, "project-plugin");
		const explicitPlugin = path.join(cwd, "explicit-plugin");
		await fs.promises.mkdir(projectPlugin, { recursive: true });
		await fs.promises.mkdir(explicitPlugin, { recursive: true });
		await Bun.write(path.join(cwd, "package.json"), "{}\n");

		const lspConfig = (name: string) =>
			JSON.stringify({
				servers: {
					[name]: {
						command: process.execPath,
						args: ["--trusted-plugin-argument"],
						fileTypes: [".plugin"],
						rootMarkers: ["package.json"],
					},
				},
			});
		await Bun.write(path.join(projectPlugin, "lsp.json"), lspConfig("project-plugin-server"));
		await Bun.write(path.join(explicitPlugin, "lsp.json"), lspConfig("explicit-plugin-server"));

		let roots: discoveryHelpers.ClaudePluginRoot[] = [
			{
				id: "project-plugin@__local__",
				marketplace: "__local__",
				plugin: "project-plugin",
				version: "1.0.0",
				path: projectPlugin,
				scope: "project",
			},
		];
		vi.spyOn(discoveryHelpers, "getPreloadedPluginRoots").mockImplementation(() => roots);

		expect(loadConfig(cwd).servers["project-plugin-server"]).toBeUndefined();

		roots = [
			{
				id: "explicit-plugin@__local__",
				marketplace: "__local__",
				plugin: "explicit-plugin",
				version: "local",
				path: explicitPlugin,
				scope: "user",
				origin: "plugin-dir",
			},
		];
		const explicitServer = loadConfig(cwd).servers["explicit-plugin-server"];
		expect(explicitServer?.command).toBe(process.execPath);
		expect(explicitServer?.args).toEqual(["--trusted-plugin-argument"]);
		expect(explicitServer?.resolvedCommand).toBe(process.execPath);
	});

	it("does not trust a user config symlink that resolves into the repository", async () => {
		if (process.platform === "win32") return;

		using tempDir = TempDir.createSync("@gjc-lsp-config-symlink-trust-");
		const cwd = path.join(tempDir.path(), "repo");
		const home = path.join(tempDir.path(), "home");
		await fs.promises.mkdir(cwd, { recursive: true });
		await fs.promises.mkdir(home, { recursive: true });
		vi.spyOn(os, "homedir").mockReturnValue(home);
		vi.spyOn(piUtils, "$which").mockReturnValue(null);

		const repositoryConfig = path.join(cwd, "repository-owned-lsp.json");
		await Bun.write(path.join(cwd, "package.json"), "{}\n");
		await Bun.write(
			repositoryConfig,
			JSON.stringify({
				servers: {
					"symlink-server": {
						command: process.execPath,
						args: ["malicious-script.ts"],
						fileTypes: [".symlink"],
						rootMarkers: ["package.json"],
					},
				},
			}),
		);
		await fs.promises.symlink(repositoryConfig, path.join(home, "lsp.json"));

		expect(loadConfig(cwd).servers["symlink-server"]).toBeUndefined();
	});

	it("keeps trusted user launch fields when repository config overrides server behavior", async () => {
		using tempDir = TempDir.createSync("@gjc-lsp-command-fields-");
		const cwd = tempDir.path();
		const configDirName = `.gjc-lsp-command-trust-${process.pid}-${Date.now()}`;
		const userConfigDir = path.join(os.homedir(), configDirName);
		const userAgentDir = path.join(userConfigDir, "agent");
		const trustedServer = path.join(userConfigDir, "typescript-language-server");

		fs.mkdirSync(userAgentDir, { recursive: true });
		fs.writeFileSync(trustedServer, "#!/bin/sh\nexit 0\n");
		fs.chmodSync(trustedServer, 0o755);
		process.env.GJC_CONFIG_DIR = configDirName;
		await Bun.write(
			path.join(userAgentDir, "lsp.json"),
			JSON.stringify({
				servers: {
					"typescript-language-server": {
						command: trustedServer,
						args: ["--trusted-user-argument"],
					},
				},
			}),
		);
		await Bun.write(path.join(cwd, "package.json"), "{}\n");
		await Bun.write(
			path.join(cwd, "lsp.json"),
			JSON.stringify({
				servers: {
					"typescript-language-server": {
						command: process.execPath,
						args: ["malicious-script.ts"],
						resolvedCommand: process.execPath,
						fileTypes: [".secure-ts"],
					},
				},
			}),
		);

		try {
			const server = loadConfig(cwd).servers["typescript-language-server"];
			expect(server?.command).toBe(trustedServer);
			expect(server?.args).toEqual(["--trusted-user-argument"]);
			expect(server?.resolvedCommand).toBe(trustedServer);
			expect(server?.fileTypes).toEqual([".secure-ts"]);
		} finally {
			fs.rmSync(userConfigDir, { recursive: true, force: true });
		}
	});
});
