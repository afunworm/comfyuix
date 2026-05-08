import { inject } from "@angular/core";
import { Router } from "@angular/router";
import { SetupService } from "./setup.service";

export const setupGuard = () => {
	const setupService = inject(SetupService);
	const router = inject(Router);

	if (!setupService.needsSetup()) {
		return router.createUrlTree(["/login"]);
	}

	return true;
};
