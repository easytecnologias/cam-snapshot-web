from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from PIL import Image, ImageDraw, ImageFont

from app.core.paths import OUTPUT_DIR

A4_W = 2480
A4_H = 3508
MARGIN = 110


def _text(value: Any) -> str:
    return str(value or "").strip()


def _font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    candidates = [
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size=size)
        except Exception:
            continue
    return ImageFont.load_default()


def _fit(draw: ImageDraw.ImageDraw, value: Any, font: ImageFont.ImageFont, width: int) -> str:
    text = _text(value) or "-"
    if draw.textlength(text, font=font) <= width:
        return text
    base = text
    while base:
        base = base[:-1]
        candidate = base + "..."
        if draw.textlength(candidate, font=font) <= width:
            return candidate
    return "..."


def _new_page() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    page = Image.new("RGB", (A4_W, A4_H), "#f6f8fc")
    return page, ImageDraw.Draw(page)


def _draw_header(draw: ImageDraw.ImageDraw, title: str, subtitle: str) -> int:
    draw.rounded_rectangle((MARGIN, 80, A4_W - MARGIN, 270), radius=28, fill="#0f2748")
    draw.text((MARGIN + 45, 118), title, font=_font(48, True), fill="#ffffff")
    draw.text((MARGIN + 45, 188), subtitle, font=_font(24), fill="#cbd5e1")
    return 330


def _line(draw: ImageDraw.ImageDraw, x: int, y: int, label: str, value: Any, width: int = 700) -> None:
    label_font = _font(21, True)
    value_font = _font(24)
    draw.text((x, y), label, font=label_font, fill="#64748b")
    draw.text((x, y + 30), _fit(draw, value, value_font, width), font=value_font, fill="#0f172a")


def _box(draw: ImageDraw.ImageDraw, xy: tuple[int, int, int, int], title: str) -> None:
    draw.rounded_rectangle(xy, radius=22, fill="#ffffff", outline="#d9e2ef", width=2)
    draw.text((xy[0] + 28, xy[1] + 24), title, font=_font(28, True), fill="#0f2748")


def _summary_page(rows: List[Dict[str, Any]]) -> Image.Image:
    page, draw = _new_page()
    y = _draw_header(
        draw,
        "Inventario Windows",
        "Relatorio de computadores, hardware, armazenamento e memoria",
    )
    total = len(rows)
    online = sum(1 for r in rows if _text(r.get("status")) in ("online", "agent_reported"))
    with_ssd = sum(1 for r in rows if r.get("has_ssd"))
    cards = [
        ("Computadores", total),
        ("Online", online),
        ("Com SSD", with_ssd),
        ("Sem SSD", max(0, online - with_ssd)),
    ]
    card_w = (A4_W - (MARGIN * 2) - 45) // 4
    for idx, (label, value) in enumerate(cards):
        x = MARGIN + idx * (card_w + 15)
        draw.rounded_rectangle((x, y, x + card_w, y + 210), radius=22, fill="#ffffff", outline="#d9e2ef", width=2)
        draw.text((x + 28, y + 34), label, font=_font(24, True), fill="#64748b")
        draw.text((x + 28, y + 90), str(value), font=_font(62, True), fill="#0f2748")
    y += 290

    draw.text((MARGIN, y), "Resumo dos computadores", font=_font(34, True), fill="#0f172a")
    y += 62
    head = ["IP", "Host", "Modelo", "Memoria", "Disco", "MAC"]
    widths = [210, 280, 420, 420, 470, 360]
    x = MARGIN
    draw.rounded_rectangle((MARGIN, y, A4_W - MARGIN, y + 54), radius=10, fill="#e2e8f0")
    for label, width in zip(head, widths):
        draw.text((x + 12, y + 14), label, font=_font(18, True), fill="#334155")
        x += width
    y += 62
    row_font = _font(18)
    for row in rows[:28]:
        x = MARGIN
        values = [
            row.get("ip"),
            row.get("hostname"),
            " ".join(v for v in [_text(row.get("manufacturer")), _text(row.get("model"))] if v),
            row.get("memory_summary") or (str(row.get("ram_gb") or "") + " GB"),
            row.get("disk_summary") or row.get("disk_kind"),
            row.get("mac"),
        ]
        draw.line((MARGIN, y - 8, A4_W - MARGIN, y - 8), fill="#e2e8f0", width=1)
        for value, width in zip(values, widths):
            draw.text((x + 12, y), _fit(draw, value, row_font, width - 24), font=row_font, fill="#0f172a")
            x += width
        y += 48
    return page


