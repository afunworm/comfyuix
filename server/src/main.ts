import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import {
	FastifyAdapter,
	NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { TunnelService } from "./tunnel/tunnel.service";
import Database from "better-sqlite3";

async function bootstrap() {
	const app = await NestFactory.create<NestFastifyApplication>(
		AppModule,
		new FastifyAdapter({ ignoreTrailingSlash: true }),
	);

	app.enableCors({
		origin: "*",
		methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
	});

	const fastify = app.getHttpAdapter().getInstance();
	fastify.addContentTypeParser("*", (_request, payload: any, done) => {
		const chunks: Buffer[] = [];
		payload.on("data", (chunk: any) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
		payload.on("end", () => done(null, Buffer.concat(chunks)));
		payload.on("error", (err: Error) => done(err, null));
	});

	// Shared DB connection for upgrade-event lookups (outside Fastify pipeline)
	const dbPath = process.env.DB_PATH ?? "/data/db.sqlite";
	const db = new Database(dbPath);

	const tunnelService = app.get(TunnelService);
	const server = app.getHttpServer();

	server.on("upgrade", (req: any, socket: any, head: any) => {
		const url: string = req.url ?? "";
		console.log(`[upgrade] ${req.method ?? "GET"} ${url} from ${req.socket?.remoteAddress}`);

		// ── Sidecar tunnel connection ─────────────────────────────────────────
		if (url.startsWith("/tunnel")) {
			const { searchParams } = new URL(url, "http://localhost");
			const token = searchParams.get("token");
			const maskedToken = token ? token.slice(0, 8) + "…" + token.slice(-4) : "(none)";
			console.log(`[upgrade] /tunnel  token=${maskedToken}`);

			if (!token) {
				console.log(`[upgrade] /tunnel  → 401 no token`);
				socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
				socket.destroy();
				return;
			}

			const srv: any = db
				.prepare("SELECT id FROM server WHERE tunnel_token = ?")
				.get(token);

			if (!srv) {
				console.log(`[upgrade] /tunnel  → 403 token not found in DB`);
				socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
				socket.destroy();
				return;
			}

			console.log(`[upgrade] /tunnel  → 101 upgrading for server ${srv.id}`);
			tunnelService.emitEvent(srv.id, `WS upgrade accepted from ${req.socket?.remoteAddress}`);
			tunnelService.wss.handleUpgrade(req, socket, head, (ws) => {
				tunnelService.register(srv.id, ws);
			});
			return;
		}

		// ── Client WebSocket via tunnel ───────────────────────────────────────
		if (url.startsWith("/proxy/")) {
			const urlParts = url.split("/");
			const bookId = urlParts[2];
			const remainingPath = "/" + urlParts.slice(3).join("/");

			// Resolve serverId from bookId
			const book: any = db.prepare("SELECT server_id FROM book WHERE id = ?").get(bookId);
			const serverId: string | null = book?.server_id ?? null;

			const hasTunnel = serverId ? tunnelService.hasTunnel(serverId) : false;
			console.log(`[upgrade] /proxy  bookId=${bookId}  serverId=${serverId}  path=${remainingPath}  hasTunnel=${hasTunnel}`);

			if (serverId && hasTunnel) {
				tunnelService.emitEvent(serverId, `Client WS proxied: ${remainingPath}`);
				tunnelService.wss.handleUpgrade(req, socket, head, (clientWs) => {
					tunnelService.proxyWs(serverId, clientWs, remainingPath);
				});
				return;
			}

			console.log(`[upgrade] /proxy  → 503 no tunnel for book ${bookId}`);
			if (serverId) tunnelService.emitEvent(serverId, `Client WS rejected (no tunnel): ${remainingPath}`);
			socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
			socket.destroy();
		}
	});

	await app.listen(process.env.PORT ?? 8888, "0.0.0.0");
	console.log(`Server running on http://localhost:${process.env.PORT ?? 8888}`);
}
bootstrap();
