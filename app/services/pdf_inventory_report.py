from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlparse
import ipaddress
import re

from PIL import Image, ImageDraw, ImageFont

from app.core.paths import DATA_DIR, OUTPUT_DIR, SAIDA_DIR


A4_W = 2480
A4_H = 3508
MARGIN_X = 120
MARGIN_Y = 90


def _load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = []
    if bold:
        candidates.extend(
            [
                "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
                "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
                "C:/Windows/Fonts/arialbd.ttf",
                "C:/Windows/Fonts/segoeuib.ttf",
            ]
        )
    else:
        candidates.extend(
            [
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
                "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
                "C:/Windows/Fonts/arial.ttf",
                "C:/Windows/Fonts/segoeui.ttf",
            ]
        )
    for fp in candidates:
        try:
            return ImageFont.truetype(fp, size=size)
        except Exception:
            continue
    return ImageFont.load_default()


def _to_text(v: Any) -> str:
    return str(v or "").strip()


def _report_color(value: str = "") -> str:
    raw = _to_text(value)
    if re.fullmatch(r"#[0-9a-fA-F]{6}", raw):
        return raw
    if re.fullmatch(r"[0-9a-fA-F]{6}", raw):
        return "#" + raw
    return "#0b2242"


def _fit_text(draw: ImageDraw.ImageDraw, txt: str, font: ImageFont.ImageFont, max_w: int) -> str:
    text = _to_text(txt)
    if not text:
        return "-"
    if draw.textlength(text, font=font) <= max_w:
        return text
    base = text
    while base:
        base = base[:-1]
        candidate = base + "..."
        if draw.textlength(candidate, font=font) <= max_w:
            return candidate
    return "..."


def _ip_snapshot_name(ip: str) -> str:
    stem = _to_text(ip).replace(".", "_").replace(":", "__")
    return f"{stem}.jpg"


def _path_from_snapshot_url(url: str) -> Optional[Path]:
    raw = _to_text(url)
    if not raw:
        return None
    try:
        p = Path(raw)
        if p.is_file():
            return p
    except Exception:
        pass
    try:
        parsed = urlparse(raw)
        path = parsed.path or raw
    except Exception:
        path = raw
    if "/data/snapshot/" in path:
        name = path.rsplit("/", 1)[-1]
        p = DATA_DIR / "snapshot" / name
        if p.exists():
            return p
    if "/data/dvr_snapshot/" in path:
        name = path.rsplit("/", 1)[-1]
        p = DATA_DIR / "dvr_snapshot" / name
        if p.exists():
            return p
    if "/data/nvr_snapshot/" in path:
        name = path.rsplit("/", 1)[-1]
        p = DATA_DIR / "nvr_snapshot" / name
        if p.exists():
            return p
    if "/saida/snapshot/" in path:
        name = path.rsplit("/", 1)[-1]
        p = SAIDA_DIR / "snapshot" / name
        if p.exists():
            return p
    return None


def _pick_image_path(row: Dict[str, Any]) -> Optional[Path]:
    snap_file = _to_text(row.get("snapshot_file")).replace("\\", "/").strip()
    if snap_file.startswith("/"):
        snap_file = snap_file.lstrip("/")
    if snap_file.startswith("data/"):
        snap_file = snap_file[5:]
    if snap_file.startswith("saida/"):
        snap_file = snap_file[6:]
    if snap_file:
        # Caminho relativo direto
        for base in (DATA_DIR, SAIDA_DIR):
            p0 = base / snap_file
            if p0.exists():
                return p0
        # Apenas nome do arquivo (fallback)
        fname_only = Path(snap_file).name
        for d in ("snapshot", "dvr_snapshot", "nvr_snapshot"):
            p1 = DATA_DIR / d / fname_only
            if p1.exists():
                return p1
            p1b = SAIDA_DIR / d / fname_only
            if p1b.exists():
                return p1b

    ip = _to_text(row.get("ip") or row.get("IP"))
    if ip:
        p = DATA_DIR / "snapshot" / _ip_snapshot_name(ip)
        if p.exists():
            return p
        p2 = SAIDA_DIR / "snapshot" / _ip_snapshot_name(ip)
        if p2.exists():
            return p2
    for key in ("snapshot_url", "imgbb_url"):
        p3 = _path_from_snapshot_url(_to_text(row.get(key)))
        if p3 and p3.exists():
            return p3

    # Fallback DVR/NVR por padrao de arquivo: <host>_<porta>_chNN.jpg
    host = _to_text(row.get("host"))
    if ":" in host:
        host = host.split(":", 1)[0].strip()
    channel = int(row.get("channel") or 0)
    http_port = int(row.get("http_port") or 80)
    if host and channel > 0:
        fname = f"{host.replace('.', '_')}_{http_port}_ch{channel:02d}.jpg"
        p4 = DATA_DIR / "dvr_snapshot" / fname
        if p4.exists():
            return p4
        p5 = DATA_DIR / "nvr_snapshot" / fname
        if p5.exists():
            return p5
    return None


