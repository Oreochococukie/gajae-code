import { describe, expect, it } from "bun:test";
import { resolveSmitheryServerConfig } from "../src/runtime-mcp/smithery-registry";

const qualifiedName = "@example/demo";
const publicResolver = async () => ["1.1.1.1"];

describe("resolveSmitheryServerConfig", () => {
	it("keeps a public deployment URL as an HTTP endpoint", async () => {
		const config = await resolveSmitheryServerConfig(
			qualifiedName,
			{ connection: { type: "http", deploymentUrl: "https://mcp.example.com/rpc" }, useDirectHttp: true },
			{ resolver: publicResolver },
		);
		expect(config).toEqual({ type: "http", url: "https://mcp.example.com/rpc" });
	});

	it("does not install a loopback or private deployment URL as a direct HTTP endpoint", async () => {
		for (const deploymentUrl of ["http://127.0.0.1/mcp", "http://169.254.169.254/latest", "http://10.1.2.3/mcp"]) {
			const config = await resolveSmitheryServerConfig(
				qualifiedName,
				{ connection: { type: "http", deploymentUrl }, useDirectHttp: true },
				{ resolver: async () => ["1.1.1.1"] },
			);
			expect(config?.type).toBe("stdio");
			expect(config && "url" in config ? config.url : undefined).toBeUndefined();
		}
	});
});
