import {
	Injectable,
	ApplicationRef,
	createComponent,
	EnvironmentInjector,
} from "@angular/core";
import { LightboxComponent } from "./lightbox.component";

@Injectable({ providedIn: "root" })
export class LightboxService {
	private ref: any;

	constructor(
		private appRef: ApplicationRef,
		private injector: EnvironmentInjector,
	) {}

	open(src: string, alt = "Photo", afterSrc?: string, startCompare = false) {
		if (this.ref) this.close();

		this.ref = createComponent(LightboxComponent, {
			environmentInjector: this.injector,
		});

		this.ref.instance.src = src;
		this.ref.instance.alt = alt;
		this.ref.instance.afterSrc = afterSrc;

		// startCompare only if afterSrc exists
		this.ref.instance.setCompareEnabled(!!afterSrc && startCompare);

		this.ref.instance.close.subscribe(() => this.close());

		this.appRef.attachView(this.ref.hostView);
		document.body.appendChild(this.ref.location.nativeElement);

		document.body.style.overflow = "hidden";
	}

	toggleCompare(force?: boolean) {
		if (!this.ref) return;
		this.ref.instance.toggleCompare(force);
	}

	close() {
		if (!this.ref) return;

		this.appRef.detachView(this.ref.hostView);
		this.ref.destroy();
		this.ref = null;

		document.body.style.overflow = "";
	}
}
