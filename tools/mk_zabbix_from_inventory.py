#!/usr/bin/env python3
import json, os, re, sys, time, requests
from typing import Any, Optional, Dict, List

INV_PATH = os.getenv("INV_PATH", "data/cam-inventory.json")
ZBX_URL  = os.getenv("ZBX_URL","").strip()
ZBX_USER = os.getenv("ZBX_USER","").strip()
ZBX_PASS = os.getenv("ZBX_PASS","").strip()
ZBX_GROUP = os.getenv("ZBX_GROUP","Cameras").strip() or "Cameras"
ZBX_TEMPLATE = os.getenv("ZBX_TEMPLATE","Template Module ICMP Ping").strip() or "Template Module ICMP Ping"
ZBX_TEMPLATE_DVR = os.getenv("ZBX_TEMPLATE_DVR", "Template Cam-Snapshot DVR Channel").strip() or "Template Cam-Snapshot DVR Channel"
ZBX_DVR_USER = os.getenv("ZBX_DVR_USER", "admin").strip() or "admin"
ZBX_DVR_PASS = os.getenv("ZBX_DVR_PASS", "").strip()

TG_AUTO = os.getenv("ZBX_TG_AUTO","0").strip() == "1"
TG_TOKEN = os.getenv("ZBX_TG_TOKEN","").strip()
TG_CHAT  = os.getenv("ZBX_TG_CHAT","").strip()
TG_RELAY_URL = os.getenv("ZBX_TG_RELAY_URL","").strip()
TG_RELAY_KEY = os.getenv("ZBX_TG_RELAY_KEY","").strip()
ZBX_TG_TIMEZONE = os.getenv("ZBX_TG_TIMEZONE", "America/Sao_Paulo").strip() or "America/Sao_Paulo"

MEDIA_NAME = "Telegram (cam-snapshot)"
ACTION_NAME_LEGACY_IP = "Cameras IP -> Telegram (cam-snapshot)"
ACTION_NAME_LEGACY_DVR = "DVR -> Telegram (cam-snapshot)"


