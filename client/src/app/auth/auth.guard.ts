import { inject } from "@angular/core";
import { Router } from "@angular/router";
import { AuthService } from "./auth.service";
import { SetupService } from "./setup.service";

export const authGuard = () => {
	const authService = inject(AuthService);
	const setupService = inject(SetupService);
	const router = inject(Router);

	if (setupService.needsSetup()) {
		return router.createUrlTree(["/setup"]);
	}

	if (authService.isLoggedIn()) {
		return true;
	}

	return router.createUrlTree(["/login"]);
};
