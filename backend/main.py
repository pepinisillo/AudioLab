from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from uuid import uuid4
import json
import redis
import os

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

NOMBRES_PROCESOS = {
    "transcripcion": "Transcripción",
    "lento": "Versión lenta",
    "rapido": "Versión rápida",
    "tono_grave": "Tono grave",
    "tono_agudo": "Tono agudo",
    "onda": "Generar onda",
}


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
            "proceso": proceso,
            "nombre": NOMBRES_PROCESOS.get(proceso, proceso),
            "estado": "pendiente",
            "procesador": None,
            "resultado": None,
            "error": None,
        }

        tareas.append(tarea)
        redis_cliente.rpush(COLA_TAREAS, json.dumps(tarea, ensure_ascii=False))

    return {
        "id_trabajo": id_trabajo,
        "nombre_archivo": audio.filename,
        "estado": "pendiente",
        "tareas": tareas,
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