"""Gera uma proposta de caixas de CFTV a partir dos pontos de camera de um KML."""

from __future__ import annotations

import argparse
import csv
import json
import math
import zipfile
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree as ET


EARTH_RADIUS_M = 6_371_000.0
KML_NS = "http://www.opengis.net/kml/2.2"
ET.register_namespace("", KML_NS)


def _tag(name: str) -> str:
    return f"{{{KML_NS}}}{name}"


def read_points(path: Path) -> list[dict]:
    root = ET.parse(path).getroot()
    points: list[dict] = []
    for placemark in root.findall(".//{*}Placemark"):
        coordinates = placemark.find(".//{*}Point/{*}coordinates")
        if coordinates is None or not (coordinates.text or "").strip():
            continue
        values = [part.strip() for part in coordinates.text.strip().split(",")]
        if len(values) < 2:
            continue
        points.append({
            "name": (placemark.findtext("./{*}name") or f"Camera {len(points) + 1}").strip(),
            "lon": float(values[0]),
            "lat": float(values[1]),
        })
    if not points:
        raise ValueError("O KML nao possui pontos de camera")
    return points


def project(points: list[dict]) -> tuple[float, float, float]:
    lat0 = sum(point["lat"] for point in points) / len(points)
    lon0 = sum(point["lon"] for point in points) / len(points)
    cosine = math.cos(math.radians(lat0))
    for point in points:
        point["x"] = EARTH_RADIUS_M * math.radians(point["lon"] - lon0) * cosine
        point["y"] = EARTH_RADIUS_M * math.radians(point["lat"] - lat0)
    return lat0, lon0, cosine


def candidate_centers(points: list[dict], radius: float) -> list[tuple[float, float]]:
    centers = [(point["x"], point["y"]) for point in points]
    for index, first in enumerate(points):
        for second in points[index + 1:]:
            dx = second["x"] - first["x"]
            dy = second["y"] - first["y"]
            distance = math.hypot(dx, dy)
            if distance <= 0 or distance > radius * 2:
                continue
            middle_x = (first["x"] + second["x"]) / 2
            middle_y = (first["y"] + second["y"]) / 2
            height = math.sqrt(max(0.0, radius * radius - (distance / 2) ** 2))
            normal_x, normal_y = -dy / distance, dx / distance
            centers.append((middle_x + height * normal_x, middle_y + height * normal_y))
            centers.append((middle_x - height * normal_x, middle_y - height * normal_y))
    return centers


def group_points(points: list[dict], radius: float) -> list[dict]:
    centers = candidate_centers(points, radius)
    remaining = set(range(len(points)))
    groups: list[dict] = []
    while remaining:
        choices = []
        for center in centers:
            indexes = [
                index for index in remaining
                if math.hypot(points[index]["x"] - center[0], points[index]["y"] - center[1]) <= radius + 1e-7
            ]
            if not indexes:
                continue
            distances = [math.hypot(points[index]["x"] - center[0], points[index]["y"] - center[1]) for index in indexes]
            choices.append((len(indexes), -max(distances), -sum(distances) / len(distances), center, indexes))
        _, _, _, center, indexes = max(choices, key=lambda choice: (choice[0], choice[1], choice[2]))
        groups.append({"center": center, "indexes": sorted(indexes)})
        remaining.difference_update(indexes)
    return groups


def equipment_for(camera_count: int) -> str:
    if camera_count == 1:
        return "ONU/ONT + injetor PoE"
    if camera_count <= 3:
        return "ONU/ONT + switch PoE 5 portas"
    if camera_count <= 7:
        return "ONU/ONT + switch PoE 8 portas"
    if camera_count <= 15:
        return "ONU/ONT + switch PoE 16 portas"
    return "ONU/ONT + switch PoE dimensionado"


def unproject(x: float, y: float, lat0: float, lon0: float, cosine: float) -> tuple[float, float]:
    lat = lat0 + math.degrees(y / EARTH_RADIUS_M)
    lon = lon0 + math.degrees(x / (EARTH_RADIUS_M * cosine))
    return lat, lon


