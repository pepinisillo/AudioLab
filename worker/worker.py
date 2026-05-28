import json
import os
import time
from uuid import uuid4

import redis


REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

COLA_TAREAS = "cola:tareas"

ID_PROCESADOR = os.getenv("ID_PROCESADOR", f"procesador-{str(uuid4())[:8]}")

redis_cliente = redis.Redis(
    host=REDIS_HOST,
    port=REDIS_PORT,
    decode_responses=True
)


def guardar_estado_tarea(tarea):
    clave = f"tarea:{tarea['id_tarea']}"
    redis_cliente.set(clave, json.dumps(tarea, ensure_ascii=False))


def procesar_tarea(tarea):
    tarea["estado"] = "en proceso"
    tarea["procesador"] = ID_PROCESADOR
    guardar_estado_tarea(tarea)

    print(f"[{ID_PROCESADOR}] procesando: {tarea['nombre']}")

    time.sleep(4)

    tarea["estado"] = "completada"
    tarea["resultado"] = f"Resultado simulado de {tarea['nombre']}"
    tarea["error"] = None
    guardar_estado_tarea(tarea)

    print(f"[{ID_PROCESADOR}] completada: {tarea['nombre']}")


def iniciar_worker():
    print(f"[{ID_PROCESADOR}] worker iniciado")
    print(f"[{ID_PROCESADOR}] esperando tareas en {COLA_TAREAS}")

    while True:
        resultado = redis_cliente.blpop(COLA_TAREAS, timeout=5)

        if resultado is None:
            print(f"[{ID_PROCESADOR}] sin tareas, esperando...")
            continue

        nombre_cola, tarea_json = resultado
        tarea = json.loads(tarea_json)

        try:
            procesar_tarea(tarea)
        except Exception as error:
            tarea["estado"] = "error"
            tarea["error"] = str(error)
            tarea["procesador"] = ID_PROCESADOR
            guardar_estado_tarea(tarea)

            print(f"[{ID_PROCESADOR}] error: {error}")


if __name__ == "__main__":
    iniciar_worker()