import json
import os
import time
from uuid import uuid4

import redis


REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

COLA_TAREAS = "cola:tareas"
INDICE_TAREAS = "tareas:ids"
INDICE_TAREAS_SET = "tareas:ids:set"

ID_WORKER = os.getenv("ID_WORKER", f"worker-{str(uuid4())[:8]}")

redis_cliente = redis.Redis(
    host=REDIS_HOST,
    port=REDIS_PORT,
    decode_responses=True
)


def guardar_estado_tarea(tarea):
    if redis_cliente.sadd(INDICE_TAREAS_SET, tarea["id_tarea"]):
        redis_cliente.rpush(INDICE_TAREAS, tarea["id_tarea"])

    tarea["actualizado_en"] = time.time()
    clave = f"tarea:{tarea['id_tarea']}"
    redis_cliente.set(clave, json.dumps(tarea, ensure_ascii=False))


def procesar_tarea(tarea):
    tarea["estado"] = "en proceso"
    tarea["progreso"] = 10
    tarea["worker"] = ID_WORKER
    guardar_estado_tarea(tarea)

    print(f"[{ID_WORKER}] procesando: {tarea['nombre']}")

    for progreso in [30, 50, 70, 90]:
        time.sleep(1)
        tarea["progreso"] = progreso
        guardar_estado_tarea(tarea)

    tarea["estado"] = "completada"
    tarea["progreso"] = 100
    tarea["resultado"] = f"Resultado simulado de {tarea['nombre']}"
    tarea["error"] = None
    guardar_estado_tarea(tarea)

    print(f"[{ID_WORKER}] completada: {tarea['nombre']}")


def iniciar_worker():
    print(f"[{ID_WORKER}] worker iniciado")
    print(f"[{ID_WORKER}] esperando tareas en {COLA_TAREAS}")

    while True:
        resultado = redis_cliente.blpop(COLA_TAREAS, timeout=5)

        if resultado is None:
            print(f"[{ID_WORKER}] sin tareas, esperando...")
            continue

        nombre_cola, tarea_json = resultado
        tarea = json.loads(tarea_json)

        try:
            procesar_tarea(tarea)
        except Exception as error:
            tarea["estado"] = "error"
            tarea["error"] = str(error)
            tarea["worker"] = ID_WORKER
            guardar_estado_tarea(tarea)

            print(f"[{ID_WORKER}] error: {error}")


if __name__ == "__main__":
    iniciar_worker()