def add_text(parent: ET.Element, name: str, value: str) -> ET.Element:
    node = ET.SubElement(parent, _tag(name))
    node.text = value
    return node


def add_style(document: ET.Element, style_id: str, color: str, scale: str) -> None:
    style = ET.SubElement(document, _tag("Style"), {"id": style_id})
    icon_style = ET.SubElement(style, _tag("IconStyle"))
    add_text(icon_style, "color", color)
    add_text(icon_style, "scale", scale)


def add_point(folder: ET.Element, name: str, lon: float, lat: float, style: str, description: str) -> None:
    placemark = ET.SubElement(folder, _tag("Placemark"))
    add_text(placemark, "name", name)
    add_text(placemark, "description", description)
    add_text(placemark, "styleUrl", f"#{style}")
    point = ET.SubElement(placemark, _tag("Point"))
    add_text(point, "coordinates", f"{lon:.8f},{lat:.8f},0")


def add_line(folder: ET.Element, name: str, box: tuple[float, float], camera: dict, distance: float) -> None:
    placemark = ET.SubElement(folder, _tag("Placemark"))
    add_text(placemark, "name", name)
    add_text(placemark, "description", f"Distancia em linha reta: {distance:.1f} m. Validar o percurso real em campo.")
    style = ET.SubElement(placemark, _tag("Style"))
    line_style = ET.SubElement(style, _tag("LineStyle"))
    add_text(line_style, "color", "ff00a86b")
    add_text(line_style, "width", "3")
    line = ET.SubElement(placemark, _tag("LineString"))
    add_text(line, "tessellate", "1")
    add_text(line, "coordinates", f"{box[1]:.8f},{box[0]:.8f},0 {camera['lon']:.8f},{camera['lat']:.8f},0")


