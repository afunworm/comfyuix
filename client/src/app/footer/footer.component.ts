import { Component } from "@angular/core";
import { APP_VERSION } from "../version";

@Component({
	selector: "app-footer",
	standalone: true,
	template: `
		<footer class="footer">
			<div class="footer__inner" style="justify-content: flex-end">
				<span style="font-size: 0.72rem; color: rgba(255,255,255,0.2)"
					>v{{ version }}</span
				>
			</div>
		</footer>
	`,
})
export class FooterComponent {
	readonly version = APP_VERSION;
}
