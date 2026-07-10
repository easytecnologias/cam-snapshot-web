from __future__ import annotations

from typing import List
from pydantic import BaseModel

# Copiado do legado (main.py) para refatoração incremental (opção 1)
# Mantemos os mesmos campos/defaults para não quebrar o front.

class ScanRequest(BaseModel):
    alvo: str = "rede"
    usuario: str = "admin"
    senha: str = "admin"

    # Se marcado, define um "local" padrão para as câmeras encontradas nesta rodada
    set_local: bool = False
    local: str = ""

    capture_snapshot: bool = True
    append_inventory: bool = False
    reuse_inventory: bool = False
    nat_mode: bool = False  # se True, identifica câmeras por IP:PORTA (NAT), sem merge por MAC

    # etapas opcionais (legado)
    snapshot: bool = False
    imgbb: bool = False
    excel: bool = True
    thumbs: bool = False
    kmz: bool = False
    ia: bool = False
    olt_enrich: bool = False
    switch_enrich: bool = False
    inventory_mode: str = "olt"

    # OLT (enrich)
    olt_model: str | None = None
    olt_host: str | None = None
    olt_usuario: str | None = None
    olt_senha: str | None = None
    pon: str | None = None


class InventoryDeleteRequest(BaseModel):
    ips: List[str]
    mode: str = "olt"
    keys: List[str] = []
    connector_id: str | None = None
    site: str | None = None


class RescanSingleIPRequest(BaseModel):
    ip: str
    usuario: str = "admin"
    senha: str = "admin"
    inventory_mode: str = "olt"
    # Se True, faz a captura do snapshot local (saida/snapshot)
    capture_snapshot: bool = True
class OltCollectMacsRequest(BaseModel):
    olt_ip: str
    user: str
    password: str
    pon: str = "all"
    olt_name: str | None = None
    olt_model: str | None = None
    site: str | None = None
    reuse_json: bool = False  # se True, faz append no olt-cpe-macs.json


class SwitchCollectMacsRequest(BaseModel):
    switch_ip: str
    user: str
    password: str
    site: str | None = None
    switch_name: str | None = None
    reuse_json: bool = False
    port: int = 23
    timeout: float = 12.0
