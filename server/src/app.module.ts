import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AppController } from "./app.controller";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { DatabaseModule } from "./database/database.module";
import { MailModule } from "./mail/mail.module";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { BooksModule } from "./books/books.module";
import { FlowsModule } from "./flows/flows.module";
import { AssetsModule } from "./assets/assets.module";
import { ProxyModule } from "./proxy/proxy.module";
import { FoldersModule } from "./folders/folders.module";
import { QuickFlowsModule } from "./quick-flows/quick-flows.module";
import { SettingsModule } from "./settings/settings.module";
import { TunnelModule } from "./tunnel/tunnel.module";
import { FilesModule } from "./files/files.module";
import { BookModelsModule } from "./book-models/book-models.module";
import { ServersModule } from "./servers/servers.module";
import { MultirunPresetsModule } from "./multirun-presets/multirun-presets.module";
import { RunModule } from "./run/run.module";

@Module({
	controllers: [AppController],
	imports: [
		ThrottlerModule.forRoot([
			{
				ttl: 60000, // Per 60 seconds
				limit: 300, // 300 requests
			},
		]),
		DatabaseModule,
		MailModule,
		AuthModule,
		UsersModule,
		BooksModule,
		FlowsModule,
		AssetsModule,
		FoldersModule,
		QuickFlowsModule,
		SettingsModule,
		TunnelModule,
		FilesModule,
		BookModelsModule,
		ServersModule,
		MultirunPresetsModule,
		RunModule,
		ProxyModule,
	],
	providers: [
		{
			provide: APP_GUARD,
			useClass: ThrottlerGuard,
		},
	],
})
export class AppModule {}