def _detail_page(row: Dict[str, Any]) -> Image.Image:
    page, draw = _new_page()
    host = _text(row.get("hostname")) or _text(row.get("ip")) or "Computador"
    y = _draw_header(draw, host, "Ficha tecnica do computador")
    left = MARGIN
    right = A4_W // 2 + 20
    _box(draw, (left, y, A4_W - MARGIN, y + 420), "Identificacao")
    _line(draw, left + 30, y + 85, "IP", row.get("ip"))
    _line(draw, left + 500, y + 85, "MAC", row.get("mac"), 520)
    _line(draw, left + 30, y + 185, "Fabricante / modelo", " ".join(v for v in [_text(row.get("manufacturer")), _text(row.get("model"))] if v), 980)
    _line(draw, left + 30, y + 285, "Serial", row.get("serial"))
    _line(draw, left + 500, y + 285, "Usuario logado", row.get("logged_user"), 620)
    y += 480

    _box(draw, (left, y, A4_W - MARGIN, y + 500), "Sistema e processamento")
    os_info = row.get("os") if isinstance(row.get("os"), dict) else {}
    cpu = row.get("cpu") if isinstance(row.get("cpu"), dict) else {}
    _line(draw, left + 30, y + 85, "Windows", " / ".join(v for v in [_text(os_info.get("name")), _text(os_info.get("build"))] if v), 1000)
    _line(draw, left + 30, y + 185, "CPU", cpu.get("name"), 1000)
    _line(draw, left + 30, y + 285, "Memoria", row.get("memory_summary") or row.get("ram_gb"), 1000)
    _line(draw, left + 30, y + 385, "Armazenamento", row.get("disk_summary") or row.get("disk_kind"), 1000)
    y += 560

    _box(draw, (left, y, right - 20, y + 780), "Modulos de memoria")
    mem_y = y + 85
    for module in (row.get("memory_modules") or [])[:8]:
        if not isinstance(module, dict):
            continue
        txt = " - ".join(
            v for v in [
                _text(module.get("slot")),
                f"{module.get('capacity_gb')} GB" if module.get("capacity_gb") else "",
                _text(module.get("ddr")),
                (str(module.get("configured_speed_mhz") or module.get("speed_mhz")) + " MHz") if (module.get("configured_speed_mhz") or module.get("speed_mhz")) else "",
                _text(module.get("manufacturer")),
                _text(module.get("part_number")),
            ] if v
        )
        draw.text((left + 28, mem_y), _fit(draw, txt, _font(20), 930), font=_font(20), fill="#0f172a")
        mem_y += 62

    _box(draw, (right, y, A4_W - MARGIN, y + 780), "Discos")
    disk_y = y + 85
    for disk in (row.get("disks") or [])[:8]:
        if not isinstance(disk, dict):
            continue
        size = disk.get("size_gb")
        size_txt = ""
        try:
            value = float(size)
            size_txt = f"{round(value / 1024, 2)} TB" if value >= 1024 else f"{round(value)} GB"
        except Exception:
            pass
        txt = " - ".join(
            v for v in [
                size_txt,
                _text(disk.get("media_type")),
                _text(disk.get("manufacturer")),
                _text(disk.get("model")),
                _text(disk.get("serial")),
            ] if v
        )
        draw.text((right + 28, disk_y), _fit(draw, txt, _font(20), 930), font=_font(20), fill="#0f172a")
        disk_y += 62
    return page


def build_windows_inventory_pdf(rows: List[Dict[str, Any]], company_name: str = "") -> Path:
    reports_dir = OUTPUT_DIR / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    safe_company = "".join(ch for ch in _text(company_name) if ch.isalnum() or ch in ("-", "_")) or "windows"
    out = reports_dir / f"windows-inventory-{safe_company}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.pdf"
    pages = [_summary_page(rows)]
    pages.extend(_detail_page(row) for row in rows)
    first, rest = pages[0], pages[1:]
    first.save(out, "PDF", resolution=150.0, save_all=True, append_images=rest)
    return out
