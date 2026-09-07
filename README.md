# Multi-Driver H3 — Backend (Milestone 1)

Node.js + TypeScript + Express API with PostgreSQL and `h3-js`.

## Prerequisites

- Node.js 18+
- PostgreSQL 14+

## Database setup

```sql
CREATE DATABASE multi_driver_h3;
```

Copy environment file and adjust credentials:

```bash
cp .env.example .env
```

## Install & run

```bash
npm install
npm run migrate
npm run dev
```

API runs at **http://localhost:4000**

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/h3/convert` | Convert pickup/drop-off coordinates to H3 |
| GET | `/api/driver-zones` | List all driver zones |
| GET | `/api/driver-zones/:id` | Get one zone |
| POST | `/api/driver-zones` | Create zone |
| PUT | `/api/driver-zones/:id` | Update zone |
| DELETE | `/api/driver-zones/:id` | Delete zone |

## Project structure

```
src/
  main.ts              # Express app entry
  database.ts          # PostgreSQL pool + schema
  h3_service.ts        # All H3 logic (isolated for future milestones)
  models/              # DB row types
  schemas/             # Zod request/response validation
  routes/              # HTTP routes
  services/            # Business logic
```

`h3_cells` is stored as **JSONB** with a **GIN index** for efficient overlap queries in Milestone 2+.
