# Package: API endpoints (routers)

from .scan import router as scan_router
from .cameras import router as cameras_router
from .live import router as live_router
from .olt import router as olt_router
from .tools import router as tools_router
from .maintenance import router as maintenance_router
from .switch import router as switch_router

from .ws import router as ws_router
from .dvr import router as dvr_router
from .nvr import router as nvr_router
from .ia import router as ia_router
from .database import router as database_router
from .auth import router as auth_router
from .system import router as system_router
from .dashboard import router as dashboard_router
