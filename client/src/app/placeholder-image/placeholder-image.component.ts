export function placeholderImage(
	width: number,
	height: number,
	text?: string,
	bg = "#e0e0e0",
	color = "#666",
): string {
	const label = text ?? `${width}×${height}`;
	const fontSize = Math.max(12, Math.min(width, height) / 8);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="${bg}"/>
    <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle"
          font-family="system-ui,sans-serif" font-size="${fontSize}px"
          fill="${color}">${label}</text>
  </svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