def _title_num(row: Dict[str, Any]) -> int:
    t = _to_text(row.get("titulo") or row.get("title") or row.get("nome"))
    if not t:
        return 10**9
    m = re.match(r"^\s*(\d{1,4})\b", t)
    if not m:
        return 10**9
    try:
        return int(m.group(1))
    except Exception:
        return 10**9


def _ip_num_key(row: Dict[str, Any]) -> Tuple[int, int]:
    ip_txt = _to_text(row.get("ip") or row.get("IP"))
    if not ip_txt:
        return (1, 2**32 - 1)
    try:
        return (0, int(ipaddress.ip_address(ip_txt)))
    except Exception:
        return (1, 2**32 - 1)


def _sort_inventory_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    # Ordenacao principal por IP numerico (crescente), evitando erro textual (ex.: .100 < .20).
    # Desempate por numero inicial do titulo (01, 02...) e depois titulo.
    return sorted(
        rows,
        key=lambda r: (
            _ip_num_key(r),
            _title_num(r),
            _to_text(r.get("titulo") or r.get("title") or r.get("nome")).lower(),
        ),
    )


def _new_page() -> Tuple[Image.Image, ImageDraw.ImageDraw]:
    page = Image.new("RGB", (A4_W, A4_H), "#f4f7fc")
    draw = ImageDraw.Draw(page)
    return page, draw


def _draw_header(
    page: Image.Image,
    draw: ImageDraw.ImageDraw,
    title: str,
    subtitle: str,
    company_name: str = "",
    logo_path: Optional[Path] = None,
    report_color: str = "",
) -> int:
    f_title = _load_font(54, bold=True)
    f_sub = _load_font(25, bold=False)
    f_company = _load_font(30, bold=True)
    y = MARGIN_Y
    color = _report_color(report_color)
    draw.rounded_rectangle((MARGIN_X, y, A4_W - MARGIN_X, y + 160), radius=24, fill=color)
    draw.text((MARGIN_X + 34, y + 26), title, font=f_title, fill="#ffffff")
    draw.text((MARGIN_X + 34, y + 90), subtitle, font=f_sub, fill="#d9e4f8")
    company = _to_text(company_name)
    if company:
        label = "Empresa: " + company
        draw.text((MARGIN_X + 34, y + 122), _fit_text(draw, label, f_company, A4_W - (2 * MARGIN_X) - 260), font=f_company, fill="#ffffff")
    if logo_path is not None and logo_path.exists():
        try:
            logo = Image.open(logo_path).convert("RGBA")
            box_w = 170
            box_h = 100
            logo.thumbnail((box_w, box_h))
            ox = A4_W - MARGIN_X - 28 - logo.width
            oy = y + 46
            page.paste(logo, (ox, oy), logo)
        except Exception:
            pass
    return y + 195


