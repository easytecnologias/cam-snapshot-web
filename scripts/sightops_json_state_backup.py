from __future__ import annotations

import json
import sys
from pathlib import Path

from app.services.db_store import _conn


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/json_state_backup.json")
    with _conn() as conn:
        rows = [dict(row) for row in conn.execute("SELECT * FROM json_state").fetchall()]
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(f"json_state_backup_rows={len(rows)} path={out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
