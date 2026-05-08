import { HttpInterceptorFn } from "@angular/common/http";
import { inject } from "@angular/core";
import { AuthService } from "./auth.service";

export const authInterceptor: HttpInterceptorFn = (req, next) => {
	// ComfyUI proxy is a passthrough — no auth headers needed
	if (req.url.includes("/proxy/")) return next(req);

	const token = inject(AuthService).getAccessToken();
	if (!token) return next(req);

	return next(
		req.clone({
			setHeaders: { Authorization: `Bearer ${token}` },
		}),
	);
};
