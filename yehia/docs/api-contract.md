# API Contract: Timetable Service

**Owner:** Yehia Mohamed (248678) — Group 38
**Base Paths:** `/api/timetables`, `/api/health`
**Auth:** `Authorization: Bearer <RS256 JWT>` (verified with Catalogue & Accounts public key; no shared secret)

## Data Dictionary: Timetable
| Field | Type | Source | Rule |
| --- | --- | --- | --- |
| `id` | string (UUID) | Server | Unique, immutable, generated on save |
| `name` | string | Client | Required; trimmed & sanitized (`<script>` removed); 2-80 chars |
| `sectionIds` | string[] | Client | Required; 1-30 valid section IDs; clash-free on save |
| `sections` | Section[] | Catalogue | Re-fetched on `GET /api/timetables/:id` |
| `missingSectionIds` | string[] | Server | Deleted section IDs detected on hydration |
| `stale` | boolean | Server | `true` if a section changed (EventBridge/SQS) or is missing |
| `createdAt` | string (ISO 8601) | Server | Generated on save; immutable |

## Endpoints
| Method | Path | Role | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET` | `/api/health` | Admin | `200` | `401`, `403`, `429` |
| `POST` | `/api/timetables/check` | Student, Admin | `200` | `400`, `401`, `404`, `415`, `429` |
| `POST` | `/api/timetables/generate` | Student, Admin | `200` | `400`, `401`, `404`, `415`, `422`, `429` |
| `POST` | `/api/timetables` | Student, Admin | `201` | `400`, `401`, `404`, `413`, `415`, `422`, `429` |
| `GET` | `/api/timetables` | Owner | `200` | `401`, `429` |
| `GET` | `/api/timetables/{id}` | Owner | `200` | `401`, `404`, `429` |
| `GET` | `/api/timetables/{id}/calendar.ics` | Owner | `200` (`text/calendar`) | `401`, `404`, `429` |
| `DELETE` | `/api/timetables/{id}` | Owner | `204` | `401`, `404`, `429` |

## Standard Error Format
```json
{
  "error": {
    "code": "NO_VALID_TIMETABLE",
    "message": "No clash-free timetable exists for the selected courses."
  }
}
```

| Status | Code | Returned When |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | Missing/invalid fields, >8 courses, or malformed JSON |
| `401` | `UNAUTHORIZED` | Missing, forged, or expired JWT |
| `403` | `FORBIDDEN` | Non-admin calls `/api/health` |
| `404` | `TIMETABLE_NOT_FOUND` / `ROUTE_NOT_FOUND` | Missing resource, IDOR attempt, or unknown route |
| `413` | `PAYLOAD_TOO_LARGE` | Body exceeds 16 KB |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | `POST` body is not `application/json` |
| `422` | `NO_VALID_TIMETABLE` / `TIMETABLE_CLASH` | Courses conflict (returns conflicting IDs) |
| `429` | `RATE_LIMIT_EXCEEDED` | Exceeds sliding-window limit (60 req / 60 s) |
| `500` | `INTERNAL_ERROR` | Unexpected server failure (no stack trace leaked) |
