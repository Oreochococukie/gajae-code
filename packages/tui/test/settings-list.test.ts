import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings";

const testTheme: SettingsListTheme = {
	label: (text: string) => text,
	value: (text: string) => text,
	description: (text: string) => text,
	cursor: "→ ",
	hint: (text: string) => text,
};

describe("SettingsList", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	it("cycles the selected value when Enter arrives as LF", () => {
		const changes: Array<[string, string]> = [];
		const list = new SettingsList(
			[
				{
					id: "mode",
					label: "Mode",
					currentValue: "off",
					values: ["off", "on"],
				},
			],
			5,
			testTheme,
			(id, value) => {
				changes.push([id, value]);
			},
			() => {
				throw new Error("cancel should not be called");
			},
		);

		list.handleInput("\n");

		expect(changes).toEqual([["mode", "on"]]);
	});
	it("keeps populated confirm precedence when cancel also matches Enter", () => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.select.cancel": "enter",
			}),
		);
		const changes: Array<[string, string]> = [];
		let cancelled = false;
		const list = new SettingsList(
			[
				{
					id: "mode",
					label: "Mode",
					currentValue: "off",
					values: ["off", "on"],
				},
			],
			5,
			testTheme,
			(id, value) => {
				changes.push([id, value]);
			},
			() => {
				cancelled = true;
			},
		);

		list.handleInput("\n");

		expect(changes).toEqual([["mode", "on"]]);
		expect(cancelled).toBe(false);
	});
	it("does not poison selection when navigation arrives while empty", () => {
		const changes: Array<[string, string]> = [];
		const selections: Array<string | undefined> = [];
		const list = new SettingsList(
			[],
			5,
			testTheme,
			(id, value) => {
				changes.push([id, value]);
			},
			() => {
				throw new Error("cancel should not be called");
			},
			item => selections.push(item?.id),
		);

		list.handleInput("\x1b[A");
		list.handleInput("\x1b[B");
		list.handleInput("\n");
		list.setItems([
			{
				id: "mode",
				label: "Mode",
				currentValue: "off",
				values: ["off", "on"],
			},
		]);
		list.handleInput("\n");

		expect(Bun.stripANSI(list.render(80).join("\n"))).toContain("→ Mode");
		expect(selections.at(-1)).toBe("mode");
		expect(changes).toEqual([["mode", "on"]]);
	});

	it("still allows cancelling an empty list", () => {
		let cancelled = false;
		const list = new SettingsList(
			[],
			5,
			testTheme,
			() => {},
			() => {
				cancelled = true;
			},
		);

		list.handleInput("\x1b");

		expect(cancelled).toBe(true);
	});

	it("filters settings as printable text is entered", () => {
		let changed = false;
		const list = new SettingsList(
			[
				{ id: "memory", label: "Memory Backend", currentValue: "local", values: ["local", "off"] },
				{ id: "theme", label: "Theme", currentValue: "dark" },
			],
			5,
			testTheme,
			() => {
				changed = true;
			},
			() => {
				throw new Error("cancel should not be called");
			},
		);

		for (const character of "Memory") list.handleInput(character);
		list.handleInput(" ");
		const rendered = Bun.stripANSI(list.render(80).join("\n"));

		expect(changed).toBe(false);
		expect(rendered).toContain("Search: Memory ");
		expect(rendered).toContain("Memory Backend");
		expect(rendered).not.toContain("Theme");
	});
	it("activates the filtered item at its filtered index, not its original index", () => {
		const changes: Array<[string, string]> = [];
		const list = new SettingsList(
			[
				{ id: "memory", label: "Memory Backend", currentValue: "local", values: ["local", "off"] },
				{ id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
			],
			5,
			testTheme,
			(id, newValue) => {
				changes.push([id, newValue]);
			},
			() => {
				throw new Error("cancel should not be called");
			},
		);

		// "theme" is index 1 in the unfiltered list but index 0 once filtered.
		for (const character of "theme") list.handleInput(character);
		const filtered = Bun.stripANSI(list.render(80).join("\n"));
		expect(filtered).toContain("Theme");
		expect(filtered).not.toContain("Memory Backend");
		expect(filtered).toContain("Enter to change");

		list.handleInput("\n");

		expect(changes).toEqual([["theme", "light"]]);
	});

	it("clears search before cancelling the settings list", () => {
		let cancelCount = 0;
		const list = new SettingsList(
			[
				{ id: "memory", label: "Memory Backend", currentValue: "local" },
				{ id: "theme", label: "Theme", currentValue: "dark" },
			],
			5,
			testTheme,
			() => {},
			() => {
				cancelCount += 1;
			},
		);

		list.handleInput("m");
		list.handleInput("e");
		list.handleInput("x");
		list.handleInput("\x7f");
		expect(Bun.stripANSI(list.render(80).join("\n"))).toContain("Search: me");

		list.handleInput("\x1b");
		const restored = Bun.stripANSI(list.render(80).join("\n"));
		expect(cancelCount).toBe(0);
		expect(restored).not.toContain("Search:");
		expect(restored).toContain("Memory Backend");
		expect(restored).toContain("Theme");

		list.handleInput("\x1b");
		expect(cancelCount).toBe(1);
	});

	it("clamps selection when a submenu closes after the list shrinks", () => {
		const list = new SettingsList(
			[
				{
					id: "first",
					label: "First",
					currentValue: "open",
				},
				{
					id: "second",
					label: "Second",
					currentValue: "open",
					submenu: (_currentValue, done) => ({
						render: () => ["submenu"],
						handleInput: () => done(),
						invalidate: () => {},
					}),
				},
			],
			5,
			testTheme,
			() => {},
			() => {},
		);

		list.handleInput("\x1b[B");
		list.handleInput("\n");
		list.setItems([
			{
				id: "only",
				label: "Only",
				currentValue: "open",
			},
		]);
		list.handleInput("\n");

		expect(Bun.stripANSI(list.render(80).join("\n"))).toContain("→ Only");
	});
	it("shrinks labels and clamps values at 48 columns", () => {
		const list = new SettingsList(
			[
				{
					id: "long",
					label: "A setting label that exceeds narrow terminals",
					currentValue: "a value that also exceeds narrow terminals",
				},
			],
			5,
			testTheme,
			() => {},
			() => {},
		);
		for (const line of list.render(48)) expect(Bun.stripANSI(line).length).toBeLessThanOrEqual(48);
	});

	const attack =
		"evil \u001b]52;c;cHduZWQ=\u0007\u001b]8;;https://attacker.invalid\u001b\\\u001b]0;owned\u0007\u001b[2KIGNORE";

	function listFor(value: string, onPrefill?: (value: string) => void): SettingsList {
		return new SettingsList(
			[
				{
					id: "modelProfile.proxyProvider",
					label: "Proxy Provider",
					currentValue: value,
					submenu: current => {
						onPrefill?.(current);
						return { render: () => [current], invalidate() {} };
					},
				},
			],
			5,
			testTheme,
			() => {},
			() => {},
		);
	}

	it("renders a project setting value without terminal controls", () => {
		const list = listFor(attack);
		const rendered = list.render(160).join("\n");
		expect(rendered).toContain("evil");
		expect(rendered).toContain("IGNORE");
		expect(rendered.includes("\u001b")).toBe(false);
		expect(rendered.includes("\u009d")).toBe(false);
		expect(list.render(160).length).toBe(listFor("evil IGNORE").render(160).length);
		const c1 = listFor("pre\u009dpost").render(80).join("\n");
		expect(c1).toContain("prepost");
		expect(c1.includes("\u009d")).toBe(false);
	});

	it("prefills the text submenu with the full safe line", () => {
		let seen = "";
		const long = `\u001b]52;c;cHduZWQ=\u0007${"A".repeat(80)}`;
		const list = listFor(long, value => {
			seen = value;
		});
		const row = list.render(24).join("\n");
		expect(row.includes("\u001b")).toBe(false);
		expect(row).toContain("A");
		list.handleInput("\n");
		expect(seen).toBe("A".repeat(80));
		expect(list.render(24).join("\n")).toBe("A".repeat(80));
	});

	it("keeps legitimate setting text in the row and the prefill", () => {
		for (const value of [" litellm ", "LiteLLM", "proxy/id", "프록시", ""]) {
			let seen = "unset";
			const list = listFor(value, current => {
				seen = current;
			});
			const rendered = list.render(80).join("\n");
			if (value) expect(rendered).toContain(value);
			expect(rendered.includes("\u001b")).toBe(false);
			list.handleInput("\n");
			expect(seen).toBe(value);
		}
	});
});
