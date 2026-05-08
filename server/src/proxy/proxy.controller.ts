import { All, Controller, Req, Res } from "@nestjs/common";
import { TunnelService } from "../tunnel/tunnel.service";
import { DatabaseService } from "../database/database.service";

@Controller("proxy")
export class ProxyController {
	private readonly db;

	constructor(
		private readonly tunnelService: TunnelService,
		databaseService: DatabaseService,
	) {
		this.db = databaseService.db;
	}

	@All(":bookId/*")
	forward(@Req() req: any, @Res() res: any) {
		const urlParts = (req.raw.url ?? "").split("/");
		const bookId = urlParts[2];
		const remainingPath = "/" + urlParts.slice(3).join("/");

		const book = this.db
			.prepare("SELECT server_id FROM book WHERE id = ?")
			.get(bookId) as any;
		const serverId: string | null = book?.server_id ?? null;

		if (serverId && this.tunnelService.hasTunnel(serverId)) {
			const bodyBuffer = this.buildBodyBuffer(req.body);
			const isViewRequest =
				remainingPath.startsWith("/view") || remainingPath.startsWith("/api/view");
			if (isViewRequest && req.raw.method === "GET") {
				res.raw.setHeader("Cache-Control", "public, max-age=31536000, immutable");
			}
			this.tunnelService.proxyHttp(serverId, req.raw, res.raw, remainingPath, bodyBuffer);
			return;
		}

		res.raw.writeHead(503);
		res.raw.end(JSON.stringify({ error: "No tunnel connected for this book" }));
	}

	private buildBodyBuffer(body: any): Buffer | null {
		if (body === undefined || body === null) return null;
		if (Buffer.isBuffer(body)) return body;
		if (typeof body === "object" && typeof (body as any).pipe !== "function") {
			return Buffer.from(JSON.stringify(body));
		}
		return null;
	}
}
