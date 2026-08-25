from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.tenant_context import set_current_tenant_slug
from app.services.connector_service import list_jobs


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tenant", default="easy-tecnologias")
    parser.add_argument("--connector-id", required=True)
    parser.add_argument("--limit", type=int, default=8)
    args = parser.parse_args()
    set_current_tenant_slug(args.tenant)
    rows = []
    for job in list_jobs(args.connector_id, limit=args.limit).get("jobs") or []:
        rows.append(
            {
                "id": job.get("id"),
                "type": job.get("type"),
                "status": job.get("status"),
                "created_at": job.get("created_at"),
                "picked_at": job.get("picked_at"),
                "finished_at": job.get("finished_at"),
                "result": job.get("result"),
                "error": job.get("error"),
            }
        )
    print(json.dumps(rows, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
