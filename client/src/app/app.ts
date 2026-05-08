import { Component, signal } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { ContextMenuHostComponent } from "./context-menu/context-menu-host.component";
import { CanvasEditorComponent } from "./canvas-editor";

@Component({
	selector: "app-root",
	imports: [RouterOutlet, ContextMenuHostComponent, CanvasEditorComponent],
	templateUrl: "./app.html",
	styleUrl: "./app.scss",
})
export class App {
	protected readonly title = signal("client");
}
