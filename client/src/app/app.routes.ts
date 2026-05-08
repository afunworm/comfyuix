import { Routes } from "@angular/router";
import { FlowImport } from "./pages/flowimport/flowimport";
import { Book } from "./pages/book/book";
import { authGuard } from "./auth/auth.guard";
import { adminGuard } from "./auth/admin.guard";
import { setupGuard } from "./auth/setup.guard";
import { LoginComponent } from "./pages/login/login";
import { Books } from "./pages/books/books";
import { MagicLinkConfirm } from "./pages/magic-link-confirm/magic-link-confirm";
import { PasswordReset } from "./pages/password-reset/password-reset";
import { Setup } from "./pages/setup/setup";
import { AdminPage } from "./pages/admin/admin";
import { AccountPage } from "./pages/account/account";
import { EmailChangeConfirm } from "./pages/email-change-confirm/email-change-confirm";
import { QuickFlowsPage } from "./pages/quick-flows/quick-flows";
import { GalleryPage } from "./pages/gallery/gallery";
import { ModelManagerPage } from "./pages/model-manager/model-manager";
import { ServersPage } from "./pages/servers/servers";

export const routes: Routes = [
	{
		path: "",
		redirectTo: "/books",
		pathMatch: "full",
	},
	{
		path: "books/:bookId",
		component: Book,
		canActivate: [authGuard],
	},
	{
		path: "servers",
		component: ServersPage,
		canActivate: [authGuard],
	},
	{
		path: "servers/:serverId/models",
		component: ModelManagerPage,
		canActivate: [authGuard],
	},
	{
		path: "bookmaker/:bookId/flowimport",
		component: FlowImport,
		canActivate: [authGuard],
	},
	{
		path: "bookmaker/:bookId/flowimport/:flowId",
		component: FlowImport,
		canActivate: [authGuard],
	},
	{
		path: "books",
		component: Books,
		canActivate: [authGuard],
	},
	{
		path: "setup",
		component: Setup,
		canActivate: [setupGuard],
	},
	{
		path: "login",
		component: LoginComponent,
	},
	{
		path: "auth/magic-link/confirm",
		component: MagicLinkConfirm,
	},
	{
		path: "auth/reset-password",
		component: PasswordReset,
	},
	{
		path: "admin/users",
		component: AdminPage,
		canActivate: [authGuard, adminGuard],
	},
	{
		path: "account",
		component: AccountPage,
		canActivate: [authGuard],
	},
	{
		path: "quick-flows",
		component: QuickFlowsPage,
		canActivate: [authGuard],
	},
	{
		path: "gallery",
		component: GalleryPage,
		canActivate: [authGuard],
	},
	{
		path: "auth/confirm-email-change",
		component: EmailChangeConfirm,
	},
	{
		path: "**",
		canActivate: [authGuard],
		component: Books,
	},
];