def _slug_name(v: str) -> str:
    s = str(v or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", ".", s)
    s = re.sub(r"\.+", ".", s).strip(".")
    return s or "default"


GROUP_SLUG = _slug_name(ZBX_GROUP)
USER_ALIAS = f"telegram.cam-snapshot.{GROUP_SLUG}"
ACTION_NAME_GROUP = f"{ZBX_GROUP} -> Telegram (cam-snapshot)"


def _google_maps_url(lat_val: Any, lon_val: Any) -> str:
    try:
        lat = float(str(lat_val).strip().replace(",", "."))
        lon = float(str(lon_val).strip().replace(",", "."))
        return f"https://www.google.com/maps?q={lat},{lon}"
    except Exception:
        return ""

def api(method: str, params: Any, auth: Optional[str]=None, _id=[0]) -> Any:
    _id[0]+=1
    payload={"jsonrpc":"2.0","method":method,"params":params,"id":_id[0]}
    if auth: payload["auth"]=auth
    r=requests.post(ZBX_URL, json=payload, timeout=30)
    r.raise_for_status()
    j=r.json()
    if "error" in j:
        raise RuntimeError(f"{method}: {j['error']}")
    return j["result"]

def login() -> str:
    return api("user.login", {"username": ZBX_USER, "password": ZBX_PASS})

def ensure_hostgroup(auth: str, name: str) -> str:
    res = api("hostgroup.get", {"filter":{"name":[name]}}, auth)
    if res: return res[0]["groupid"]
    return api("hostgroup.create", {"name": name}, auth)["groupids"][0]

def get_template_id(auth: str, name: str) -> str:
    res = api("template.get", {"filter":{"host":[name]}}, auth)
    if not res:
        raise RuntimeError(f"Template não encontrado: {name}")
    return res[0]["templateid"]


def try_get_template_id(auth: str, name: str) -> str:
    nm = str(name or "").strip()
    if not nm:
        return ""
    try:
        res = api("template.get", {"filter": {"host": [nm]}, "output": ["templateid", "host", "name"]}, auth)
        if res:
            return str(res[0]["templateid"])
    except Exception:
        pass
    try:
        res = api("template.get", {"filter": {"name": [nm]}, "output": ["templateid", "host", "name"]}, auth)
        if res:
            return str(res[0]["templateid"])
    except Exception:
        pass
    return ""


def resolve_base_template_id(auth: str, requested_name: str) -> tuple[str, str]:
    rid = try_get_template_id(auth, requested_name)
    if rid:
        return rid, str(requested_name or "").strip()

    candidates = [
        "Template Module ICMP Ping",
        "ICMP Ping",
        "Template ICMP Ping",
        "Template Net Network Generic Device by ICMP",
    ]
    for nm in candidates:
        tid = try_get_template_id(auth, nm)
        if tid:
            return tid, nm

    try:
        res = api(
            "template.get",
            {
                "search": {"host": "ICMP"},
                "output": ["templateid", "host", "name"],
                "searchByAny": True,
                "sortfield": "host",
                "limit": 50,
            },
            auth,
        )
        for t in (res or []):
            host = str(t.get("host") or "").strip()
            tid = str(t.get("templateid") or "").strip()
            if host and tid:
                return tid, host
    except Exception:
        pass

    return "", ""

def get_host(auth: str, host: str):
    res = api("host.get", {"filter":{"host":[host]}}, auth)
    return res[0] if res else None

def host_upsert(
    auth: str,
    host: str,
    visible_name: str,
    ip: str,
    groupids: List[str],
    templateids: List[str],
    macros: Dict[str,str],
) -> tuple[str, str]:
    iface=[{"type":1,"main":1,"useip":1,"ip":ip,"dns":"","port":"10050"}]
    macro_list=[{"macro":k,"value":v} for k,v in macros.items()]
    tpl_links=[{"templateid": tid} for tid in dict.fromkeys([str(t).strip() for t in (templateids or []) if str(t).strip()])]
    group_links=[{"groupid": gid} for gid in dict.fromkeys([str(g).strip() for g in (groupids or []) if str(g).strip()])]
    existing=get_host(auth, host)
    if not existing:
        payload = {
            "host": host,
            "name": visible_name,
            "interfaces": iface,
            "groups": group_links,
            "macros": macro_list
        }
        if tpl_links:
            payload["templates"] = tpl_links
        r = api("host.create", payload, auth)
        hostid = str((r.get("hostids") or [""])[0])
        return "created", hostid
    # IMPORTANT:
    # Do not update host interfaces for an existing host.
    # In Zabbix, interfaces can be linked to items (e.g. net.tcp.service items).
    # Updating interfaces on an existing host may fail with:
    # "Interface is linked to item ...".
    # For existing hosts we only update name/groups/templates/macros.
    payload_u = {
        "hostid": existing["hostid"],
        "name": visible_name,
        "groups": group_links,
        "macros": macro_list
    }
    if tpl_links:
        payload_u["templates"] = tpl_links
    api("host.update", payload_u, auth)
    return "updated", str(existing["hostid"])


def ensure_template_group(auth: str, name: str = "Templates") -> str:
    try:
        res = api("templategroup.get", {"filter": {"name": [name]}}, auth)
        if res:
            return str(res[0]["groupid"])
        cr = api("templategroup.create", {"name": name}, auth)
        gids = cr.get("groupids") or []
        if gids:
            return str(gids[0])
    except Exception:
        pass
    return ensure_hostgroup(auth, name)


def ensure_dvr_channel_template(auth: str, name: str) -> str:
    res = api("template.get", {"filter": {"host": [name]}}, auth)
    if res:
        tpl_id = str(res[0]["templateid"])
    else:
        tg_id = ensure_template_group(auth, "Templates")
        cr = api("template.create", {"host": name, "groups": [{"groupid": tg_id}]}, auth)
        tpl_id = str((cr.get("templateids") or [""])[0])

    raw_key = "dvr.videoloss.raw"
    snap_probe_key = "dvr.snapshot.probe"

    def ensure_http_item(key_: str, item_name: str, url: str, retrieve_mode: int, timeout: str = "10s") -> None:
        payload = {
            "name": item_name,
            "key_": key_,
            "type": 19,  # HTTP agent
            "value_type": 4,  # text
            "delay": "30s",
            "url": url,
            "request_method": 0,
            "retrieve_mode": int(retrieve_mode),
            "follow_redirects": 1,
            "timeout": timeout,
            "authtype": 4,  # digest
            "username": "{$DVR_USER}",
            "password": "{$DVR_PASS}",
        }
        found = api("item.get", {"hostids": [tpl_id], "filter": {"key_": [key_]}, "output": ["itemid"]}, auth)
        if not found:
            p = dict(payload)
            p["hostid"] = tpl_id
            api("item.create", p, auth)
        else:
            p = dict(payload)
            p["itemid"] = str(found[0]["itemid"])
            api("item.update", p, auth)

    ensure_http_item(
        raw_key,
        "DVR VideoLoss Raw",
        "{$DVR_HTTP_URL}/cgi-bin/eventManager.cgi?action=getEventIndexes&code=VideoLoss",
        retrieve_mode=0,
        timeout="10s",
    )
    ensure_http_item(
        snap_probe_key,
        "DVR Snapshot Probe",
        "{$DVR_HTTP_URL}/cgi-bin/snapshot.cgi?channel={$DVR_CH}",
        retrieve_mode=0,
        timeout="10s",
    )

    trig_name = "Canal DVR offline ({HOST.NAME})"
    expr = (
        f'find(/{name}/{raw_key},,"regexp","channels\\\\[[0-9]+\\\\]={{$DVR_CH_INDEX}}(\\\\D|$)")=1'
        f' or nodata(/{name}/{snap_probe_key},2m)=1'
    )
    trig = api("trigger.get", {"hostids": [tpl_id], "filter": {"description": [trig_name]}, "output": ["triggerid"]}, auth)
    if not trig:
        api(
            "trigger.create",
            {
                "description": trig_name,
                "expression": expr,
                "priority": 3,
            },
            auth,
        )
    else:
        api(
            "trigger.update",
            {
                "triggerid": str(trig[0]["triggerid"]),
                "expression": expr,
                "priority": 3,
            },
            auth,
        )
    return tpl_id


def push_dvr_channel_state(auth: str, hostid: str, status_text: str) -> None:
    s = str(status_text or "").strip().lower()
    if s == "online":
        state = 1
    elif s in ("sem_camera", "sem camera", "no_camera", "no camera"):
        state = 2
    else:
        state = 0
    now = int(time.time())

    items = api(
        "item.get",
        {
            "hostids": [hostid],
            "filter": {"key_": ["cam.channel.state", "cam.channel.state.text"]},
            "output": ["itemid", "key_"],
        },
        auth,
    )
    if not items:
        return

    values = []
    for it in items:
        key_ = str(it.get("key_") or "")
        iid = str(it.get("itemid") or "")
        if not iid:
            continue
        if key_ == "cam.channel.state":
            values.append({"itemid": iid, "value": str(state), "clock": now})
        elif key_ == "cam.channel.state.text":
            values.append({"itemid": iid, "value": s or "offline", "clock": now})
    if values:
        api("history.push", values, auth)

def ensure_telegram_mediatype(auth: str, token: str, chat_id: str) -> str:
    res = api("mediatype.get", {"filter":{"name":[MEDIA_NAME]}}, auth)
    webhook_script = r'''
    var params = JSON.parse(value);
    
    var Telegram = {
      token: params.api_token,
      parse_mode: params.api_parse_mode || 'HTML',
    
      request: function (method, payload) {
        var url = 'https://api.telegram.org/bot' + Telegram.token + '/' + method;
        var req = new HttpRequest();
        req.addHeader('Content-Type: application/json');
    
        var body = JSON.stringify(payload);
        var resp = req.post(url, body);
        var code = req.getStatus();
    
        if (code < 200 || code >= 300) {
          throw 'Telegram API HTTP ' + code + ': ' + resp;
        }
    
        var obj;
        try { obj = JSON.parse(resp); } catch (e) {
          throw 'Telegram API returned non-JSON: ' + resp;
        }
    
        if (!obj.ok) {
          throw 'Telegram API error: ' + (obj.description || resp);
        }
    
        return obj;
      },
    
      sendMessage: function (chat_id, text) {
        return Telegram.request('sendMessage', {
          chat_id: chat_id,
          text: text,
          parse_mode: Telegram.parse_mode,
          disable_web_page_preview: true
        });
      },
    
      sendPhoto: function (chat_id, photo_url, caption) {
        if (caption && caption.length > 1024) {
          caption = caption.substring(0, 1000) + '...';
        }
        var payload = {
          chat_id: chat_id,
          photo: photo_url,
          caption: caption || '',
          parse_mode: Telegram.parse_mode
        };
        if (params.map_url && String(params.map_url).indexOf('http') === 0) {
          payload.reply_markup = JSON.stringify({
            inline_keyboard: [[{ text: 'Abrir no Google Maps', url: String(params.map_url) }]]
          });
        }
        return Telegram.request('sendPhoto', payload);
      }
    };
    
    try {
      var chat = params.sendto || params.chat_id || params.chatid || params.to;
      if (!chat) {
        throw 'missing chat_id (sendto)';
      }
    
      var subject = (params.subject !== undefined && params.subject !== null) ? String(params.subject) : '';
      var message = (params.message !== undefined && params.message !== null) ? String(params.message) : '';
      var text = (subject ? subject + "\n" : "") + message;
    
      var snap = (params.snapshot_url !== undefined && params.snapshot_url !== null) ? String(params.snapshot_url) : '';
      // fallback: try to find URL in text
      var m = text.match(/https?:\/\/\S+/);
      if (!snap && m) { snap = m[0]; }
    
      var relayUrl = (params.relay_url !== undefined && params.relay_url !== null) ? String(params.relay_url).trim() : '';
      var relayKey = (params.relay_key !== undefined && params.relay_key !== null) ? String(params.relay_key).trim() : '';
      if (relayUrl) {
        try {
          var relayReq = new HttpRequest();
          relayReq.addHeader('Content-Type: application/json');
          var relayPayload = {
            token: Telegram.token,
            chat_id: chat,
            text: text,
            snapshot_url: snap,
            map_url: (params.map_url !== undefined && params.map_url !== null) ? String(params.map_url) : '',
            parse_mode: Telegram.parse_mode,
            relay_key: relayKey
          };
          var relayResp = relayReq.post(relayUrl, JSON.stringify(relayPayload));
          var relayCode = relayReq.getStatus();
          if (relayCode >= 200 && relayCode < 300) {
            return 'OK';
          }
          throw 'relay HTTP ' + relayCode + ': ' + relayResp;
        } catch (eRelay) {
          throw 'relay failed: ' + eRelay;
        }
      }

      if (snap && snap.indexOf('http') === 0) {
        // remove url from caption if it was embedded
        if (m) { text = text.replace(m[0], '').replace(/\n{3,}/g, "\n\n").trim(); }
        Telegram.sendPhoto(chat, snap, text);
      } else {
        // Fallback seguro: envia texto quando nao houver snapshot publico.
        Telegram.sendMessage(chat, text || 'Alerta de camera');
      }
    
      return 'OK';
    } catch (e) {
      throw 'Telegram webhook failed: ' + e;
    }
'''
    if not res:
        created = api("mediatype.create", [{
            "name": MEDIA_NAME,
            "type": 4,
            "parameters": [
                {"name": "api_token", "value": token},
                {"name": "api_parse_mode", "value": "HTML"},
                {"name": "sendto", "value": "{ALERT.SENDTO}"},
                {"name": "subject", "value": "{ALERT.SUBJECT}"},
                {"name": "message", "value": "{ALERT.MESSAGE}"},
                {"name": "snapshot_url", "value": "{$CAM_SNAPSHOT_URL}"},
                {"name": "map_url", "value": "{$CAM_MAP_URL}"},
                {"name": "relay_url", "value": TG_RELAY_URL},
                {"name": "relay_key", "value": TG_RELAY_KEY}
            ],
            "script": webhook_script
        }], auth)
        return created["mediatypeids"][0]
    mtid = res[0]["mediatypeid"]
    api("mediatype.update", {
        "mediatypeid": mtid,
        "parameters": [
            {"name": "api_token", "value": token},
            {"name": "api_parse_mode", "value": "HTML"},
            {"name": "sendto", "value": "{ALERT.SENDTO}"},
            {"name": "subject", "value": "{ALERT.SUBJECT}"},
            {"name": "message", "value": "{ALERT.MESSAGE}"},
            {"name": "snapshot_url", "value": "{$CAM_SNAPSHOT_URL}"},
            {"name": "map_url", "value": "{$CAM_MAP_URL}"},
            {"name": "relay_url", "value": TG_RELAY_URL},
            {"name": "relay_key", "value": TG_RELAY_KEY}
        ],
        "script": webhook_script
    }, auth)
    return mtid

def ensure_user_with_media(auth: str, mediatypeid: str, chatid: str) -> str:
    res = api("user.get", {"filter":{"username":[USER_ALIAS]}}, auth)
    roles = api("role.get", {"output": ["roleid", "name"]}, auth)
    roleid = "3"
    for r in (roles or []):
        if str(r.get("name") or "").strip().lower() == "super admin role":
            roleid = str(r.get("roleid") or roleid)
            break

    groups = api("usergroup.get", {"output":["usrgrpid","name"]}, auth)
    usrgrpid = None
    for g in (groups or []):
        if str(g.get("name") or "").strip().lower() == "zabbix administrators":
            usrgrpid = g.get("usrgrpid")
            break
    if not usrgrpid and groups:
        usrgrpid = groups[0]["usrgrpid"]

    user_medias=[{
        "mediatypeid": mediatypeid,
        "sendto": chatid,
        "active": 0,
        "severity": 63,
        "period": "1-7,00:00-24:00"
    }]
    if not res:
        created = api("user.create", [{
            "username": USER_ALIAS,
            "name": "Telegram",
            "surname": "cam-snapshot",
            "passwd": "ChangeMe_12345!",
            "roleid": roleid,
            "timezone": ZBX_TG_TIMEZONE,
            "usrgrps": [{"usrgrpid": usrgrpid}] if usrgrpid else [],
            "medias": user_medias
        }], auth)
        return created["userids"][0]
    uid = res[0]["userid"]
    payload = {
        "userid": uid,
        "roleid": roleid,
        "timezone": ZBX_TG_TIMEZONE,
        "medias": user_medias,
    }
    if usrgrpid:
        payload["usrgrps"] = [{"usrgrpid": usrgrpid}]
    api("user.update", payload, auth)
    return uid

def ensure_action(auth: str, action_name: str, groupid: str, userid: str, mediatypeid: str) -> str:
    res = api("action.get", {"filter":{"name":[action_name]}}, auth)

    # Mensagens (parecidas com as notificações do MikroTik) usando macros de host.
    # As macros {$CAM_TITLE}, {$CAM_LOCAL}, {$CAM_MAC}, {$ONU_SERIAL}, {$PON_ONU} são criadas/atualizadas no host.
    problem_msg = "\n".join([
        "📷 <b>CÂMERA:</b> {$CAM_TITLE}",
        "📍 <b>LOCAL:</b> {$CAM_LOCAL}",
        "💻 <b>MAC:</b> {$CAM_MAC}",
        "🌐 <b>IP:</b> {HOST.IP}",
        "🗺 <b>MAPA:</b> {$CAM_MAP_URL}",
        "❌ <b>STATUS:</b> OFFLINE",
        "🔑 <b>ONU SERIAL:</b> {$ONU_SERIAL}",
        "🧩 <b>PON/ONU:</b> {$PON_ONU}",
        "🕒 <b>EVENTO:</b> {EVENT.DATE} {EVENT.TIME}",
    ])
    recovery_msg = "\n".join([
        "📷 <b>CÂMERA:</b> {$CAM_TITLE}",
        "📍 <b>LOCAL:</b> {$CAM_LOCAL}",
        "💻 <b>MAC:</b> {$CAM_MAC}",
        "🌐 <b>IP:</b> {HOST.IP}",
        "🗺 <b>MAPA:</b> {$CAM_MAP_URL}",
        "✅ <b>STATUS:</b> ONLINE",
        "🔑 <b>ONU SERIAL:</b> {$ONU_SERIAL}",
        "🧩 <b>PON/ONU:</b> {$PON_ONU}",
        "🕒 <b>EVENTO:</b> {EVENT.RECOVERY.DATE} {EVENT.RECOVERY.TIME}",
    ])

    operations=[{
        "operationtype": 0,
        "opmessage": {
            "default_msg": 0,
            "mediatypeid": mediatypeid,
            "message": problem_msg
        },
        "opmessage_usr": [{"userid": userid}]
    }]
    recovery_operations=[{
        "operationtype": 0,
        "opmessage": {
            "default_msg": 0,
            "mediatypeid": mediatypeid,
            "message": recovery_msg
        },
        "opmessage_usr": [{"userid": userid}]
    }]
    params={
        "name": action_name,
        "eventsource": 0,
        "status": 0,
        "esc_period": "1m",
        "filter": {"evaltype": 0, "conditions": [{
            "conditiontype": 0, "operator": 0, "value": groupid
        }]},
        "operations": operations,
        "recovery_operations": recovery_operations
    }
    if not res:
        created = api("action.create", params, auth)
        return created["actionids"][0]
    aid = res[0]["actionid"]
    params["actionid"]=aid
    api("action.update", params, auth)
    return aid


def disable_legacy_actions(auth: str) -> None:
    legacy_names = [ACTION_NAME_LEGACY_IP, ACTION_NAME_LEGACY_DVR]
    for name in legacy_names:
        try:
            res = api("action.get", {"filter": {"name": [name]}, "output": ["actionid", "status"]}, auth)
            for a in (res or []):
                aid = str(a.get("actionid") or "").strip()
                if not aid:
                    continue
                if str(a.get("status")) == "1":
                    continue
                api("action.update", {"actionid": aid, "status": 1}, auth)
        except Exception:
            pass

def main():
    if not ZBX_URL or not ZBX_USER or not ZBX_PASS:
        print("Preencha ZBX_URL, ZBX_USER e ZBX_PASS.", file=sys.stderr)
        sys.exit(2)
    auth=login()
    groupid=ensure_hostgroup(auth, ZBX_GROUP)
    rows=json.load(open(INV_PATH,"r",encoding="utf-8"))
    has_ip_like = any(str((r or {}).get("source") or "").strip().lower() != "dvr" for r in rows if isinstance(r, dict))

    templateid, template_name_used = resolve_base_template_id(auth, ZBX_TEMPLATE)
    if not templateid and has_ip_like:
        raise RuntimeError(
            f"Template base nao encontrado: '{ZBX_TEMPLATE}'. "
            "Informe um template existente no seu Zabbix (ex.: ICMP Ping)."
        )
    if templateid:
        print(f"Template base: {template_name_used}")
    else:
        print("[WARN] Sem template base de ping. Continuando apenas com template DVR para hosts DVR.", file=sys.stderr)
    dvr_templateid = ""
    try:
        dvr_templateid = ensure_dvr_channel_template(auth, ZBX_TEMPLATE_DVR)
    except Exception as e:
        print(f"[WARN] Template DVR nao criado ({e}). Seguindo sem trigger de canal.", file=sys.stderr)

    if TG_AUTO:
        if not TG_TOKEN or not TG_CHAT:
            print("Telegram auto: ignorado (token/chat vazios).")
        else:
            print("Telegram auto: configurando media type + user + action...")
            mtid=ensure_telegram_mediatype(auth, TG_TOKEN, TG_CHAT)
            uid=ensure_user_with_media(auth, mtid, TG_CHAT)
            aid_ip=ensure_action(auth, ACTION_NAME_GROUP, groupid, uid, mtid)
            disable_legacy_actions(auth)
            print(
                f"Telegram auto: OK (mediatypeid={mtid}, userid={uid}, "
                f"action={aid_ip})"
            )

    n=0
    for c in rows:
        ip=(c.get("ip") or "").strip()
        if not ip: 
            continue
        title=(c.get("titulo") or c.get("title") or c.get("nome") or ip).strip()
        local=str(c.get("local") or c.get("location") or c.get("LOCAL") or "").strip()
        mac=str(c.get("mac") or c.get("Mac Address") or c.get("mac_address") or "").strip()
        model=str(c.get("modelo") or c.get("model") or c.get("device_model") or "").strip()
        onu_serial=str(
            c.get("onu_serial") or c.get("onu_sn") or c.get("serial_onu") or c.get("onuSerial") or ""
        ).strip()
        pon=str(c.get("pon") or "").strip()
        map_url = (str(c.get("map_url") or "").strip() or _google_maps_url(c.get("lat"), c.get("lon")))
        # Prefer public URLs so Telegram can render the photo inline.
        cand = [
            str(c.get("imgbb_url") or "").strip(),
            str(c.get("thumb_url") or "").strip(),
            str(c.get("snapshot_url") or "").strip(),
            str(c.get("image_url") or "").strip(),
        ]
        http_first = [u for u in cand if u.lower().startswith(("http://", "https://"))]
        snapshot_url = (http_first[0] if http_first else (cand[0] if cand else ""))
        onu=str(c.get("onu_id") or c.get("onu") or "").strip()
        pon_onu=(f"{pon}/{onu}" if pon and onu else (pon or onu))
        source = str(c.get("source") or "").strip().lower()
        channel = str(c.get("channel") or "").strip()
        http_port = int(c.get("http_port") or 80)
        host_key = str(c.get("host_key") or "").strip()
        if host_key:
            host = host_key
        elif source == "dvr" and channel:
            host = f"DVR-{ip}-CH{channel}"
        else:
            host = f"CAM-{ip}"
        status_raw = str(c.get("status") or "").strip().lower()
        templateids = [templateid]
        if source == "dvr" and dvr_templateid:
            templateids.append(dvr_templateid)
        dvr_http_url = f"http://{ip}:{http_port}" if int(http_port) != 80 else f"http://{ip}"
        try:
            ch_idx = str(max(0, int(channel) - 1))
        except Exception:
            ch_idx = "0"
        try:
            ch_num = str(max(1, int(channel)))
        except Exception:
            ch_num = "1"

        host_groups = [groupid]
        st, hostid = host_upsert(auth, host, title, ip, host_groups, templateids, {
            "{$CAM_IP}": ip,
            "{$CAM_TITLE}": title,
            "{$CAM_LOCAL}": local,
            "{$CAM_MAC}": mac,
            "{$CAM_MODEL}": model,
            "{$ONU_SERIAL}": onu_serial,
            "{$PON_ONU}": pon_onu,
            "{$PON}": pon,
            "{$CAM_SNAPSHOT_URL}": snapshot_url,
            "{$CAM_MAP_URL}": map_url,
            "{$ONU}": onu,
            "{$CAM_STATUS}": status_raw,
            "{$DVR_HTTP_URL}": dvr_http_url,
            "{$DVR_USER}": ZBX_DVR_USER,
            "{$DVR_PASS}": ZBX_DVR_PASS,
            "{$DVR_CH_INDEX}": ch_idx,
            "{$DVR_CH}": ch_num,
        })
        n+=1
        print(f"{st}: {host} ({title})")
    print(f"OK: {n} hosts processados")

if __name__=="__main__":
    main()
