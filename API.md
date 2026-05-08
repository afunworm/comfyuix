# ComfyUIX API Reference

Base URL: `https://comfyuix.techcrab.io/api`

All requests and responses use JSON unless otherwise noted. JWT authentication is optional for public books. Private books require `Authorization: Bearer <token>`.

---

## Generate an Image (One-Shot)

Submit a flow and wait for the result in a single request. The request will block until the image is ready (up to 5 minutes).

```
POST https://comfyuix.techcrab.io/api/books/{bookId}/run
Content-Type: application/json
Authorization: Bearer <token>  (optional for public books)
```

### Request Body

```json
{
  "flowId": "uuid-of-the-flow",
  "templateId": "optional-template-id",
  "overrides": {
    "positivePrompt": "a cat sitting on a mountain",
    "seed": 12345
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `flowId` | string (UUID) | Yes | The ID of the flow to run |
| `templateId` | string | No | Template to use. Defaults to the first template in the flow |
| `overrides` | object | No | Key-value pairs to override configurable values. Keys are configurable IDs (e.g. `positivePrompt`, `seed`) |

### Response

```json
{
  "promptId": "428cb3e6-04fe-45b8-b2e7-1c6deae7000a",
  "filename": "bookId-output_00001.png",
  "subfolder": "",
  "type": "output",
  "viewPath": "/proxy/{bookId}/view?filename=...&type=output",
  "seed": "12345"
}
```

| Field | Description |
|---|---|
| `promptId` | ComfyUI prompt ID |
| `filename` | Output filename on the ComfyUI server |
| `subfolder` | Subfolder within the output directory |
| `type` | Always `output` for generated images |
| `viewPath` | Relative path to fetch the image. Prefix with `https://comfyuix.techcrab.io` for the full URL |
| `seed` | The seed that was used (useful if randomized) |

To download the image:
```
GET https://comfyuix.techcrab.io{viewPath}
```

---

## Generate an Image (Two-Step)

### Step 1 — Submit

Submit a flow and get a `promptId` immediately without waiting for the result.

```
POST https://comfyuix.techcrab.io/api/books/{bookId}/run/submit
Content-Type: application/json
Authorization: Bearer <token>  (optional for public books)
```

Request body is identical to the one-shot endpoint.

### Response

```json
{
  "promptId": "428cb3e6-04fe-45b8-b2e7-1c6deae7000a",
  "seed": "12345",
  "apiData": { }
}
```

### Step 2a — Wait for Result (Long-Poll)

Block until the prompt completes. Same response shape as the one-shot endpoint.

```
POST https://comfyuix.techcrab.io/api/books/{bookId}/run/wait/{promptId}
Authorization: Bearer <token>  (optional for public books)
```

No request body needed.

### Step 2b — Poll Status (Non-Blocking)

Check the current status of a submitted prompt without blocking.

```
GET https://comfyuix.techcrab.io/api/books/{bookId}/run/status/{promptId}
Authorization: Bearer <token>  (optional for public books)
```

### Response

```json
{
  "state": "pending",
  "result": null,
  "error": null
}
```

| `state` | Description |
|---|---|
| `pending` | Job is queued or currently running |
| `done` | Job completed. `result` contains the image info (same shape as one-shot response) |
| `error` | Job failed. `error` contains the error message |

---

## Generate Using Raw ComfyUI API JSON

Use these endpoints if you have a raw ComfyUI workflow API JSON and do not want to use flows or templates.

### Submit + Wait

```
POST https://comfyuix.techcrab.io/api/books/{bookId}/run/raw
Content-Type: application/json
Authorization: Bearer <token>  (optional for public books)
```

### Request Body

```json
{
  "apiData": {
    "3": {
      "class_type": "KSampler",
      "inputs": {
        "seed": 12345,
        "steps": 20
      }
    }
  }
}
```

Response is identical to the one-shot endpoint.

### Submit Only (No Wait)

```
POST https://comfyuix.techcrab.io/api/books/{bookId}/run/raw/submit
Content-Type: application/json
```

Same body. Returns `{ promptId }` immediately.

---

## Upload an Input Image

Upload an image to use as input in an input-image flow. Returns a reference you can pass as an override.

```
POST https://comfyuix.techcrab.io/api/books/{bookId}/run/upload/image
Content-Type: image/png
Authorization: Bearer <token>  (optional for public books)
Body: raw image bytes
```

Supported content types: `image/png`, `image/jpeg`, `image/webp`

### Response

```json
{
  "name": "upload_abc123.png",
  "subfolder": "",
  "type": "input",
  "url": "/proxy/{bookId}/view?filename=upload_abc123.png&type=input"
}
```

Pass the `name` value as an override to the run endpoint to use the uploaded image in the flow.

---

## Discovering Flows and Their Parameters

Before generating, a bot should query the available flows to discover what parameters can be overridden.

### List All Flows in a Book

```
GET https://comfyuix.techcrab.io/api/books/{bookId}/flows
Authorization: Bearer <token>  (optional for public books)
```

### Get a Single Flow

```
GET https://comfyuix.techcrab.io/api/books/{bookId}/flows/{flowId}
Authorization: Bearer <token>  (optional for public books)
```

### Response

Each flow includes a `configurables` array describing every parameter that can be overridden, and a `templates` array of named presets.

```json
{
  "id": "uuid",
  "name": "My Flow",
  "configurables": [
    {
      "id": "positivePrompt",
      "label": "Positive Prompt",
      "type": "core",
      "target": "/6/inputs/text"
    },
    {
      "id": "seed",
      "label": "Seed",
      "type": "core",
      "target": "/3/inputs/seed"
    },
    {
      "id": "steps",
      "label": "Steps",
      "type": "number",
      "target": "/3/inputs/steps"
    }
  ],
  "templates": [
    {
      "id": "default",
      "name": "Default",
      "changes": [
        { "configId": "steps", "value": 20 }
      ]
    }
  ]
}
```

| Field | Description |
|---|---|
| `configurables[].id` | The key to use in the `overrides` object when calling `/run` |
| `configurables[].label` | Human-readable name of the parameter |
| `configurables[].type` | `core` (always present: `positivePrompt`, `seed`), `text`, `number`, `image`, or `select` |
| `configurables[].target` | JSON path into the ComfyUI API graph this parameter maps to |
| `templates[].id` | Pass as `templateId` in the run request to use this preset |
| `templates[].changes` | Default values this template applies for each configurable |

### Recommended Bot Workflow

1. `GET /api/books/{bookId}/flows` — list available flows
2. Pick a flow; inspect its `configurables` to know what `overrides` are accepted
3. Pick a template from `templates` (or omit to use the first one)
4. `POST /api/books/{bookId}/run` with your chosen `flowId`, `templateId`, and `overrides`
5. Use the `viewPath` from the response to download the image

---

## Finding Your IDs

- **Book ID**: Visible in the URL when viewing a book — `https://comfyuix.techcrab.io/books/{bookId}`
- **Flow ID**: Returned by `GET /api/books/{bookId}/flows` under each flow's `id` field
- **Template ID**: Returned in `templates[].id` within each flow

---

## Error Responses

All errors follow this shape:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "ComfyUI error: ..."
}
```

| Status | Meaning |
|---|---|
| `400` | Invalid request or ComfyUI execution error |
| `401` | Authentication required |
| `403` | Access denied (wrong book password or not the owner) |
| `404` | Book or flow not found |
| `503` | No tunnel connected for this book (sidecar is offline) |
