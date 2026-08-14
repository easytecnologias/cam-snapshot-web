from __future__ import annotations

import sys
import zipfile
from pathlib import Path


def inspect(path: Path) -> None:
    print(f"--- {path}")
    if not path.exists():
        print("missing")
        return
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        print("entries=", ",".join(names[:20]))
        print("has_root_green_file=", "cctv-green.png" in names)
        print("has_root_red_file=", "cctv-red.png" in names)
        print("has_legacy_green_file=", "files/icons/cctv-green.png" in names)
        print("has_legacy_red_file=", "files/icons/cctv-red.png" in names)
        kml_name = next((name for name in names if name.lower().endswith(".kml")), "")
        if not kml_name:
            print("missing_kml")
            return
        text = archive.read(kml_name).decode("utf-8", errors="ignore")
        for needle in ("cam-online", "cam-offline", "cctv-green.png", "cctv-red.png", "ylw-pushpin"):
            print(f"{needle}=", needle in text)


def main() -> None:
    for raw in sys.argv[1:]:
        inspect(Path(raw))


if __name__ == "__main__":
    main()
