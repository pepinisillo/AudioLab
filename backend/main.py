from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from uuid import uuid4
import asyncio
import json
import redis
import os
import time
from datetime import datetime, timezone

# API principal: recibe el audio, crea tareas y las deja en Redis para que las tomen los workers.
aplicacion = FastAPI(title="AudioLab API")

# Alias comun para uvicorn/main.py. Mantener ambos nombres evita confusiones al arrancar.
app = aplicacion

# CORS abierto para desarrollo local: permite servir el frontend desde archivo o desde otro puerto.
aplicacion.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# La conexion se puede configurar por variables de entorno si Redis corre en Docker u otra maquina.
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

redis_cliente = redis.Redis(
    host=REDIS_HOST,
    port=REDIS_PORT,
    # Redis devuelve strings en vez de bytes; asi no hay que decodificar en cada lectura.
    decode_responses=True
)

# Lista que funciona como cola real: el worker hace BLPOP y la tarea sale de aqui.
COLA_TAREAS = "cola:tareas"

# Estado de workers y logs escritos por worker.py.
PREFIJO_WORKER = "worker:"
LISTA_LOGS = "logs:sistema"
SEGUNDOS_WORKER_ACTIVO = 15
SEGUNDOS_WORKER_EXPIRA = 45

# Indices para poder seguir mostrando tareas aunque ya hayan salido de la cola.
INDICE_TAREAS = "tareas:ids"
INDICE_TAREAS_SET = "tareas:ids:set"

# Traduccion de nombres tecnicos a etiquetas legibles para la interfaz.
NOMBRES_PROCESOS = {
    "transcripcion": "Transcripción",
    "lento": "Versión lenta",
    "rapido": "Versión rápida",
    "tono_grave": "Tono grave",
    "tono_agudo": "Tono agudo",
    "onda": "Generar onda",
}


def canal_eventos_trabajo(id_trabajo):
    # Debe coincidir con el canal donde publica el worker.
    return f"trabajo:{id_trabajo}:eventos"


def leer_fecha_utc(valor):
    # Los workers guardan fechas ISO en UTC; si algo viene raro, se ignora sin romper la API.
    if not valor:
        return None

    try:
        fecha = datetime.fromisoformat(str(valor).replace("Z", "+00:00"))
    except ValueError:
        return None

    if fecha.tzinfo is None:
        fecha = fecha.replace(tzinfo=timezone.utc)

    return fecha.astimezone(timezone.utc)


def cargar_workers():
    # Lee los hashes worker:<id> que reporta cada worker.
    workers = []
    ahora = datetime.now(timezone.utc)

    for clave in redis_cliente.scan_iter(f"{PREFIJO_WORKER}*"):
        datos = redis_cliente.hgetall(clave)

        if not datos:
            continue

        ultima_vez = leer_fecha_utc(datos.get("ultima_vez"))
        segundos_desde_ultima_vez = None

        if ultima_vez:
            segundos_desde_ultima_vez = (ahora - ultima_vez).total_seconds()

        if (
            segundos_desde_ultima_vez is None
            or segundos_desde_ultima_vez > SEGUNDOS_WORKER_EXPIRA
        ):
            redis_cliente.delete(clave)
            continue

        datos["activo"] = (
            segundos_desde_ultima_vez is not None
            and segundos_desde_ultima_vez <= SEGUNDOS_WORKER_ACTIVO
        )
        datos["segundos_desde_ultima_vez"] = segundos_desde_ultima_vez
        workers.append(datos)

    return sorted(workers, key=lambda worker: worker.get("id", ""))


def cargar_logs(limite=100):
    # Los logs se guardan como JSON en una lista Redis, del mas nuevo al mas viejo.
    limite = max(1, min(int(limite), 100))
    entradas = redis_cliente.lrange(LISTA_LOGS, 0, limite - 1)
    logs = []

    for entrada_json in entradas:
        try:
            logs.append(json.loads(entrada_json))
        except json.JSONDecodeError:
            logs.append({
                "worker": "sistema",
                "mensaje": entrada_json,
                "fecha": None,
            })

    return logs


def guardar_tarea(tarea):
    # Cada tarea vive tambien en su propia clave para consultar progreso e historial.
    tarea["actualizado_en"] = time.time()
    redis_cliente.set(
        f"tarea:{tarea['id_tarea']}",
        json.dumps(tarea, ensure_ascii=False)
    )