def _draw_table_pages(
    rows: List[Dict[str, Any]],
    pages: List[Image.Image],
    site_label: str,
    company_name: str = "",
    logo_path: Optional[Path] = None,
    include_olt: bool = True,
    include_switch: bool = False,
    module_label: str = "Cameras IP",
    report_color: str = "",
) -> None:
    f_h = _load_font(25, bold=True)
    f = _load_font(24, bold=False)

    if include_switch:
        cols = [
            ("IP", 215),
            ("Titulo", 430),
            ("Status", 130),
            ("Local", 170),
            ("Modelo", 180),
            ("MAC", 240),
            ("Switch IP", 180),
            ("Switch Porta", 120),
            ("Switch VLAN", 120),
        ]
    elif include_olt:
        cols = [
            ("IP", 215),
            ("Titulo", 460),
            ("Status", 130),
            ("Local", 180),
            ("Modelo", 210),
            ("MAC", 280),
            ("PON", 85),
            ("ONU ID", 95),
            ("ONU Name", 240),
            ("ONU Serial", 290),
        ]
    else:
        cols = [
            ("IP", 290),
            ("Titulo", 620),
            ("Status", 180),
            ("Local", 260),
            ("Modelo", 330),
            ("MAC", 560),
        ]
    line_h = 50
    header_h = 54

    idx = 0
    total = len(rows)
    while idx < total or (total == 0 and idx == 0):
        page, draw = _new_page()
        y = _draw_header(
            page,
            draw,
            f"Relatorio de Inventario - {module_label}",
            f"Gerado em {datetime.now().strftime('%d/%m/%Y %H:%M:%S')} | Site: {site_label}",
            company_name=company_name,
            logo_path=logo_path,
            report_color=report_color,
        )
        draw.text((MARGIN_X, y), "1) Tabela do inventario", font=_load_font(30, bold=True), fill="#0d1f3a")
        y += 56

        x0 = MARGIN_X
        w = A4_W - (2 * MARGIN_X)
        draw.rounded_rectangle((x0, y, x0 + w, y + header_h), radius=14, fill=_report_color(report_color))
        x = x0 + 12
        for name, cw in cols:
            draw.text((x, y + 13), name, font=f_h, fill="#ffffff")
            x += cw
        y += header_h + 8

        if total == 0:
            draw.text((x0 + 14, y + 8), "Nenhuma camera encontrada para o filtro atual.", font=f, fill="#334155")
            pages.append(page)
            break

        while idx < total and y + line_h < A4_H - MARGIN_Y - 40:
            r = rows[idx]
            bg = "#ffffff" if (idx % 2 == 0) else "#eef3fb"
            draw.rectangle((x0, y, x0 + w, y + line_h), fill=bg)
            vals = [
                _to_text(r.get("ip") or r.get("IP")),
                _to_text(r.get("titulo") or r.get("title") or r.get("nome")),
                _to_text(r.get("status")),
                _to_text(r.get("local") or r.get("LOCAL")),
                _to_text(r.get("modelo")),
                _to_text(r.get("mac") or r.get("MAC")),
            ]
            if include_switch:
                vals.extend(
                    [
                        _to_text(r.get("switch_ip")),
                        _to_text(r.get("switch_port")),
                        _to_text(r.get("switch_vlan") or r.get("vlan")),
                    ]
                )
            elif include_olt:
                vals.extend(
                    [
                        _to_text(r.get("pon") or r.get("PON")),
                        _to_text(r.get("onu_id") or r.get("ONU_ID") or r.get("onuid")),
                        _to_text(r.get("onu_name") or r.get("ONU_NAME")),
                        _to_text(r.get("onu_serial") or r.get("ONU_SERIAL")),
                    ]
                )
            x = x0 + 12
            for (col_name, cw), val in zip(cols, vals):
                color = "#0f172a"
                if col_name == "Status":
                    s = val.lower()
                    if s == "online":
                        color = "#0a7a35"
                    elif s in ("offline", "auth_failed"):
                        color = "#b42318"
                draw.text((x, y + 13), _fit_text(draw, val, f, cw - 20), font=f, fill=color)
                x += cw
            y += line_h
            idx += 1

        draw.text((MARGIN_X, A4_H - MARGIN_Y - 14), f"Total de cameras: {total}", font=_load_font(20, False), fill="#475569")
        pages.append(page)


