import {
	APP_INITIALIZER,
	ApplicationConfig,
	provideBrowserGlobalErrorListeners,
	provideZonelessChangeDetection,
} from "@angular/core";
import { provideRouter, withComponentInputBinding } from "@angular/router";
import { provideHttpClient, withInterceptors } from "@angular/common/http";

import { routes } from "./app.routes";
import { authInterceptor } from "./auth/auth.interceptor";
import { SetupService } from "./auth/setup.service";

export const appConfig: ApplicationConfig = {
	providers: [
		provideBrowserGlobalErrorListeners(),
		provideZonelessChangeDetection(),
		provideRouter(routes, withComponentInputBinding()),
		provideHttpClient(withInterceptors([authInterceptor])),
		{
			provide: APP_INITIALIZER,
			useFactory: (setupService: SetupService) => () => setupService.checkStatus(),
			deps: [SetupService],
			multi: true,
		},
	],
};