def registrar_tarea(tarea):
    # El set evita IDs duplicados; la lista conserva el orden en que se crearon.
    if redis_cliente.sadd(INDICE_TAREAS_SET, tarea["id_tarea"]):
        redis_cliente.rpush(INDICE_TAREAS, tarea["id_tarea"])

    guardar_tarea(tarea)


def cargar_tareas_guardadas():
    # Fuente principal para la UI: todas las tareas conocidas, no solo las pendientes en cola.
    ids_tareas = redis_cliente.lrange(INDICE_TAREAS, 0, -1)
    tareas = []
    ids_vistos = set()

    if ids_tareas:
        # mget lee muchas tareas en una sola llamada a Redis.
        claves = [f"tarea:{id_tarea}" for id_tarea in ids_tareas]

        for tarea_json in redis_cliente.mget(claves):
            if not tarea_json:
                continue

            tarea = json.loads(tarea_json)
            ids_vistos.add(tarea["id_tarea"])
            tareas.append(tarea)

    # Respaldo para tareas que existan como tarea:* pero no esten en el indice.
    for clave in redis_cliente.scan_iter("tarea:*"):
        tarea_json = redis_cliente.get(clave)

        if not tarea_json:
            continue

        tarea = json.loads(tarea_json)
        id_tarea = tarea.get("id_tarea")

        if id_tarea in ids_vistos:
            continue

        ids_vistos.add(id_tarea)
        tareas.append(tarea)

    # Compatibilidad: si hay tareas antiguas solo en la cola, tambien se muestran.
    for tarea_json in redis_cliente.lrange(COLA_TAREAS, 0, -1):
        tarea = json.loads(tarea_json)
        id_tarea = tarea.get("id_tarea")

        if id_tarea in ids_vistos:
            continue

        ids_vistos.add(id_tarea)
        tareas.append(tarea)

    return tareas


def calcular_estado_trabajo(tareas):
    # El estado del trabajo se resume desde sus tareas: primero lo activo, luego pendientes/errores.
    estados = [
        str(tarea.get("estado", "pendiente")).strip().lower()
        for tarea in tareas
    ]

    if any(estado in ("en proceso", "en_proceso", "running") for estado in estados):
        return "en proceso"

    if any(estado in ("pendiente", "pending") for estado in estados):
        return "pendiente"

    if "error" in estados:
        return "error"

    return "completada"


def formatear_evento_sse(nombre_evento, datos):
    # Formato SSE: cada evento termina con una linea vacia para que EventSource lo entregue.
    return (
        f"event: {nombre_evento}\n"
        f"data: {json.dumps(datos, ensure_ascii=False)}\n\n"
    )


@aplicacion.get("/")
async def inicio():
    # Endpoint rapido para saber si FastAPI esta vivo.
    return {
        "mensaje": "AudioLab API funcionando"
    }


@aplicacion.post("/trabajos")
async def crear_trabajo(
    audio: UploadFile = File(...),
    procesos: str = Form(...)
):
    # Un trabajo representa un archivo; cada proceso elegido se convierte en una tarea.
    id_trabajo = str(uuid4())

    procesos_seleccionados = procesos.split(",")

    tareas = []

    for proceso in procesos_seleccionados:
        # Esta estructura es el contrato que comparten backend, worker y frontend.
        tarea = {
            "id_tarea": str(uuid4()),
            "id_trabajo": id_trabajo,
            "nombre_archivo": audio.filename,
            "proceso": proceso,
            "nombre": NOMBRES_PROCESOS.get(proceso, proceso),
            "estado": "pendiente",
            "progreso": 0,
            "worker": None,
            "resultado": None,
            "error": None,
            "creado_en": time.time(),
            "actualizado_en": None,
        }

        tareas.append(tarea)

        # Guardar primero permite que la UI vea la tarea aunque el worker la saque rapido de la cola.
        registrar_tarea(tarea)

        # Esta es la entrada que consumen los workers con BLPOP.
        redis_cliente.rpush(COLA_TAREAS, json.dumps(tarea, ensure_ascii=False))

    return {
        "id_trabajo": id_trabajo,
        "nombre_archivo": audio.filename,
        "estado": "pendiente",
        "tareas": tareas,
    }


