from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from uuid import uuid4
import json
import redis
import os
import time

aplicacion = FastAPI(title="AudioLab API")
app = aplicacion

aplicacion.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

redis_cliente = redis.Redis(
    host=REDIS_HOST,
    port=REDIS_PORT,
    decode_responses=True
)

COLA_TAREAS = "cola:tareas"
INDICE_TAREAS = "tareas:ids"
INDICE_TAREAS_SET = "tareas:ids:set"

NOMBRES_PROCESOS = {
    "transcripcion": "Transcripción",
    "lento": "Versión lenta",
    "rapido": "Versión rápida",
    "tono_grave": "Tono grave",
    "tono_agudo": "Tono agudo",
    "onda": "Generar onda",
}


def guardar_tarea(tarea):
    tarea["actualizado_en"] = time.time()
    redis_cliente.set(
        f"tarea:{tarea['id_tarea']}",
        json.dumps(tarea, ensure_ascii=False)
    )


def registrar_tarea(tarea):
    if redis_cliente.sadd(INDICE_TAREAS_SET, tarea["id_tarea"]):
        redis_cliente.rpush(INDICE_TAREAS, tarea["id_tarea"])

    guardar_tarea(tarea)


def cargar_tareas_guardadas():
    ids_tareas = redis_cliente.lrange(INDICE_TAREAS, 0, -1)
    tareas = []
    ids_vistos = set()

    if ids_tareas:
        claves = [f"tarea:{id_tarea}" for id_tarea in ids_tareas]

        for tarea_json in redis_cliente.mget(claves):
            if not tarea_json:
                continue

            tarea = json.loads(tarea_json)
            ids_vistos.add(tarea["id_tarea"])
            tareas.append(tarea)

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

    for tarea_json in redis_cliente.lrange(COLA_TAREAS, 0, -1):
        tarea = json.loads(tarea_json)
        id_tarea = tarea.get("id_tarea")

        if id_tarea in ids_vistos:
            continue

        ids_vistos.add(id_tarea)
        tareas.append(tarea)

    return tareas


@aplicacion.get("/")
async def inicio():
    return {
        "mensaje": "AudioLab API funcionando"
    }


@aplicacion.post("/trabajos")
async def crear_trabajo(
    audio: UploadFile = File(...),
    procesos: str = Form(...)
):
    id_trabajo = str(uuid4())

    procesos_seleccionados = procesos.split(",")

    tareas = []

    for proceso in procesos_seleccionados:
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
        registrar_tarea(tarea)
        redis_cliente.rpush(COLA_TAREAS, json.dumps(tarea, ensure_ascii=False))

    return {
        "id_trabajo": id_trabajo,
        "nombre_archivo": audio.filename,
        "estado": "pendiente",
        "tareas": tareas,
    }


@aplicacion.get("/trabajos")
async def listar_trabajos():
    tareas = cargar_tareas_guardadas()

    return {
        "cantidad": len(tareas),
        "tareas": tareas
    }


@aplicacion.delete("/trabajos")
async def limpiar_trabajos():
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
    tareas_guardadas = redis_cliente.lrange(COLA_TAREAS, 0, -1)

    return {
        "cola": COLA_TAREAS,
        "cantidad": len(tareas_guardadas),
        "tareas": [json.loads(tarea) for tarea in tareas_guardadas]
    }

@aplicacion.get("/debug/redis")
async def probar_redis():
    respuesta = redis_cliente.ping()

    return {
        "redis": "conectado" if respuesta else "sin respuesta"
    }