def write_outputs(points: list[dict], groups: list[dict], lat0: float, lon0: float, cosine: float, radius: float, output: Path) -> None:
    root = ET.Element(_tag("kml"))
    document = ET.SubElement(root, _tag("Document"))
    add_text(document, "name", "Proposta de caixas de CFTV - Telha")
    add_text(document, "description", f"Estudo automatico com raio de projeto de {radius:.0f} m. Validar rotas, energia, postes e autorizacoes em campo.")
    add_style(document, "camera", "ff00a86b", "0.8")
    add_style(document, "box", "ff00a5ff", "1.1")
    cameras_folder = ET.SubElement(document, _tag("Folder")); add_text(cameras_folder, "name", "Cameras originais")
    boxes_folder = ET.SubElement(document, _tag("Folder")); add_text(boxes_folder, "name", "Caixas de CFTV propostas")
    cables_folder = ET.SubElement(document, _tag("Folder")); add_text(cables_folder, "name", "Cabos CAT5e estimados")

    for camera in points:
        add_point(cameras_folder, camera["name"], camera["lon"], camera["lat"], "camera", "Ponto original do arquivo recebido.")

    distance_rows = []
    planning_rows = []
    for number, group in enumerate(groups, start=1):
        box_name = f"CX-{number:02d} - CFTV"
        center_x, center_y = group["center"]
        box_lat, box_lon = unproject(center_x, center_y, lat0, lon0, cosine)
        cameras = [points[index] for index in group["indexes"]]
        distances = [math.hypot(camera["x"] - center_x, camera["y"] - center_y) for camera in cameras]
        equipment = equipment_for(len(cameras))
        description = (
            f"{len(cameras)} camera(s). {equipment}. Maior distancia reta: {max(distances):.1f} m. "
            "Coordenada proposta; ajustar para poste/local acessivel sem ultrapassar o limite de cabo."
        )
        add_point(boxes_folder, box_name, box_lon, box_lat, "box", description)
        terminal_name = f"{box_name} - ONU 1"
        distribution_type = "injector" if len(cameras) == 1 else "switch"
        distribution_name = f"{box_name} - {'INJETOR POE' if distribution_type == 'injector' else 'SWITCH POE'} 1"
        port_capacity = 1 if distribution_type == "injector" else (5 if len(cameras) <= 3 else (8 if len(cameras) <= 7 else 16))
        common = {"ip": "", "site": "TELHA", "fabricante": "", "pon": "", "onu": "", "imagem": ""}
        planning_rows.extend([
            {**common, "tipo": "box", "nome": box_name, "modelo": "Caixa hermetica", "equipamento_pai": "",
             "latitude": f"{box_lat:.7f}", "longitude": f"{box_lon:.7f}",
             "metadata": json.dumps({"assembly": "cctv_box", "camera_count": len(cameras)}, ensure_ascii=False),
             "observacoes": "Coordenada proposta; validar poste e acesso em campo."},
            {**common, "tipo": "onu", "nome": terminal_name, "modelo": "", "equipamento_pai": box_name,
             "latitude": f"{box_lat:.7f}", "longitude": f"{box_lon:.7f}",
             "metadata": json.dumps({"container_name": box_name, "role": "optical_terminal"}, ensure_ascii=False),
             "observacoes": "Fabricante, modelo, PON e posicao serao definidos no projeto executivo."},
            {**common, "tipo": distribution_type, "nome": distribution_name, "modelo": "", "equipamento_pai": box_name,
             "latitude": f"{box_lat:.7f}", "longitude": f"{box_lon:.7f}",
             "metadata": json.dumps({"container_name": box_name, "uplink_name": terminal_name, "port_capacity": port_capacity, "poe": True}, ensure_ascii=False),
             "observacoes": equipment},
        ])
        for camera, distance in zip(cameras, distances):
            add_line(cables_folder, f"{box_name} -> {camera['name']}", (box_lat, box_lon), camera, distance)
            distance_rows.append({
                "caixa": box_name, "latitude_caixa": f"{box_lat:.7f}", "longitude_caixa": f"{box_lon:.7f}",
                "equipamento_sugerido": equipment, "camera": camera["name"], "latitude_camera": f"{camera['lat']:.7f}",
                "longitude_camera": f"{camera['lon']:.7f}", "distancia_reta_m": f"{distance:.1f}",
            })
            planning_rows.append({
                **common, "tipo": "camera", "nome": camera["name"], "modelo": "", "equipamento_pai": distribution_name,
                "latitude": f"{camera['lat']:.7f}", "longitude": f"{camera['lon']:.7f}",
                "metadata": json.dumps({"container_name": box_name, "power_device_name": distribution_name,
                                          "distance_to_box_m": round(distance, 1), "coordinates_inherited": False}, ensure_ascii=False),
                "observacoes": f"Cabo CAT5e estimado em {distance:.1f} m em linha reta; validar percurso real.",
            })

    output.parent.mkdir(parents=True, exist_ok=True)
    ET.indent(root, space="  ")
    ET.ElementTree(root).write(output, encoding="utf-8", xml_declaration=True)
    csv_path = output.with_suffix(".csv")
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["tipo", "nome", "ip", "site", "fabricante", "modelo", "equipamento_pai", "pon", "onu", "latitude", "longitude", "imagem", "metadata", "observacoes"])
        writer.writeheader(); writer.writerows(planning_rows)
    distance_path = output.with_name(f"{output.stem}-distancias.csv")
    with distance_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(distance_rows[0]))
        writer.writeheader(); writer.writerows(distance_rows)
    kmz_path = output.with_suffix(".kmz")
    with zipfile.ZipFile(kmz_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.write(output, "doc.kml")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--radius", type=float, default=80.0)
    args = parser.parse_args()
    points = read_points(args.input)
    lat0, lon0, cosine = project(points)
    groups = group_points(points, args.radius)
    write_outputs(points, groups, lat0, lon0, cosine, args.radius, args.output)
    shared = sum(len(group["indexes"]) > 1 for group in groups)
    single = len(groups) - shared
    print(f"{len(points)} cameras; {len(groups)} caixas; {shared} compartilhadas; {single} individuais")
    for number, group in enumerate(groups, start=1):
        names = ", ".join(points[index]["name"].split("-C-")[0] for index in group["indexes"])
        print(f"CX-{number:02d}: {len(group['indexes'])} camera(s) [{names}]")


if __name__ == "__main__":
    main()