@aplicacion.get("/trabajos")
async def listar_trabajos():
    # Devuelve lo que la pantalla llama "Trabajo actual".
    tareas = cargar_tareas_guardadas()

    return {
        "cantidad": len(tareas),
        "tareas": tareas
    }


@aplicacion.get("/workers")
async def listar_workers():
    # Estado actual de los workers reportado en Redis.
    workers = cargar_workers()
    activos = [worker for worker in workers if worker.get("activo")]

    return {
        "cantidad": len(workers),
        "activos": len(activos),
        "workers": workers
    }


@aplicacion.get("/logs")
async def listar_logs(limite: int = 100):
    # Ultimos eventos escritos por los workers en logs:sistema.
    logs = cargar_logs(limite)

    return {
        "cantidad": len(logs),
        "logs": logs
    }


@aplicacion.delete("/logs")
async def limpiar_logs():
    # Limpia los registros de workers; no toca tareas ni estados de trabajo.
    eliminados = redis_cliente.delete(LISTA_LOGS)

    return {
        "eliminados": eliminados
    }


@aplicacion.get("/trabajos/{id_trabajo}")
async def obtener_trabajo(id_trabajo: str):
    # Consulta enfocada: misma fuente que /trabajos, pero filtrada por un solo id_trabajo.
    tareas = [
        tarea
        for tarea in cargar_tareas_guardadas()
        if tarea.get("id_trabajo") == id_trabajo
    ]

    if not tareas:
        return {
            "id_trabajo": id_trabajo,
            "estado": "no encontrado",
            "cantidad": 0,
            "tareas": []
        }

    return {
        "id_trabajo": id_trabajo,
        "nombre_archivo": tareas[0].get("nombre_archivo"),
        "estado": calcular_estado_trabajo(tareas),
        "cantidad": len(tareas),
        "tareas": tareas
    }


@aplicacion.get("/trabajos/{id_trabajo}/eventos")
async def eventos_trabajo(id_trabajo: str, request: Request):
    # SSE mantiene una respuesta abierta; Redis Pub/Sub entrega los cambios que publica el worker.
    canal = canal_eventos_trabajo(id_trabajo)

    async def generar_eventos():
        pubsub = redis_cliente.pubsub()
        pubsub.subscribe(canal)

        try:
            yield formatear_evento_sse("conexion", {
                "tipo": "conexion",
                "id_trabajo": id_trabajo,
                "canal": canal,
            })

            while True:
                if await request.is_disconnected():
                    break

                mensaje = await asyncio.to_thread(
                    pubsub.get_message,
                    ignore_subscribe_messages=True,
                    timeout=1.0
                )

                if mensaje and mensaje.get("type") == "message":
                    yield (
                        "event: tarea_actualizada\n"
                        f"data: {mensaje.get('data')}\n\n"
                    )
                    continue

                # Keep-alive para que proxies/navegadores no cierren una conexion quieta.
                yield ": esperando eventos\n\n"
                await asyncio.sleep(0.1)
        finally:
            pubsub.unsubscribe(canal)
            pubsub.close()

    return StreamingResponse(
        generar_eventos(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


@aplicacion.delete("/trabajos")
async def limpiar_trabajos():
    # Limpieza del trabajo actual: borra tareas persistidas, indices y pendientes de cola.
    tareas = cargar_tareas_guardadas()
    claves_tareas = [
        f"tarea:{tarea['id_tarea']}"
        for tarea in tareas
        if tarea.get("id_tarea")
    ]

    if claves_tareas:
        redis_cliente.delete(*claves_tareas)

    redis_cliente.delete(INDICE_TAREAS, INDICE_TAREAS_SET, COLA_TAREAS)

    return {
        "eliminadas": len(claves_tareas)
    }


@app.get("/debug/cola")
async def ver_cola():
    # Debug puntual: muestra solo lo que sigue pendiente dentro de la cola Redis.
    tareas_guardadas = redis_cliente.lrange(COLA_TAREAS, 0, -1)

    return {
        "cola": COLA_TAREAS,
        "cantidad": len(tareas_guardadas),
        "tareas": [json.loads(tarea) for tarea in tareas_guardadas]
    }

@aplicacion.get("/debug/redis")
async def probar_redis():
    # Ping simple para confirmar conexion con Redis.
    respuesta = redis_cliente.ping()

    return {
        "redis": "conectado" if respuesta else "sin respuesta"
    }