def _draw_photo_pages(
    rows: List[Dict[str, Any]],
    pages: List[Image.Image],
    site_label: str,
    company_name: str = "",
    logo_path: Optional[Path] = None,
    include_olt: bool = True,
    include_switch: bool = False,
    module_label: str = "Cameras IP",
    report_color: str = "",
) -> None:
    f_title = _load_font(38, bold=True)
    f_txt = _load_font(28, bold=False)
    f_cap = _load_font(30, bold=True)

    card_w = 1060
    card_h = 930
    gap_x = 80
    gap_y = 118
    x_start = MARGIN_X
    y_start_base = MARGIN_Y + 250
    per_page = 6

    photo_rows = [r for r in rows if _pick_image_path(r) is not None]
    idx = 0
    total = len(photo_rows)

    while idx < total or (total == 0 and idx == 0):
        page, draw = _new_page()
        _draw_header(
            page,
            draw,
            f"Relatorio de Inventario - {module_label}",
            f"Gerado em {datetime.now().strftime('%d/%m/%Y %H:%M:%S')} | Site: {site_label}",
            company_name=company_name,
            logo_path=logo_path,
            report_color=report_color,
        )
        draw.text((MARGIN_X, MARGIN_Y + 190), "2) Galeria de snapshots", font=f_title, fill="#0d1f3a")

        if total == 0:
            draw.text((MARGIN_X, y_start_base), "Nenhuma foto disponivel no inventario atual.", font=f_txt, fill="#334155")
            pages.append(page)
            break

        for slot in range(per_page):
            if idx >= total:
                break
            col = slot % 2
            row = slot // 2
            x = x_start + col * (card_w + gap_x)
            y = y_start_base + row * (card_h + gap_y)
            draw.rounded_rectangle((x, y, x + card_w, y + card_h), radius=22, fill="#ffffff", outline="#b8c8df", width=3)

            r = photo_rows[idx]
            title = _to_text(r.get("titulo") or r.get("title") or r.get("nome") or r.get("ip") or "Camera")
            ip = _to_text(r.get("ip") or r.get("IP"))
            local = _to_text(r.get("local") or r.get("LOCAL"))
            st = _to_text(r.get("status"))
            cap = f"{title} | {ip or '-'}"
            info_lines = [f"Status: {st or '-'}   Local: {local or '-'}"]
            if include_switch:
                info_lines.append(
                    "Switch: "
                    + (_to_text(r.get("switch_name")) or "-")
                    + "   IP: "
                    + (_to_text(r.get("switch_ip")) or "-")
                )
                info_lines.append(
                    "Porta: "
                    + (_to_text(r.get("switch_port")) or "-")
                    + "   VLAN: "
                    + (_to_text(r.get("switch_vlan") or r.get("vlan")) or "-")
                    + "   Tipo: "
                    + (_to_text(r.get("port_role_guess")) or "-")
                )
            elif include_olt:
                info_lines.append(
                    "OLT: "
                    + (_to_text(r.get("olt_name")) or "-")
                    + "   IP: "
                    + (_to_text(r.get("olt_ip")) or "-")
                )
                info_lines.append(
                    "PON: "
                    + (_to_text(r.get("pon") or r.get("PON")) or "-")
                    + "   ONU ID: "
                    + (_to_text(r.get("onu_id") or r.get("ONU_ID")) or "-")
                    + "   VLAN: "
                    + (_to_text(r.get("vlan")) or "-")
                )
                info_lines.append(
                    "ONU Name: "
                    + (_to_text(r.get("onu_name") or r.get("ONU_NAME")) or "-")
                    + "   ONU Serial: "
                    + (_to_text(r.get("onu_serial") or r.get("ONU_SERIAL")) or "-")
                )

            pad_x = 28
            draw.text((x + pad_x, y + 22), _fit_text(draw, cap, f_cap, card_w - (pad_x * 2)), font=f_cap, fill="#0f172a")
            txt_y = y + 70
            for line in info_lines:
                draw.text((x + pad_x, txt_y), _fit_text(draw, line, f_txt, card_w - (pad_x * 2)), font=f_txt, fill="#334155")
                txt_y += 43

            img_top = y + 250
            img_h = 560
            img_box = (x + pad_x, img_top, x + card_w - pad_x, img_top + img_h)
            draw.rounded_rectangle(img_box, radius=18, outline="#a9bdd6", width=4, fill="#f8fafc")
            inner_pad = 14
            inner_box = (
                img_box[0] + inner_pad,
                img_box[1] + inner_pad,
                img_box[2] - inner_pad,
                img_box[3] - inner_pad,
            )

            p = _pick_image_path(r)
            try:
                if p is not None and p.exists():
                    im = Image.open(p).convert("RGB")
                    bw = inner_box[2] - inner_box[0]
                    bh = inner_box[3] - inner_box[1]
                    im.thumbnail((bw, bh))
                    ox = inner_box[0] + (bw - im.width) // 2
                    oy = inner_box[1] + (bh - im.height) // 2
                    draw.rectangle(inner_box, fill="#eef3f8")
                    page.paste(im, (ox, oy))
                else:
                    draw.text((inner_box[0] + 20, inner_box[1] + 20), "Sem snapshot", font=f_txt, fill="#64748b")
            except Exception:
                draw.text((inner_box[0] + 20, inner_box[1] + 20), "Falha ao carregar imagem", font=f_txt, fill="#b42318")
            idx += 1

        draw.text((MARGIN_X, A4_H - MARGIN_Y - 14), f"Fotos no relatorio: {total}", font=_load_font(20, False), fill="#475569")
        pages.append(page)


