import { describe, expect, it } from "bun:test";
import * as net from "node:net";
import { startAuthGateway } from "../src/auth-gateway/server";
import type { AuthGatewayServerHandle } from "../src/auth-gateway/types";
import type { AuthStorage } from "../src/auth-storage";
import type { Api, Model } from "../src/types";

const TEST_MODEL = {
	id: "test-model",
	provider: "test-provider",
	api: "anthropic-messages",
} as Model<Api>;

function startGateway(bearerTokens: string[]): AuthGatewayServerHandle {
	return startAuthGateway({
		bind: "127.0.0.1:0",
		providerScope: { provider: TEST_MODEL.provider },
		hasProviderCredential: () => true,
		reloadProviderCredentials: async () => {},
		validateProviderCredential: () => true,
		bearerTokens,
		version: "test",
		storage: {
			exportSnapshot: () => ({ credentials: [{ provider: TEST_MODEL.provider }] }),
		} as unknown as AuthStorage,
		resolveModel: () => TEST_MODEL,
		listModels: () => [TEST_MODEL],
	});
}

function canListen(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const server = net.createServer();
		server.unref();
		server.once("error", () => resolve(false));
		server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
			server.close(() => resolve(true));
		});
	});
}

const canListen80 = await canListen(80);
const canListen443 = await canListen(443);

function startOn(bind: string): AuthGatewayServerHandle {
	return startAuthGateway({
		bind,
		providerScope: { provider: TEST_MODEL.provider },
		hasProviderCredential: () => true,
		reloadProviderCredentials: async () => {},
		validateProviderCredential: () => true,
		bearerTokens: [],
		version: "test",
		storage: {
			exportSnapshot: () => ({ credentials: [{ provider: TEST_MODEL.provider }] }),
		} as unknown as AuthStorage,
		resolveModel: () => TEST_MODEL,
		listModels: () => [TEST_MODEL],
	});
}

function httpGet(
	port: number,
	hostHeader: string,
	requestPath: string,
	headers: Record<string, string> = {},
): Promise<{ status: number; raw: string }> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: "127.0.0.1", port }, () => {
			const extra = Object.entries(headers)
				.map(([name, value]) => `${name}: ${value}\r\n`)
				.join("");
			socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${hostHeader}\r\n${extra}Connection: close\r\n\r\n`);
		});
		const chunks: Buffer[] = [];
		socket.on("data", chunk => {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		});
		socket.on("error", reject);
		socket.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			resolve({ status: Number(raw.split(" ")[1]), raw });
		});
	});
}

describe("auth-gateway tokenless host pin", () => {
	it("serves models to the bound host and rejects a rebound name", async () => {
		const gateway = startGateway([]);
		try {
			const port = gateway.port;
			const bound = await httpGet(port, `127.0.0.1:${port}`, "/v1/models");
			expect(bound.status).toBe(200);
			expect(bound.raw).toContain("test-model");

			const rebound = await httpGet(port, `attacker.example:${port}`, "/v1/models");
			expect(rebound.status).toBe(403);
			expect(rebound.raw).toContain("no-auth rejects a host that is not the loopback bind");
			expect(rebound.raw).not.toContain("test-model");
		} finally {
			await gateway.close();
		}
	});

	it("still serves healthz to a non-bind host", async () => {
		const gateway = startGateway([]);
		try {
			const response = await httpGet(gateway.port, "attacker.example:80", "/healthz");
			expect(response.status).toBe(200);
			expect(response.raw).toContain('"ok":true');
		} finally {
			await gateway.close();
		}
	});

	describe.serial("default-port Host forms", () => {
		it.skipIf(!canListen80)("still allows a Host without a port on a port-80 listener", async () => {
			const gateway = startOn("127.0.0.1:80");
			try {
				const response = await httpGet(gateway.port, "127.0.0.1", "/v1/models");
				expect(response.status).toBe(200);
				expect(response.raw).toContain("test-model");
				const rebound = await httpGet(gateway.port, "attacker.example", "/v1/models");
				expect(rebound.status).toBe(403);
			} finally {
				await gateway.close();
			}
		});

		it.skipIf(!canListen80)("still allows Host :80 on an http port-80 listener", async () => {
			const gateway = startOn("127.0.0.1:80");
			try {
				const response = await httpGet(gateway.port, "127.0.0.1:80", "/v1/models");
				expect(response.status).toBe(200);
				expect(response.raw).toContain("test-model");
			} finally {
				await gateway.close();
			}
		});

		it.skipIf(!canListen443)("still allows Host :443 on a port-443 listener", async () => {
			const gateway = startOn("127.0.0.1:443");
			try {
				const response = await httpGet(gateway.port, "127.0.0.1:443", "/v1/models");
				expect(response.status).toBe(200);
				expect(response.raw).toContain("test-model");
				const rebound = await httpGet(gateway.port, "attacker.example:443", "/v1/models");
				expect(rebound.status).toBe(403);
			} finally {
				await gateway.close();
			}
		});
	});

	it("does not pin Host when a bearer token is configured", async () => {
		const gateway = startGateway(["secret-token"]);
		try {
			const response = await httpGet(gateway.port, "gateway.example:9", "/v1/models", {
				Authorization: "Bearer secret-token",
			});
			expect(response.status).toBe(200);
		} finally {
			await gateway.close();
		}
	});
});
