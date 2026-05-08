import { Injectable, inject } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { Observable } from "rxjs";
import { ComfyUIDatabaseService } from "./comfyui-database.service";

export interface ComfyUploadOptions {
	subfolder?: string;
	overwrite?: boolean;
	filename?: string;
}

export interface ComfyUploadResponse {
	name: string;
	subfolder?: string;
	type?: string;
}

@Injectable({ providedIn: "root" })
export class ComfyUIUploadService {
	private readonly http = inject(HttpClient);
	private readonly db = inject(ComfyUIDatabaseService);

	uploadImage(
		bookId: string,
		file: File | Blob,
		options: ComfyUploadOptions = {},
	): Observable<ComfyUploadResponse> {
		const formData = new FormData();

		const filename =
			options.filename ??
			(file instanceof File ? file.name : `upload-${Date.now()}.png`);

		formData.append("image", file, filename);

		if (options.subfolder) {
			formData.append("subfolder", options.subfolder);
		}

		if (typeof options.overwrite === "boolean") {
			formData.append("overwrite", String(options.overwrite));
		}

		const endpoint = this.db.httpProxiedEndpoint(bookId);
		return this.http.post<ComfyUploadResponse>(
			`${endpoint}/upload/image`,
			formData,
		);
	}

	buildViewUrl(
		bookId: string,
		args: {
			filename: string;
			subfolder?: string;
			type?: "input" | "output" | "temp";
		}
	): string {
		const type = args.type ?? "input";
		const sub = args.subfolder
			? `&subfolder=${encodeURIComponent(args.subfolder)}`
			: "";

		const endpoint = this.db.httpProxiedEndpoint(bookId);
		return `${endpoint}/api/view?filename=${encodeURIComponent(args.filename)}${sub}&type=${type}`;
	}
}