def build_inventory_pdf_report(
    rows: Iterable[Dict[str, Any]],
    site: str = "",
    company_name: str = "",
    logo_path: Optional[Path] = None,
    include_olt: bool = True,
    include_switch: bool = False,
    module_label: str = "Cameras IP",
    report_color: str = "",
) -> Path:
    rows_list = [dict(r) for r in rows if isinstance(r, dict)]
    rows_list = _sort_inventory_rows(rows_list)
    site_label = _to_text(site) or "Todos os sites"

    pages: List[Image.Image] = []
    _draw_table_pages(
        rows_list,
        pages,
        site_label,
        company_name=company_name,
        logo_path=logo_path,
        include_olt=include_olt,
        include_switch=include_switch,
        module_label=module_label,
        report_color=report_color,
    )
    _draw_photo_pages(
        rows_list,
        pages,
        site_label,
        company_name=company_name,
        logo_path=logo_path,
        include_olt=include_olt,
        include_switch=include_switch,
        module_label=module_label,
        report_color=report_color,
    )

    reports_dir = OUTPUT_DIR / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    fname_site = site_label.replace(" ", "_").replace("/", "_")
    out = reports_dir / f"inventory-report-{fname_site}-{ts}.pdf"

    rgb_pages = [p.convert("RGB") for p in pages]
    first, rest = rgb_pages[0], rgb_pages[1:]
    first.save(out, "PDF", save_all=True, append_images=rest, resolution=200.0)
    return out


