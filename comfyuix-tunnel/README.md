# comfyuix-tunnel

A lightweight reverse tunnel that connects your local ComfyUI instance to a ComfyUIX server — no open ports or port forwarding required on the ComfyUI machine.

## How it works

The tunnel process runs alongside ComfyUI and opens an outbound WebSocket connection to the ComfyUIX server. The server then uses that persistent connection to forward HTTP requests and WebSocket sessions back to ComfyUI. Traffic is restricted to a path allowlist (prompts, queue, history, uploads, etc.).

```
ComfyUIX Server  ←──── outbound WS ────  comfyuix-tunnel  ──→  ComfyUI (localhost:8188)
```

## Requirements

- Node.js 18+
- ComfyUI running locally (default: `127.0.0.1:8188`)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Set the required environment variables:

| Variable              | Required | Default     | Description                                              |
| --------------------- | -------- | ----------- | -------------------------------------------------------- |
| `COMFYUIX_SERVER_URL` | Yes      | —           | Your ComfyUIX server hostname (e.g. `yourserver.com`)    |
| `COMFYUIX_TOKEN`      | Yes      | —           | 64-char hex token from your book's tunnel settings       |
| `COMFY_HOST`          | No       | `127.0.0.1` | Host where ComfyUI is running                            |
| `COMFY_PORT`          | No       | `8188`      | Port where ComfyUI is listening                          |

3. Run:

```bash
COMFYUIX_SERVER_URL=yourserver.com COMFYUIX_TOKEN=<token> node index.js
# or
npm start
```

On Windows (Command Prompt):
```cmd
set COMFYUIX_SERVER_URL=yourserver.com
set COMFYUIX_TOKEN=<token>
node index.js
```

On Windows (PowerShell):
```powershell
$env:COMFYUIX_SERVER_URL="yourserver.com"
$env:COMFYUIX_TOKEN="<token>"
node index.js
```

## Docker (alternative)

```bash
docker run --rm \
  -e COMFYUIX_SERVER_URL=yourserver.com \
  -e COMFYUIX_TOKEN=<token> \
  comfyuix-tunnel
```

## Notes

- The tunnel automatically reconnects on disconnect with exponential backoff (up to 30s).
- Only the following ComfyUI paths are proxied (all others are rejected):
  `/prompt`, `/queue`, `/history`, `/interrupt`, `/upload/`, `/view`, `/system_stats`, `/free`, `/ws`, `/object_info`, `/embeddings`, `/extensions`, `/models`, `/samplers`, `/schedulers`
- The server URL is treated as secure (WSS) unless it resolves to a localhost or private-range IP.
