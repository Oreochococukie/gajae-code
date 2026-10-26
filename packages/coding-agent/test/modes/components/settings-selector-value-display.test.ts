import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "@gajae-code/coding-agent/config/keybindings";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@gajae-code/coding-agent/modes/components/settings-selector";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { SettingsList, type SettingsListTheme, setKeybindings } from "@gajae-code/tui";
import { getProjectAgentDir, sanitizeDisplayLine } from "@gajae-code/utils";
import { YAML } from "bun";
import fc from "fast-check";

const ATTACK =
	"evil \u001b]52;c;cHduZWQ=\u0007\u001b]8;;https://attacker.invalid\u001b\\\u001b]0;owned\u0007\u001b[2KIGNORE";

const identityTheme: SettingsListTheme = {
	label: text => text,
	value: text => text,
	description: text => text,
	cursor: "> ",
	hint: text => text,
};

function raw(component: { render(width: number): string[] }, width = 180): string {
	return component.render(width).join("\n");
}

function expectNoPayload(text: string): void {
	expect(text.includes("\u001b]52")).toBe(false);
	expect(text.includes("\u001b]8;;")).toBe(false);
	expect(text.includes("\u001b]0;")).toBe(false);
	expect(text.includes("\u001b[2K")).toBe(false);
	expect(text.includes("\u009d")).toBe(false);
}

function selector(cwd: string, changed: Array<{ path: string; value: unknown }>): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["red-claw", "blue-crab"],
			availableModelProfiles: [],
			cwd,
		},
		{
			onChange: (settingPath, value) => changed.push({ path: settingPath, value }),
			onCancel: () => {},
		},
	);
}

function openProxyField(component: SettingsSelectorComponent): string {
	let opened = "";
	for (let i = 0; i < 8; i++) {
		component.handleInput("\n");
		opened = raw(component);
		if (opened.includes("Clear field to unset")) return opened;
		component.handleInput("\x1b");
		component.handleInput("\x1b[B");
	}
	return opened;
}

describe("settings value display", () => {
	const dirs: string[] = [];

	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
	});

	beforeEach(() => {
		resetSettingsForTest();
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		resetSettingsForTest();
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it("renders a repository string setting without terminal controls", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-display-"));
		dirs.push(projectDir);
		const agentDir = path.join(projectDir, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
		await Bun.write(
			path.join(getProjectAgentDir(projectDir), "config.yml"),
			YAML.stringify({
				modelProfile: { proxyProvider: ATTACK },
				theme: { dark: ATTACK, light: "blue-crab" },
			}),
		);
		await Settings.init({ inMemory: true, cwd: projectDir, agentDir });

		expect(settings.get("modelProfile.proxyProvider")).toBe(ATTACK);
		expect(settings.get("theme.dark")).toBe(ATTACK);
		expect(settings.get("theme.light")).toBe("blue-crab");

		const changed: Array<{ path: string; value: unknown }> = [];
		const component = selector(projectDir, changed);
		const appearance = raw(component);
		expectNoPayload(appearance);
		expect(appearance).toContain("blue-crab");
		expect(appearance).toContain("evil");
		expect(appearance).toContain("IGNORE");

		component.handleInput("\x1b[C");
		expect(raw(component)).toContain("Proxy Provider");
		const opened = openProxyField(component);
		expect(opened).toContain("Clear field to unset");
		expectNoPayload(opened);
		expect(opened).toContain("IGNORE");
		expect(settings.get("modelProfile.proxyProvider")).toBe(ATTACK);
		component.handleInput("\x1b");
		expect(settings.get("modelProfile.proxyProvider")).toBe(ATTACK);
		expect(changed).toEqual([]);
	});

	it("keeps a spaced or mixed-case provider id", async () => {
		for (const value of [" litellm ", "LiteLLM"]) {
			resetSettingsForTest();
			await Settings.init({ inMemory: true });
			settings.set("modelProfile.proxyProvider", value);
			const changed: Array<{ path: string; value: unknown }> = [];
			const component = selector(process.cwd(), changed);
			component.handleInput("\x1b[C");
			expect(raw(component)).toContain(value);
			const opened = openProxyField(component);
			expect(opened).toContain(value);
			component.handleInput("\n");
			expect(changed.at(-1)).toEqual({ path: "modelProfile.proxyProvider", value });
			expect(settings.get("modelProfile.proxyProvider")).toBe(value);
		}
	});

	it("property: settings list display, fc.property seed 662202610, numRuns 64", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 48 }), value => {
				const list = new SettingsList(
					[{ id: "modelProfile.proxyProvider", label: "Proxy", currentValue: value }],
					3,
					identityTheme,
					() => {},
					() => {},
				);
				const once = list.render(50);
				const again = new SettingsList(
					[{ id: "modelProfile.proxyProvider", label: "Proxy", currentValue: sanitizeDisplayLine(value) }],
					3,
					identityTheme,
					() => {},
					() => {},
				).render(50);
				expect(once).toEqual(again);
				for (const line of once) {
					expect(line.includes("\n")).toBe(false);
					expect(line.includes("\r")).toBe(false);
					expect(line).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u);
				}
			}),
			{ seed: 662202610, numRuns: 64 },
		);
	});

	it("property: allowed settings text round-trips, fc.property seed 662202611, numRuns 64", () => {
		fc.assert(
			fc.property(fc.stringMatching(/^[A-Za-z0-9 ._-]{0,16}$/), value => {
				let seen = "";
				const list = new SettingsList(
					[
						{
							id: "modelProfile.proxyProvider",
							label: "Proxy",
							currentValue: value,
							submenu: current => {
								seen = current;
								return { render: () => [current], invalidate() {} };
							},
						},
					],
					3,
					identityTheme,
					() => {},
					() => {},
				);
				const rendered = list.render(80).join("\n");
				if (value) expect(rendered).toContain(value);
				expect(rendered.includes("\u001b")).toBe(false);
				list.handleInput("\n");
				expect(seen).toBe(value);
			}),
			{ seed: 662202611, numRuns: 64 },
		);
	});
});