def build_inventory_preview_image(
    rows: Iterable[Dict[str, Any]],
    site: str = "",
    company_name: str = "",
    logo_path: Optional[Path] = None,
    include_olt: bool = True,
    include_switch: bool = False,
    module_label: str = "Cameras IP",
    report_color: str = "",
) -> Path:
    rows_list = [dict(r) for r in rows if isinstance(r, dict)]
    rows_list = _sort_inventory_rows(rows_list)
    site_label = _to_text(site) or "Todos os sites"

    # Preview leve: somente primeira pagina de tabela com limite de linhas.
    page, draw = _new_page()
    y = _draw_header(
        page,
        draw,
        f"Preview do relatorio - {module_label}",
        f"Gerado em {datetime.now().strftime('%d/%m/%Y %H:%M:%S')} | Site: {site_label}",
        company_name=company_name,
        logo_path=logo_path,
        report_color=report_color,
    )
    draw.text((MARGIN_X, y), "Tabela (preview)", font=_load_font(30, bold=True), fill="#0d1f3a")
    y += 56

    f_h = _load_font(25, bold=True)
    f = _load_font(24, bold=False)
    if include_switch:
        cols = [
            ("IP", 215),
            ("Titulo", 430),
            ("Status", 130),
            ("Local", 170),
            ("Modelo", 180),
            ("MAC", 240),
            ("Switch IP", 180),
            ("Switch Porta", 120),
            ("Switch VLAN", 120),
        ]
    elif include_olt:
        cols = [
            ("IP", 215),
            ("Titulo", 460),
            ("Status", 130),
            ("Local", 180),
            ("Modelo", 210),
            ("MAC", 280),
            ("PON", 85),
            ("ONU ID", 95),
            ("ONU Name", 240),
            ("ONU Serial", 290),
        ]
    else:
        cols = [
            ("IP", 290),
            ("Titulo", 620),
            ("Status", 180),
            ("Local", 260),
            ("Modelo", 330),
            ("MAC", 560),
        ]
    line_h = 50
    header_h = 54
    x0 = MARGIN_X
    w = A4_W - (2 * MARGIN_X)
    draw.rounded_rectangle((x0, y, x0 + w, y + header_h), radius=14, fill=_report_color(report_color))
    x = x0 + 12
    for name, cw in cols:
        draw.text((x, y + 13), name, font=f_h, fill="#ffffff")
        x += cw
    y += header_h + 8

    max_rows = min(26, len(rows_list))
    if max_rows == 0:
        draw.text((x0 + 14, y + 8), "Nenhuma camera encontrada para o filtro atual.", font=f, fill="#334155")
    else:
        for idx in range(max_rows):
            r = rows_list[idx]
            bg = "#ffffff" if (idx % 2 == 0) else "#eef3fb"
            draw.rectangle((x0, y, x0 + w, y + line_h), fill=bg)
            vals = [
                _to_text(r.get("ip") or r.get("IP")),
                _to_text(r.get("titulo") or r.get("title") or r.get("nome")),
                _to_text(r.get("status")),
                _to_text(r.get("local") or r.get("LOCAL")),
                _to_text(r.get("modelo")),
                _to_text(r.get("mac") or r.get("MAC")),
            ]
            if include_switch:
                vals.extend(
                    [
                        _to_text(r.get("switch_ip")),
                        _to_text(r.get("switch_port")),
                        _to_text(r.get("switch_vlan") or r.get("vlan")),
                    ]
                )
            elif include_olt:
                vals.extend(
                    [
                        _to_text(r.get("pon") or r.get("PON")),
                        _to_text(r.get("onu_id") or r.get("ONU_ID") or r.get("onuid")),
                        _to_text(r.get("onu_name") or r.get("ONU_NAME")),
                        _to_text(r.get("onu_serial") or r.get("ONU_SERIAL")),
                    ]
                )
            x = x0 + 12
            for (col_name, cw), val in zip(cols, vals):
                color = "#0f172a"
                if col_name == "Status":
                    s = val.lower()
                    if s == "online":
                        color = "#0a7a35"
                    elif s in ("offline", "auth_failed"):
                        color = "#b42318"
                draw.text((x, y + 13), _fit_text(draw, val, f, cw - 20), font=f, fill=color)
                x += cw
            y += line_h

    draw.text((MARGIN_X, A4_H - MARGIN_Y - 14), f"Preview rapido | Cameras: {len(rows_list)}", font=_load_font(20, False), fill="#475569")

    # Reduz resolucao para carregar rapido no browser
    preview = page.resize((1240, 1754))
    reports_dir = OUTPUT_DIR / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    out = reports_dir / "inventory-report-preview.jpg"
    preview.save(out, "JPEG", quality=78, optimize=True)
    return out
