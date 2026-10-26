import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@gajae-code/coding-agent/config/keybindings";
import { createPluginTextSubmenu } from "@gajae-code/coding-agent/modes/components/plugin-settings";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { SettingsList, type SettingsListTheme, setKeybindings } from "@gajae-code/tui";

const theme: SettingsListTheme = {
	label: text => text,
	value: text => text,
	description: text => text,
	cursor: "> ",
	hint: text => text,
};

function field(original: string) {
	const changes: unknown[] = [];
	const list = new SettingsList(
		[
			{
				id: "hint",
				label: "Hint",
				currentValue: original,
				submenu: createPluginTextSubmenu("hint", { type: "string", description: "Hint text" }, (_key, value) => {
					changes.push(value);
				}),
			},
		],
		5,
		theme,
		() => {},
		() => {},
	);
	list.handleInput("\n");
	return { list, changes };
}

describe("plugin config text confirm", () => {
	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
	});

	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	it("commits the stored multiline plugin string when the display prefill is confirmed", () => {
		for (const original of ["line one\nline two", "line one\r\nline two"]) {
			const { list, changes } = field(original);
			const opened = list.render(80).join("\n");
			expect(opened).toContain("line one line two");
			expect(opened.includes(original)).toBe(false);
			list.handleInput("\x1b");
			expect(changes).toEqual([]);
			list.handleInput("\n");
			list.handleInput("\n");
			expect(changes).toEqual([original]);
		}
	});

	it("commits the stored control-bearing plugin string when the display prefill is confirmed", () => {
		const original = "keep\u001b]52;c;cHduZWQ=\u0007me";
		const { list, changes } = field(original);
		const opened = list.render(80).join("\n");
		expect(opened.includes("\u001b]52")).toBe(false);
		expect(opened).toContain("keepme");
		list.handleInput("\n");
		expect(changes).toEqual([original]);
	});

	it("persists an edited plugin string", () => {
		const original = "line one\nline two";
		const { list, changes } = field(original);
		list.handleInput("!");
		list.handleInput("\n");
		expect(changes).toEqual(["line one line two!"]);
	});
});
